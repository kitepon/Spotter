import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { dirname, join } from 'node:path';
import { version } from '../version.mjs';
import { readOwnerPrivateFile, writeOwnerPrivateFile } from '../platform/owner-private-file.mjs';
import {
  acknowledgeRuntimeErrors,
  defaultRuntimeErrorStorePath,
  readRuntimeErrorSnapshot,
  readRuntimeErrorStoreStatus,
} from './runtime-error-store.mjs';
import { runWithStdinFile } from '../platform/spawn.mjs';
import {
  BUGHUB_RESPONSE_KEY, BUGHUB_RUNTIME_ERROR_URL, readRuntimeReportConfig, readRuntimeReportSigner,
} from './runtime-report-config.mjs';

const MAX_BODY_BYTES = 512 * 1024;
const FIELDS = [
  'fingerprint', 'error_code', 'component', 'message_template', 'severity', 'status',
  'occurrence_count', 'first_seen', 'last_seen', 'product_version', 'state_schema_version',
];

const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/; // ES256 の生の r‖s（64 byte）の base64

export function signCommand({ sign }) {
  return sign.kind === 'auth'
    ? { command: sign.command, args: ['sign', sign.item], cwd: sign.cwd }
    : {
      command: sign.command,
      args: ['-T', '-i', sign.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${sign.known_hosts}`, sign.target],
    };
}

// 鍵は認証仲介の中にだけある。署名 command の stdout は署名だけで、終了 0 かつ形が合う時だけ使う。
export async function signRuntimeReportText(signer, text, run = runWithStdinFile) {
  const { command, args, cwd } = signCommand(signer);
  const { code, stdout } = await run(command, args, { stdinText: text, cwd });
  const sig = stdout.trim();
  if (code !== 0 || !SIGNATURE.test(sig)) throw new Error('runtime report signing failed');
  return sig;
}

export function verifiedReceipt(value, reportId, responseKey = BUGHUB_RESPONSE_KEY) {
  if (!value || value.accepted !== true || value.report_id !== reportId
    || typeof value.received_at !== 'string' || value.sig_alg !== 'ES256' || !SIGNATURE.test(value.sig)) return false;
  try {
    return verify('sha256', Buffer.from(`${reportId}\n${value.received_at}`, 'utf8'),
      { key: createPublicKey(responseKey), dsaEncoding: 'ieee-p1363' }, Buffer.from(value.sig, 'base64'));
  } catch { return false; }
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

function credentialTag(signer) {
  return createHash('sha256').update(signer.key_id, 'utf8').digest('hex');
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
  const signer = await (options.readSigner ?? readRuntimeReportSigner)(options);
  const tag = credentialTag(signer);
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
  for (const record of snapshot.records.slice(0, 500)) {
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
  let sig;
  try {
    const digest = createHash('sha256').update(body).digest('hex');
    sig = await (options.sign ?? signRuntimeReportText)(signer, `${ts}\n${digest}`);
  } catch {
    return { status: 'sign_failed' };
  }
  let response;
  try {
    response = await (options.fetchFn ?? fetch)(BUGHUB_RUNTIME_ERROR_URL, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000), body,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `BugHub-ES256 key_id=${signer.key_id}, ts=${ts}, sig=${sig}`,
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
  if (!verifiedReceipt(receipt, reportId, options.responseKey)) {
    return { status: 'unconfirmed', count: payload.runtime_errors.length };
  }
  const ack = await (options.acknowledge ?? acknowledgeRuntimeErrors)({ cursor }, storeOptions);
  return { status: ack.acknowledged ? 'accepted' : 'ack_failed', count: payload.runtime_errors.length, cursor };
}
