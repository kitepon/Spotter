import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { version } from '../version.mjs';
import { readOwnerPrivateFile, writeOwnerPrivateFile } from '../platform/owner-private-file.mjs';
import {
  acknowledgeRuntimeErrors,
  defaultRuntimeErrorStorePath,
  readRuntimeErrorSnapshot,
  readRuntimeErrorStoreStatus,
} from './runtime-error-store.mjs';
import { readRuntimeReportConfig, readRuntimeReportCredential } from './runtime-report-config.mjs';

const MAX_BODY_BYTES = 512 * 1024;
const FIELDS = [
  'fingerprint', 'error_code', 'component', 'message_template', 'severity', 'status',
  'occurrence_count', 'first_seen', 'last_seen', 'product_version', 'state_schema_version',
];

export function signRuntimeReport(secret, ts, bodyBytes) {
  const digest = createHash('sha256').update(bodyBytes).digest('hex');
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${ts}\n${digest}`).digest('hex');
}

export function signRuntimeReportReceipt(secret, reportId, receivedAt) {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${reportId}\n${receivedAt}`).digest('hex');
}

function verifiedReceipt(value, reportId, secret) {
  if (!value || value.accepted !== true || value.report_id !== reportId
    || typeof value.received_at !== 'string' || typeof value.sig !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sig)) return false;
  const expected = signRuntimeReportReceipt(secret, reportId, value.received_at);
  return timingSafeEqual(Buffer.from(value.sig, 'hex'), Buffer.from(expected, 'hex'));
}

function project(record) {
  const item = Object.fromEntries(FIELDS.filter((field) => record[field] !== undefined)
    .map((field) => [field, record[field]]));
  const resolution = record.status === 'resolved'
    ? { fingerprint: record.fingerprint, resolved_at: record.resolved_at, reason_code: record.reason_code }
    : null;
  return { item, resolution };
}

function blockPath(storeOptions) {
  return join(dirname(storeOptions.storePath ?? defaultRuntimeErrorStorePath(storeOptions)), 'runtime-report-blocked-v1.json');
}

function credentialBlockPath(storeOptions) {
  return join(dirname(storeOptions.storePath ?? defaultRuntimeErrorStorePath(storeOptions)), 'runtime-report-credential-blocked-v1.json');
}

function credentialTag(credential) {
  return createHash('sha256').update(`${credential.key_id}\n${credential.secret}`, 'utf8').digest('hex');
}

async function readBlockedCredential(storeOptions) {
  try {
    const value = JSON.parse(await readOwnerPrivateFile(credentialBlockPath(storeOptions), storeOptions));
    return value?.schema === 'spotter.runtime_report_credential_block.v1' && /^[a-f0-9]{64}$/.test(value.tag)
      ? value.tag : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeBlockedCredential(storeOptions, tag) {
  await writeOwnerPrivateFile(
    credentialBlockPath(storeOptions),
    JSON.stringify({ schema: 'spotter.runtime_report_credential_block.v1', tag }),
    storeOptions,
  );
}

async function responseCode(response) {
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > 16_384) return null;
    const value = JSON.parse(raw);
    return typeof value.code === 'string' ? value.code
      : typeof value.error === 'string' ? value.error
        : typeof value.error?.code === 'string' ? value.error.code : null;
  } catch { return null; }
}

async function readBlockedVersion(storeOptions) {
  try {
    const value = JSON.parse(await readOwnerPrivateFile(blockPath(storeOptions), storeOptions));
    return value?.schema === 'spotter.runtime_report_block.v1' && typeof value.version === 'string'
      ? value.version : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeBlockedVersion(storeOptions, installedVersion) {
  await writeOwnerPrivateFile(
    blockPath(storeOptions),
    JSON.stringify({ schema: 'spotter.runtime_report_block.v1', version: installedVersion }),
    storeOptions,
  );
}

export async function reportRuntimeErrors(options = {}) {
  const config = await (options.readConfig ?? readRuntimeReportConfig)(options);
  if (config.state !== 'valid' || !config.collectionEnabled || !config.reportingEnabled) {
    return { status: 'disabled', reason: config.state };
  }
  const storeOptions = options.storeOptions ?? {};
  const status = await (options.readStatus ?? readRuntimeErrorStoreStatus)(storeOptions);
  if (status.store === 'unavailable') return { status: 'store_unavailable' };
  if (status.unacknowledged === 0) return { status: 'nothing_to_report' };
  const snapshot = await (options.readSnapshot ?? readRuntimeErrorSnapshot)({
    ...storeOptions, afterCursor: status.acknowledged_through, limit: 500,
  });
  if (snapshot.collection !== 'enabled' || snapshot.records.length === 0) {
    return { status: 'nothing_to_report' };
  }
  const installedVersion = options.installedVersion ?? version;
  if (await (options.readBlockedVersion ?? readBlockedVersion)(storeOptions) === installedVersion) {
    return { status: 'invalid_report_blocked' };
  }
  const credential = await (options.readCredential ?? readRuntimeReportCredential)(options);
  const tag = credentialTag(credential);
  if (await (options.readBlockedCredential ?? readBlockedCredential)(storeOptions) === tag) {
    return { status: 'credential_rejected_blocked' };
  }
  const at = new Date(options.nowMs ?? Date.now());
  const ts = String(Math.floor(at.getTime() / 1000));
  const reportId = (options.uuid ?? randomUUID)();
  const payload = {
    schema_version: '1.0', report_id: reportId, product_id: 'spotter',
    installed_version: installedVersion,
    observed_at: at.toISOString(), runtime_errors: [], resolutions: [],
  };
  let cursor = status.acknowledged_through;
  let body;
  for (const record of snapshot.records) {
    const { item, resolution } = project(record);
    payload.runtime_errors.push(item);
    if (resolution) payload.resolutions.push(resolution);
    const candidate = Buffer.from(JSON.stringify(payload), 'utf8');
    if (candidate.length > MAX_BODY_BYTES) {
      payload.runtime_errors.pop();
      if (resolution) payload.resolutions.pop();
      if (cursor === status.acknowledged_through) return { status: 'record_too_large' };
      break;
    }
    body = candidate;
    cursor = record.sequence;
  }
  const sig = signRuntimeReport(credential.secret, ts, body);
  let response;
  try {
    response = await (options.fetchFn ?? fetch)(credential.url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `BugHub-HMAC-SHA256 key_id=${credential.key_id}, ts=${ts}, sig=${sig}`,
      },
    });
  } catch {
    return { status: 'unconfirmed', count: payload.runtime_errors.length };
  }
  if (response.status === 401 && await responseCode(response) === 'timestamp_skew') {
    return { status: 'clock_skew' };
  }
  if (response.status === 401 || response.status === 403) {
    await (options.writeBlockedCredential ?? writeBlockedCredential)(storeOptions, tag);
    return { status: 'credential_rejected' };
  }
  if (response.status === 422 && await responseCode(response) === 'observed_at_skew') {
    return { status: 'clock_skew' };
  }
  if (response.status === 422) {
    await (options.writeBlockedVersion ?? writeBlockedVersion)(storeOptions, installedVersion);
    return { status: 'invalid_report', count: payload.runtime_errors.length };
  }
  if (response.status !== 200) return { status: 'unconfirmed', httpStatus: response.status, count: payload.runtime_errors.length };
  let receipt;
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > 16_384) throw new Error('oversized receipt');
    receipt = JSON.parse(raw);
  } catch {
    return { status: 'unconfirmed', count: payload.runtime_errors.length };
  }
  if (!verifiedReceipt(receipt, reportId, credential.secret)) {
    return { status: 'unconfirmed', count: payload.runtime_errors.length };
  }
  const ack = await (options.acknowledge ?? acknowledgeRuntimeErrors)({ cursor }, storeOptions);
  return { status: ack.acknowledged ? 'accepted' : 'ack_failed', count: payload.runtime_errors.length, cursor };
}
