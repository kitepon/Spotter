import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadExperimentReports, renderExperiments, summarizeExperiment } from '../src/dashboard/experiments.mjs';
import { createDeviceServer } from '../src/dashboard/device-server.mjs';

test('全成果物を目録から読み、集計・失敗例を同じ公開ページに表示する', async t => {
  const reports = loadExperimentReports();
  assert.ok(reports.length > 0);
  const html = renderExperiments({ deviceId: 'mac', reports });
  for (const { report } of reports) for (const group of report.groups) {
    const summaries = summarizeExperiment(group.rows);
    assert.equal(summaries.reduce((n, s) => n + s.count, 0), group.rows.length);
    for (const row of group.rows) assert.ok(html.includes(row.id));
  }
  const injected = structuredClone(reports);
  injected[0].report.groups[0].cases[0].input.userInput = '<script>alert(1)</script>';
  const escaped = renderExperiments({ deviceId: 'mac', reports: injected });
  assert.ok(escaped.includes('&lt;script&gt;'));
  assert.ok(!escaped.includes('<script>'));
  const server = createDeviceServer({ deviceId: 'mac', createStoreFn: () => assert.fail('比較に運用DBは不要') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/devices/mac/experiments/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /測定完了/);
});

test('未掲載の成果物と未対応schemaはtyped errorで検出する', () => {
  const path = mkdtempSync(join(tmpdir(), 'spotter-experiments-'));
  const directory = pathToFileURL(path + '/');
  try {
    writeFileSync(join(path, 'index.json'), '[]');
    writeFileSync(join(path, 'missing.json'), '{}');
    assert.throws(() => loadExperimentReports(directory), { code: 'E_EXPERIMENT_SCHEMA' });
    writeFileSync(join(path, 'index.json'), '[{"file":"missing.json"}]');
    assert.throws(() => loadExperimentReports(directory), { code: 'E_EXPERIMENT_SCHEMA' });
  } finally { rmSync(path, { recursive: true }); }
});
