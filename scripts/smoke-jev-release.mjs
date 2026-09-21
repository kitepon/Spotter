// 製品backendを固定ケースで3反復×2回測り、全判定を既存dashboardへ掲載する。
import { readFile, writeFile } from 'node:fs/promises';
import { createJevAuditorBackend, JEV_MODEL } from '../src/core/jev-backend.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const fixturePaths = ['jev-selection.v1.json', 'jev-selection-challenge.v1.json'];
const fixtures = await Promise.all(fixturePaths.map(name => readFile(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8').then(JSON.parse)));
const cases = fixtures.flatMap(f => f.cases.map(c => ({ ...c, catalog: c.catalog ?? f.catalog })));
const output = process.argv[2];
if (!output) throw new Error('公開成果物の出力先を指定してください');
const source = await readFile(new URL('../src/core/jev-backend.mjs', import.meta.url));
const report = {
  schema: 'spotter.selection-experiment.v1', status: 'failed', model: JEV_MODEL,
  baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  decision: '短い質問＋Noulを採用する。同機能ツールの重複提案は親AIが選別できるため許容し、取りこぼし削減を優先する。',
  scope: '本番backendの公開前確認。26種類の固定入力を3反復×2回。親AIの実際の行動や害は測っていない。基準commitに対する変更後のsource SHAを併記する。',
  groups: [],
};
try {
  for (let run = 0; run < 2; run++) {
    const group = { title: `公開前確認 ${run + 1}/2`, note: '肯定確率0.5超を提案。期待外・欠落の内容を個別に確認し、完全一致100%を採用条件にしない。', cases, rows: [] };
    report.groups.push(group);
    for (let round = 0; round < 3; round++) for (const item of cases) {
      const judgment = await createJevAuditorBackend({ catalog: item.catalog }).judge(item.input);
      const selected = judgment.findings.map(f => f.toolName);
      const scored = (item.acceptableSets ?? [item.expected]).map(expected => ({ expected,
        falsePositives: selected.filter(name => !expected.includes(name)),
        falseNegatives: expected.filter(name => !selected.includes(name)),
      })).sort((a, b) => a.falsePositives.length + a.falseNegatives.length - b.falsePositives.length - b.falseNegatives.length);
      const best = scored[0];
      group.rows.push({ id: item.id, category: item.category, split: item.split, round, variant: 'compact-noul', selected, ...best,
        exact: !best.falsePositives.length && !best.falseNegatives.length,
        durationMs: judgment.meta.durationMs, ...judgment.meta.diagnostics.tokenUsage });
    }
    const times = group.rows.map(row => row.durationMs).sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    console.log(JSON.stringify({ run: run + 1, count: group.rows.length, exact: group.rows.filter(row => row.exact).length, p95,
      mismatches: group.rows.filter(row => !row.exact).map(({ id, falsePositives, falseNegatives }) => ({ id, falsePositives, falseNegatives })) }));
    if (p95 > 10000) throw new Error('p95が公開基準10秒を超えました');
  }
  report.status = 'complete';
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
