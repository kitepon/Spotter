import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOwnerPrivateFile } from '../platform/owner-private-file.mjs';

export const BUGHUB_RUNTIME_ERROR_URL = 'http://192.168.1.2:39310/api/products/v1/runtime-errors';

export function defaultRuntimeReportConfigPath({ env = process.env, platform = process.platform, homeDir = homedir() } = {}) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || homeDir, 'Spotter', 'runtime-errors-config.json');
  return join(env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'spotter', 'runtime-errors.json');
}

export function defaultRuntimeReportCredentialPath({ env = process.env, platform = process.platform, homeDir = homedir() } = {}) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || homeDir, 'bughub', 'product-credentials', 'spotter.json');
  return join(homeDir, '.config', 'bughub', 'product-credentials', 'spotter.json');
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

export async function readRuntimeReportCredential(options = {}) {
  const path = options.credentialPath ?? defaultRuntimeReportCredentialPath(options);
  const value = JSON.parse(await readOwnerPrivateFile(path, options));
  if (!exactKeys(value, ['url', 'key_id', 'secret'])
    || value.url !== BUGHUB_RUNTIME_ERROR_URL
    || typeof value.key_id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value.key_id)
    || typeof value.secret !== 'string' || value.secret.length < 1 || value.secret.length > 512) {
    throw new Error('invalid runtime report credential');
  }
  return value;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
