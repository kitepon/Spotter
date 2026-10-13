// self-hosted runnerでも、実運用の認証・設定・状態をテストへ持ち込まない。
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shortTemporaryRoot } from '../src/platform/paths.mjs';

// 試験を探す範囲は、このscriptが属するリポジトリの中だけにする。node --test は引数をそのまま
// 探す型として読む。空の引数は「今のフォルダ」になって型が `/**/*.test.js` へ書き換わり、
// フォルダや `/`、親フォルダも、その下の試験を全部集める。どれも何も起動しないうちに断る。
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

// 値を次の引数で受けるオプション。その値は試験ファイルとして扱わない。
// ここに無いオプションへ値を渡す時は `--name=value` と書く。
const OPTIONS_WITH_VALUE = new Set([
  '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern',
  '--test-concurrency', '--test-timeout', '--test-shard', '--test-isolation',
  '--test-coverage-include', '--test-coverage-exclude', '--test-global-setup',
  '--import', '--require', '-r',
]);

function refuse(message) {
  console.error(`${message}\n試験は実行していません。`);
  process.exit(2);
}

// 試験ファイルの引数を、リポジトリの中の実在するファイルの絶対パスにして返す。
function testFile(argument, position, realRoot) {
  const path = resolve(argument);
  let real;
  try {
    real = realpathSync(path);
  } catch {
    refuse(`テスト引数の${position}番目は実在するファイルではありません: ${argument}`);
  }
  if (!statSync(real).isFile()) refuse(`テスト引数の${position}番目はファイルではありません（フォルダは渡せません）: ${argument}`);
  const inside = relative(realRoot, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    refuse(`テスト引数の${position}番目はこのリポジトリの外を指しています: ${argument}`);
  }
  return path;
}

function checkedArguments(argumentsGiven) {
  const blankAt = argumentsGiven.findIndex((argument) => argument.trim() === '');
  if (blankAt !== -1) refuse(`テスト引数の${blankAt + 1}番目が空です。node --test は空の引数でファイルシステムのルートから試験を探します。`);
  const realRoot = realpathSync(repositoryRoot);
  const checked = [];
  let optionsEnded = false;
  for (let index = 0; index < argumentsGiven.length; index += 1) {
    const argument = argumentsGiven[index];
    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
      checked.push(argument);
    } else if (!optionsEnded && argument.startsWith('-')) {
      checked.push(argument);
      if (OPTIONS_WITH_VALUE.has(argument)) {
        index += 1;
        if (index === argumentsGiven.length) refuse(`${argument} に値がありません。`);
        checked.push(argumentsGiven[index]);
      }
    } else {
      checked.push(testFile(argument, index + 1, realRoot));
    }
  }
  return checked;
}

const testArguments = checkedArguments(process.argv.slice(2));

// 試験へ渡す環境は、この一覧の名前だけで作る。呼び手の環境をそのまま渡さない。
// 鍵やトークン、ハーネスやほかの道具の設定・状態の置き場（CODEX_HOME、GROK_HOME、XDG_CONFIG_HOME、
// GH_CONFIG_DIR、GIT_CONFIG_GLOBAL など）は一覧に無いので、試験からは一時 home の下の既定の場所だけが見える。
const PASSED_THROUGH = new Set([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'NODE_OPTIONS',
  // Windowsがprocessの起動に使う名前。
  'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'OS',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMMONPROGRAMFILES',
]);
// 本物のハーネスの代わりにPATHの先頭へ置く名前。呼ばれても何も起動せず、127で返す。
const HARNESS_NAMES = ['claude', 'codex', 'grok', 'cursor-agent', 'cursor'];

const home = mkdtempSync(join(shortTemporaryRoot(), 's'));
try {
  const harnessDirectory = join(home, 'harness');
  mkdirSync(harnessDirectory);
  for (const name of HARNESS_NAMES) {
    if (process.platform === 'win32') {
      writeFileSync(join(harnessDirectory, `${name}.cmd`), `@echo ${name}: not available while tests run 1>&2\r\n@exit /b 127\r\n`);
    } else {
      writeFileSync(join(harnessDirectory, name), `#!/bin/sh\necho "${name}: not available while tests run" >&2\nexit 127\n`);
      chmodSync(join(harnessDirectory, name), 0o755);
    }
  }

  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (PASSED_THROUGH.has(name.toUpperCase())) env[name] = value;
  }
  const pathName = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathName] = [harnessDirectory, env[pathName]].filter(Boolean).join(delimiter);
  env.HOME = home;
  env.USERPROFILE = home;
  if (process.platform === 'win32') {
    env.APPDATA = join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(home, 'AppData', 'Local');
    for (const directory of [env.APPDATA, env.LOCALAPPDATA]) mkdirSync(directory, { recursive: true });
  }

  // 引数なしの時にnodeが試験を探す起点。呼び手がどこに居ても、このリポジトリに固定する。
  const result = spawnSync(process.execPath, ['--test', ...testArguments], { cwd: repositoryRoot, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) console.error(`テストがsignal ${result.signal}で終了しました`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
