// self-hosted runnerでも、実運用の認証・設定・状態をテストへ持ち込まない。
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { shortTemporaryRoot } from '../src/platform/paths.mjs';

const home = mkdtempSync(join(shortTemporaryRoot(), 's'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.TYPESAFE_API_KEY;
delete env.SPOTTER_JEV_ENV_FILE;
try {
  const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) console.error(`テストがsignal ${result.signal}で終了しました`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
