import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('systemd report service starts Node by absolute path instead of the spotter env shebang', async () => {
  const service = await read('ops/runtime-reporting/spotter-runtime-errors.service');
  assert.match(
    service,
    /^ExecStart=REPLACE_WITH_ABSOLUTE_NODE_PATH REPLACE_WITH_ABSOLUTE_SPOTTER_SCRIPT_PATH runtime-errors report$/mu,
  );
});

test('launchd report agent starts Node by absolute path instead of the spotter env shebang', async () => {
  const plist = await read('ops/runtime-reporting/dev.spotter.runtime-errors.plist');
  const args = [...plist.matchAll(/<string>([^<]+)<\/string>/gu)].map((match) => match[1]);
  assert.deepEqual(args, [
    'dev.spotter.runtime-errors',
    'REPLACE_WITH_ABSOLUTE_NODE_PATH',
    'REPLACE_WITH_ABSOLUTE_SPOTTER_SCRIPT_PATH',
    'runtime-errors',
    'report',
  ]);
});

test('Windows report task keeps the user profile, runs hourly, and hides its console window', async () => {
  const installer = await read('ops/runtime-reporting/windows/install-runtime-errors-task.ps1');
  const runner = await read('ops/runtime-reporting/windows/spotter-runtime-errors.ps1');
  assert.match(installer, /-UserId \$env:USERNAME -LogonType Interactive/);
  assert.match(installer, /-RepetitionInterval \(New-TimeSpan -Hours 1\)/);
  const actions = installer.match(/New-ScheduledTaskAction[^\r\n]+/gu) ?? [];
  assert.equal(actions.length, 1);
  assert.match(actions[0], /-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass/);
  assert.match(actions[0], /spotter-runtime-errors\.ps1/);
  assert.match(runner, /runtime-errors report/);
  assert.match(runner, /exit \$LASTEXITCODE/);
});
