import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { readOwnerPrivateFile } from '../platform/owner-private-file.mjs';

export const BUGHUB_RUNTIME_ERROR_URL = 'http://192.168.1.2:39310/api/products/v1/runtime-errors';

export function defaultRuntimeReportConfigPath({ env = process.env, platform = process.platform, homeDir = homedir() } = {}) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || homeDir, 'Spotter', 'runtime-errors-config.json');
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'spotter', 'runtime-errors.json');
}

// BugHub の応答署名の公開鍵（BugHub-ES256、2026-11-28）。鍵が替わる時は版を替えて配る。
export const BUGHUB_RESPONSE_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEX+kilvDhn190l4Z+iR5J4KusmOSJ
ZVBQjMaLGOshDFzUwB7IxiJsgLMpQzOdoEWM21DCBpL1QyY1COU2cmuE1g==
-----END PUBLIC KEY-----`;

export function defaultRuntimeReportSignerPath({ env = process.env, platform = process.platform, homeDir = homedir() } = {}) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || homeDir, 'Spotter', 'bughub-sign.json');
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'spotter', 'bughub-sign.json');
}

export async function readRuntimeReportConfig(options = {}) {
  const path = options.productConfigPath ?? defaultRuntimeReportConfigPath(options);
  let raw;
  try { raw = await readOwnerPrivateFile(path, options); }
  catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', collectionEnabled: false, reportingEnabled: false };
    return { state: 'malformed', collectionEnabled: false, reportingEnabled: false };
  }
  try {
    const value = JSON.parse(raw);
    if (!exactKeys(value, ['schema_version', 'collection', 'reporting'])
      || value.schema_version !== '1.0'
      || !exactKeys(value.collection, ['enabled']) || typeof value.collection.enabled !== 'boolean'
      || !exactKeys(value.reporting, ['enabled']) || typeof value.reporting.enabled !== 'boolean') {
      throw new Error('invalid config');
    }
    return {
      state: 'valid',
      collectionEnabled: value.collection.enabled,
      reportingEnabled: value.reporting.enabled,
    };
  } catch {
    return { state: 'malformed', collectionEnabled: false, reportingEnabled: false };
  }
}

const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIGN_ITEM = /^bughub-product-spotter-[a-z0-9][a-z0-9-]{0,63}$/;
const SSH_TARGET = /^[a-z][a-z0-9_-]{0,31}@[0-9A-Za-z.-]{1,253}$/;
const absolutePath = (value) => typeof value === 'string' && /^[^\0\r\n]{1,512}$/.test(value)
  && (isAbsolute(value) || win32.isAbsolute(value));

// 署名設定は秘密を持たない。鍵は認証仲介の中にだけあり、端末には key_id と署名 command の種類だけが置かれる。
export async function readRuntimeReportSigner(options = {}) {
  const path = options.signerPath ?? defaultRuntimeReportSignerPath(options);
  const value = JSON.parse(await readOwnerPrivateFile(path, options));
  const { sign } = value ?? {};
  const shaped = exactKeys(value, ['schema_version', 'key_id', 'sign']) && value.schema_version === '1.0'
    && typeof value.key_id === 'string' && KEY_ID.test(value.key_id)
    && (sign?.kind === 'auth'
      ? exactKeys(sign, ['kind', 'command', 'item', 'cwd']) && absolutePath(sign.command) && absolutePath(sign.cwd)
        && typeof sign.item === 'string' && SIGN_ITEM.test(sign.item)
      : sign?.kind === 'ssh'
        && exactKeys(sign, ['kind', 'command', 'key', 'known_hosts', 'target']) && absolutePath(sign.command)
        && absolutePath(sign.key) && absolutePath(sign.known_hosts)
        && typeof sign.target === 'string' && SSH_TARGET.test(sign.target));
  if (!shaped) throw new Error('invalid runtime report signer');
  return value;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
