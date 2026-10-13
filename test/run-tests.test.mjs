// scripts/run-tests.mjs の試験。ランナーの写しを一時フォルダの小さなリポジトリへ置いて動かす。
// 断る場合と、引数・環境の検査は、何も起動できない状態で動かす（試験が外れても node --test は起きず、
// 起きようとした事が記録に残る）。本物の node --test を起こすのは最後の3件だけで、探す範囲は
// その小さなリポジトリと、隣に置いた1ファイルだけのフォルダに限る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WINDOWS = process.platform === 'win32';
const HARNESS_NAMES = ['claude', 'codex', 'grok', 'cursor-agent', 'cursor'];

// 先に読み込ませる差し替え。プログラムの起動とフォルダの一覧を行わず、呼ばれた事だけを記録する。
// test/ の下の .mjs は試験として拾われるので、ファイルにせず試験ごとの一時フォルダへ書く。
const PRELOAD = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';

const logPath = process.env.SPOTTER_TEST_CALL_LOG;
if (!logPath) throw new Error('SPOTTER_TEST_CALL_LOG is required');
const appendFileSync = fs.appendFileSync;
const record = (name, args) => {
  const options = args.find((value) => value && typeof value === 'object' && !Array.isArray(value));
  appendFileSync(logPath, JSON.stringify({
    name,
    args: args.filter((value) => typeof value === 'string' || Array.isArray(value)),
    cwd: options?.cwd,
    env: options?.env,
  }) + '\\n');
};

const finished = { pid: 0, status: 0, signal: null, output: [null, '', ''], stdout: '', stderr: '' };
for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
  childProcess[name] = (...args) => { record(name, args); return name === 'spawnSync' ? { ...finished } : ''; };
}
for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
  childProcess[name] = (...args) => { record(name, args); throw new Error(name + ' is not available under this preload'); };
}
// 呼び手は mkdtempSync の返した場所を消す。推測できる場所ではなく、記録の隣を返す。
fs.mkdtempSync = (...args) => {
  record('mkdtempSync', args);
  const directory = join(dirname(logPath), 'recorded-mkdtemp');
  fs.mkdirSync(directory);
  return directory;
};
for (const name of ['readdirSync', 'opendirSync', 'globSync']) {
  fs[name] = (...args) => { record(name, args); return []; };
}
for (const name of ['readdir', 'opendir', 'glob']) {
  fs[name] = (...args) => { record(name, args); throw new Error(name + ' is not available under this preload'); };
  fs.promises[name] = async (...args) => { record(name, args); throw new Error(name + ' is not available under this preload'); };
}
syncBuiltinESMExports();
`;

// 走ったら自分の名前を印のフォルダへ書く試験。どの試験ファイルが実行されたかを後で読む。
const markerTest = (name, markers) => `
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test(${JSON.stringify(name)}, () => { writeFileSync(${JSON.stringify(path.join(markers, name))}, ''); });
`;

// 一時フォルダに、ランナーの写しを持つ小さなリポジトリと、その外の物を作る。
//   repository/scripts/run-tests.mjs, src/platform/paths.mjs   ランナーの写し
//   repository/test/sample.test.mjs, test/nested/              中の試験とフォルダ
//   outside/other.test.mjs                                     リポジトリの外の試験
function withRepository(body) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'spotter-run-tests-')));
  try {
    const repository = path.join(base, 'repository');
    const outside = path.join(base, 'outside');
    const markers = path.join(base, 'markers');
    for (const directory of [
      path.join(repository, 'scripts'), path.join(repository, 'src', 'platform'), path.join(repository, 'test', 'nested'),
      outside, markers, path.join(base, 'log'),
    ]) mkdirSync(directory, { recursive: true });
    copyFileSync(path.join(sourceRoot, 'scripts', 'run-tests.mjs'), path.join(repository, 'scripts', 'run-tests.mjs'));
    copyFileSync(path.join(sourceRoot, 'src', 'platform', 'paths.mjs'), path.join(repository, 'src', 'platform', 'paths.mjs'));
    writeFileSync(path.join(repository, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(path.join(repository, 'test', 'sample.test.mjs'), markerTest('sample', markers));
    writeFileSync(path.join(outside, 'other.test.mjs'), markerTest('other', markers));
    writeFileSync(path.join(base, 'preload.mjs'), PRELOAD);
    return body({
      base, repository, outside, markers,
      runner: path.join(repository, 'scripts', 'run-tests.mjs'),
      sample: path.join(repository, 'test', 'sample.test.mjs'),
      log: path.join(base, 'log', 'calls.log'),
      home: path.join(base, 'log', 'recorded-mkdtemp'),
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// 何も起動できない状態でランナーを動かし、起きようとした事の記録を返す。
function runRecorded(repo, args, { cwd = repo.repository, callerEnv = {} } = {}) {
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(repo.base, 'preload.mjs')).href, repo.runner, ...args], {
    cwd,
    env: { ...process.env, ...callerEnv, SPOTTER_TEST_CALL_LOG: repo.log },
    encoding: 'utf8',
  });
  const calls = existsSync(repo.log)
    ? readFileSync(repo.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  return { status: result.status, stderr: result.stderr, calls };
}

function assertRefused(repo, args, message, options) {
  const { status, stderr, calls } = runRecorded(repo, args, options);
  assert.equal(status, 2, stderr);
  assert.match(stderr, message);
  assert.match(stderr, /試験は実行していません。/u);
  assert.deepEqual(calls, [], '起動・一時フォルダ・フォルダの一覧のどれも起きない');
}

function assertStarted(repo, args, expected, options) {
  const { status, stderr, calls } = runRecorded(repo, args, options);
  assert.equal(status, 0, stderr);
  assert.deepEqual(calls.map((call) => call.name), ['mkdtempSync', 'spawnSync']);
  const started = calls[1];
  assert.deepEqual(started.args, [process.execPath, ['--test', ...expected]]);
  assert.equal(realpathSync(started.cwd), repo.repository, '試験を探す起点はリポジトリ');
  return started;
}

// symlinkを作れない環境（権限の無いWindows）では、その試験を飛ばす。
function link(t, target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('この環境ではsymlinkを作れない');
    return false;
  }
}

for (const [label, args, position] of [
  ['空文字', [''], 1],
  ['空白だけ', ['   '], 1],
  ['タブと改行だけ', ['\t\n'], 1],
  ['ファイル名の後ろの空文字', ['test/sample.test.mjs', ''], 2],
  ['オプションの後ろの空文字', ['--test-reporter=tap', ''], 2],
]) {
  test(`${label}のテスト引数は、何も起動せず何も探さずに断る`, () => withRepository((repo) => {
    assertRefused(repo, args, new RegExp(`テスト引数の${position}番目が空です`, 'u'));
  }));
}

for (const [label, pick, message] of [
  ['ファイルシステムのルート', (repo) => [path.parse(repo.repository).root], /ファイルではありません|リポジトリの外/u],
  ['親フォルダ', () => ['..'], /ファイルではありません/u],
  ['今のフォルダ', () => ['.'], /ファイルではありません/u],
  ['リポジトリのルートの絶対パス', (repo) => [repo.repository], /ファイルではありません/u],
  ['リポジトリの中のフォルダ', () => ['test'], /ファイルではありません/u],
  ['末尾に区切りの付いたフォルダ', () => [`test${path.sep}`], /ファイルではありません/u],
  ['リポジトリの外のファイル（絶対パス）', (repo) => [path.join(repo.outside, 'other.test.mjs')], /リポジトリの外を指しています/u],
  ['リポジトリの外のファイル（親をたどる相対パス）', () => [path.join('..', 'outside', 'other.test.mjs')], /リポジトリの外を指しています/u],
  ['無いファイル', () => ['test/missing.test.mjs'], /実在するファイルではありません/u],
  ['型（glob）', () => ['test/*.test.mjs'], /実在するファイルではありません/u],
  ['中のファイルの後ろに付いたルート', (repo) => ['test/sample.test.mjs', path.parse(repo.repository).root], /テスト引数の2番目/u],
  ['-- の後ろのルート', (repo) => ['--', path.parse(repo.repository).root], /テスト引数の2番目/u],
  ['値を取らないオプションの後ろのフォルダ', () => ['--test-only', 'test'], /テスト引数の2番目はファイルではありません/u],
]) {
  test(`${label}を指すテスト引数は、何も起動せず何も探さずに断る`, () => withRepository((repo) => {
    assertRefused(repo, pick(repo), message);
  }));
}

test('リポジトリの外のファイルを指すsymlinkは断る', (t) => withRepository((repo) => {
  if (!link(t, path.join(repo.outside, 'other.test.mjs'), path.join(repo.repository, 'test', 'escape.test.mjs'), 'file')) return;
  assertRefused(repo, ['test/escape.test.mjs'], /リポジトリの外を指しています/u);
}));

test('リポジトリの外のフォルダを指すsymlinkを通ったファイルは断る', (t) => withRepository((repo) => {
  if (!link(t, repo.outside, path.join(repo.repository, 'linked'), 'dir')) return;
  assertRefused(repo, ['linked/other.test.mjs'], /リポジトリの外を指しています/u);
  rmSync(repo.log, { force: true });
  assertRefused(repo, ['linked'], /ファイルではありません/u);
}));

test('値の無いオプションは断る', () => withRepository((repo) => {
  assertRefused(repo, ['test/sample.test.mjs', '--test-reporter'], /--test-reporter に値がありません/u);
}));

test('引数なしは、呼び手がどこに居ても、リポジトリを起点に全体の試験を起動する', () => withRepository((repo) => {
  assertStarted(repo, [], [], { cwd: repo.outside });
}));

test('リポジトリの中のファイルは、絶対パスにして node --test へ渡す', () => withRepository((repo) => {
  assertStarted(repo, ['test/sample.test.mjs'], [repo.sample]);
}));

test('相対パスは呼び手の今のフォルダから読む', () => withRepository((repo) => {
  assertStarted(repo, ['sample.test.mjs'], [repo.sample], { cwd: path.join(repo.repository, 'test') });
  rmSync(repo.log);
  assertStarted(repo, [path.join('..', 'repository', 'test', 'sample.test.mjs')], [repo.sample], { cwd: repo.outside });
}));

test('リポジトリの中を指すsymlinkは通す', (t) => withRepository((repo) => {
  const linked = path.join(repo.repository, 'test', 'linked.test.mjs');
  if (!link(t, repo.sample, linked, 'file')) return;
  assertStarted(repo, ['test/linked.test.mjs'], [linked]);
}));

// オプションの値は試験ファイルとして読まない。値がフォルダの名前や `/` と同じ綴りでも、そのまま渡す。
for (const [label, args, expected] of [
  ['= でつないだ値', ['--test-reporter=tap', '--test-name-pattern=/', 'test/sample.test.mjs'], (repo) => ['--test-reporter=tap', '--test-name-pattern=/', repo.sample]],
  ['次の引数で渡した値', ['--test-reporter', 'tap', 'test/sample.test.mjs'], (repo) => ['--test-reporter', 'tap', repo.sample]],
  ['フォルダと同じ綴りの値', ['--test-name-pattern', 'test', 'test/sample.test.mjs'], (repo) => ['--test-name-pattern', 'test', repo.sample]],
  ['ルートと同じ綴りの値', ['--test-name-pattern', '/', '--test-skip-pattern', '..'], () => ['--test-name-pattern', '/', '--test-skip-pattern', '..']],
  ['出力先のファイル名', ['--test-reporter', 'tap', '--test-reporter-destination', 'result.tap'], () => ['--test-reporter', 'tap', '--test-reporter-destination', 'result.tap']],
  ['値を取らないオプションだけ', ['--test-only'], () => ['--test-only']],
  ['-- の後ろのファイル', ['--test-reporter=tap', '--', 'test/sample.test.mjs'], (repo) => ['--test-reporter=tap', '--', repo.sample]],
]) {
  test(`オプションはそのまま渡す：${label}`, () => withRepository((repo) => {
    assertStarted(repo, args, expected(repo));
  }));
}

// 呼び手の席が持っている物に似せた名前と値。どれも試験へ届いてはいけない。
function operationalDummies(directory) {
  return {
    BELLTEAM_BUGHUB_KEY: 'dummy-not-a-credential',
    CLAUDE_CODE_MESSAGING_TOKEN: 'dummy-not-a-credential',
    TYPESAFE_API_KEY: 'dummy-not-a-credential',
    SPOTTER_JEV_ENV_FILE: path.join(directory, 'jev.env'),
    BELLTEAM_ROOT: path.join(directory, 'bellteam'),
    BELLTEAM_HOME: path.join(directory, 'bellteam-home'),
    AITERM_STATE_BASE: path.join(directory, 'aiterm-state'),
    AITERM_AGENT_LAUNCH_ID: 'dummy-launch-id',
    CODEX_HOME: path.join(directory, 'codex-home'),
    GROK_HOME: path.join(directory, 'grok-home'),
    CLAUDE_CONFIG_DIR: path.join(directory, 'claude-config'),
    XDG_CONFIG_HOME: path.join(directory, 'xdg-config'),
    GH_CONFIG_DIR: path.join(directory, 'gh-config'),
    GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'),
    CLAUDECODE: '1',
    CODEX_SESSION_ID: 'dummy-session',
    CI: 'true',
  };
}
const ALLOWED_NAMES = new Set([
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'NODE_OPTIONS', 'HOME', 'USERPROFILE',
  'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'OS',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'APPDATA', 'LOCALAPPDATA',
]);
const pathName = (env) => Object.keys(env).find((name) => name.toUpperCase() === 'PATH');

test('試験へ渡す環境は一覧の名前だけで、呼び手の鍵・トークン・設定や状態の置き場を含まない', () => withRepository((repo) => {
  const dummies = operationalDummies(path.join(repo.base, 'caller'));
  const { env } = assertStarted(repo, [], [], { callerEnv: dummies });
  assert.deepEqual(Object.keys(env).filter((name) => !ALLOWED_NAMES.has(name.toUpperCase())), []);
  for (const [name, value] of Object.entries(dummies)) {
    assert.equal(env[name], undefined, `${name} が試験へ渡った`);
    // 短い値（'1' や 'true'）はほかの値の一部として現れるので、名前だけで見る。
    if (value.length > 8) assert.ok(!JSON.stringify(env).includes(JSON.stringify(value).slice(1, -1)), `${name} の値が試験へ渡った`);
  }
  assert.equal(env.HOME, repo.home);
  assert.equal(env.USERPROFILE, repo.home);
  if (WINDOWS) {
    assert.equal(env.APPDATA, path.join(repo.home, 'AppData', 'Roaming'));
    assert.equal(env.LOCALAPPDATA, path.join(repo.home, 'AppData', 'Local'));
  }
  assert.equal(env[pathName(env)].split(path.delimiter)[0], path.join(repo.home, 'harness'));
}));

// ここからは本物の node --test を起こす。探す範囲は一時フォルダの小さなリポジトリだけ。
function runReal(repo, args, { cwd = repo.repository, callerEnv = process.env } = {}) {
  const result = spawnSync(process.execPath, [repo.runner, ...args], { cwd, env: callerEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test('引数なしで起こすと、呼び手が外のフォルダに居ても、リポジトリの中の試験だけが走る', () => withRepository((repo) => {
  runReal(repo, [], { cwd: repo.outside });
  assert.equal(existsSync(path.join(repo.markers, 'sample')), true, 'リポジトリの中の試験が走っていない');
  assert.equal(existsSync(path.join(repo.markers, 'other')), false, '呼び手のフォルダの試験が走った');
}));

// 呼び手の環境にダミーの鍵・置き場と「本物の役」のハーネスを置き、試験の中から見える物を書き出させる。
function runProbe(body) {
  return withRepository((repo) => {
    // 呼び手の席の「本物」の役。呼ばれたら印を書く。試験からは届かないはず。
    const realBin = path.join(repo.base, 'real-bin');
    const called = path.join(repo.base, 'real-harness-called.log');
    mkdirSync(realBin);
    for (const name of HARNESS_NAMES) {
      if (WINDOWS) {
        writeFileSync(path.join(realBin, `${name}.cmd`), `@echo ${name}>>"${called}"\r\n@exit /b 0\r\n`);
      } else {
        writeFileSync(path.join(realBin, name), `#!/bin/sh\necho ${name} >> "${called}"\nexit 0\n`);
        chmodSync(path.join(realBin, name), 0o755);
      }
    }
    const dummies = operationalDummies(path.join(repo.base, 'caller'));
    // 置き場のダミーには、本番の認証に似せたファイルを置く。試験にはその場所を知る手がかりが無いはず。
    for (const name of ['CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'AITERM_STATE_BASE']) {
      mkdirSync(dummies[name], { recursive: true });
      writeFileSync(path.join(dummies[name], 'auth.json'), '{"dummy":"production-auth-stand-in"}\n');
    }
    const out = path.join(repo.base, 'seen.json');
    writeFileSync(path.join(repo.repository, 'test', 'probe.test.mjs'), `
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
test('probe', () => {
  const harness = Object.fromEntries(${JSON.stringify(HARNESS_NAMES)}.map((name) => {
    const result = spawnSync(name, ['--version'], { shell: true, encoding: 'utf8' });
    return [name, { status: result.status, stderr: result.stderr.trim() }];
  }));
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, homedir: homedir(), cwd: process.cwd(), harness }));
});
`);
    const callerHome = path.join(repo.base, 'caller', 'home');
    const callerEnv = { ...process.env, ...dummies, HOME: callerHome, USERPROFILE: callerHome };
    callerEnv[pathName(callerEnv)] = [realBin, callerEnv[pathName(callerEnv)]].join(path.delimiter);
    runReal(repo, ['test/probe.test.mjs'], { callerEnv });
    return body({ seen: JSON.parse(readFileSync(out, 'utf8')), dummies, repo, callerHome, realHarnessCalled: existsSync(called) });
  });
}

test('試験のprocessには、呼び手の鍵・トークン・設定や状態の置き場が届かない', () => runProbe(({ seen, dummies, repo, callerHome }) => {
  const added = new Set(['NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', '__CF_USER_TEXT_ENCODING']);
  assert.deepEqual(Object.keys(seen.env).filter((name) => !ALLOWED_NAMES.has(name.toUpperCase()) && !added.has(name)), []);
  for (const name of Object.keys(dummies)) assert.equal(seen.env[name], undefined, `${name} が試験へ届いた`);
  // 値としても届いていない。呼び手のPATHは引き継ぐので、そこだけ除いて見る。
  const { [pathName(seen.env)]: ignored, ...rest } = seen.env;
  assert.ok(!JSON.stringify(rest).includes(JSON.stringify(path.join(repo.base, 'caller')).slice(1, -1)), '呼び手の置き場が試験の環境に残っている');
  assert.notEqual(seen.env.HOME, callerHome);
  assert.equal(seen.homedir, seen.env.HOME);
  assert.equal(existsSync(seen.env.HOME), false, '一時homeは試験の後に消える');
  assert.equal(realpathSync(seen.cwd), repo.repository);
}));

test('試験からハーネスの名前で呼ぶと、本物ではなく127で返す偽物に当たる', () => runProbe(({ seen, realHarnessCalled }) => {
  for (const [name, result] of Object.entries(seen.harness)) {
    assert.equal(result.status, 127, `${name}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${name}: not available while tests run`));
  }
  assert.equal(realHarnessCalled, false, '呼び手のPATHにある本物の役が呼ばれた');
}));
