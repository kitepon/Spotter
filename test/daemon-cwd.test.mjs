import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { leaveSessionCwd } from '../src/cli/daemon-cmd.mjs';
import { pidFilePath } from '../src/daemon/daemon.mjs';
import { sendRequest } from '../src/daemon/transport.mjs';
import { shortTemporaryRoot } from '../src/platform/paths.mjs';

const BIN = resolve('bin', 'spotter.mjs');
const SPOTTER_HOME = join(homedir(), '.spotter');

test('leaveSessionCwd: moves to the target directory', () => {
  const calls = [];
  const logs = [];
  const moved = leaveSessionCwd({
    target: '/state',
    chdir: (dir) => calls.push(dir),
    log: (line) => logs.push(line),
  });
  assert.equal(moved, true);
  assert.deepEqual(calls, ['/state']);
  assert.deepEqual(logs, []);
});

test('leaveSessionCwd: a failed move is logged and does not throw', () => {
  const logs = [];
  const moved = leaveSessionCwd({
    target: '/missing',
    chdir: () => {
      throw new Error('ENOENT: no such directory');
    },
    log: (line) => logs.push(line),
  });
  assert.equal(moved, false);
  assert.deepEqual(logs, ['cwd release failed (target=/missing): ENOENT: no such directory']);
});

async function waitReady(sessionId, child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited early with code ${child.exitCode}`);
    try {
      const resp = await sendRequest({ sessionId, event: 'readiness', timeoutMs: 500 });
      if (resp.ok === true && resp.result?.ready === true) return;
    } catch {
      // still booting
    }
    await delay(100);
  }
  throw new Error('daemon did not reach readiness within 10s');
}

// Windows refuses to remove a directory that a live process holds as cwd. The hook
// starts the daemon from the session's cwd, so the daemon must not stay there.
test('daemon start: releases the session cwd while the daemon is still running', async () => {
  await mkdir(join(SPOTTER_HOME, 'logs'), { recursive: true });
  const projectRoot = await mkdtemp(join(shortTemporaryRoot(), 'spotter-cwd-'));
  const sessionCwd = join(projectRoot, 'session');
  await mkdir(sessionCwd);
  const sessionId = `cwd-${randomUUID()}`;

  const child = spawn(
    process.execPath,
    [BIN, 'daemon', 'start', '--session-id', sessionId, '--project-root', projectRoot],
    {
      cwd: sessionCwd,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, SPOTTER_AUDITOR_BACKEND: 'haiku', NODE_NO_WARNINGS: '1' },
    }
  );
  const exited = once(child, 'exit');
  try {
    await waitReady(sessionId, child);

    if (process.platform === 'linux') {
      const pid = (await readFile(pidFilePath(sessionId), 'utf8')).trim();
      assert.equal(await readlink(`/proc/${pid}/cwd`), await realpath(SPOTTER_HOME));
    }
    await rmdir(sessionCwd);

    const log = await readFile(join(SPOTTER_HOME, 'logs', `daemon-${sessionId}.log`), 'utf8');
    assert.ok(!log.includes('cwd release failed'), log);
    assert.ok(log.includes(`(project=${projectRoot})`), log);
  } finally {
    await sendRequest({ sessionId, event: 'shutdown', timeoutMs: 2_000 }).catch(() => child.kill());
    await exited;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
