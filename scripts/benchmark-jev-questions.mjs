import { readFile, writeFile } from 'node:fs/promises';
import { createJevAuditorBackend, JEV_MODEL, resolveJevApiKey } from '../src/core/jev-backend.mjs';
import { compactQuestions } from './jev-selection-candidates.mjs';
const fixtures = JSON.parse(await readFile(process.argv[2] ?? new URL('../test/fixtures/jev-selection.v1.json', import.meta.url), 'utf8'));
const output = process.argv[3] ?? '/tmp/spotter-jev-questions.json';
const repeat = Number(process.argv[4] ?? 3);
const key = resolveJevApiKey();
if (!key || !Number.isSafeInteger(repeat) || repeat < 1) throw new Error('認証または反復数が不正です');
const report = { schema: 'spotter.jev-question-report.v1', status: 'running', startedAt: new Date().toISOString(), model: JEV_MODEL, repeat, fixtures, rows: [] };
try {
  for (let round = 0; round < repeat; round++) for (const item of fixtures.cases) {
    // 方式の実行順を交替し、時間帯・接続の片寄りを減らす。
    const variants = ['baseline', 'compact-choice', 'compact-noul'];
    if (round % 2) variants.reverse();
    for (const variant of variants) {
      const catalog = item.catalog ?? fixtures.catalog;
      const candidates = catalog.filter(tool => !(item.input.usedTools ?? []).includes(tool.name));
      let selected, probabilities, durationMs, usage;
      if (variant === 'baseline') {
        let raw;
        const judgment = await createJevAuditorBackend({ catalog, fetchFn: async (...args) => {
          const response = await fetch(...args);
          if (response.ok) raw = await response.clone().json();
          return response;
        } }).judge(item.input);
        selected = judgment.findings.map(f => f.toolName);
        probabilities = Object.fromEntries(candidates.map((tool, i) => [tool.name, raw.answers[`tool_${i}`].noul]));
        durationMs = judgment.meta.durationMs;
        usage = judgment.meta.diagnostics.tokenUsage;
      } else {
        const kind = variant === 'compact-noul' ? 'noul' : 'choice';
        const started = performance.now();
        const response = await fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST', signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: JEV_MODEL, state: { stage: item.input.stage, text: item.input.userInput ?? item.input.finalResponse }, questions: compactQuestions(candidates, item.input.stage, kind) }),
        });
        if (!response.ok) throw new Error(`比較API: HTTP ${response.status}`);
        const body = await response.json();
        if (body.model !== JEV_MODEL) throw new Error('比較API: model不一致');
        durationMs = performance.now() - started;
        probabilities = Object.fromEntries(candidates.map((tool, i) => {
          const answer = body.answers?.[`tool_${i}`];
          const value = kind === 'noul' ? answer?.noul : answer?.probabilities?.propose;
          if (answer?.type !== kind || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('比較API: 不正な確率');
          return [tool.name, value];
        }));
        selected = candidates.filter((tool, i) => kind === 'noul' ? probabilities[tool.name] > 0.5 : body.answers[`tool_${i}`].choice === 'propose').map(tool => tool.name);
        usage = { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens };
      }
      const acceptable = item.acceptableSets ?? [item.expected];
      const scored = acceptable.map(expected => ({ expected, falsePositives: selected.filter(name => !expected.includes(name)), falseNegatives: expected.filter(name => !selected.includes(name)) }));
      const best = scored.sort((a, b) => a.falsePositives.length + a.falseNegatives.length - b.falsePositives.length - b.falseNegatives.length)[0];
      const row = { id: item.id, category: item.category, split: item.split, round, variant, selected, probabilities, ...best, exact: !best.falsePositives.length && !best.falseNegatives.length, durationMs, ...usage };
      report.rows.push(row);
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(`${round + 1}/${repeat} ${item.id} ${variant}: ${row.exact ? '一致' : '不一致'}`);
    }
  }
  report.status = 'complete';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`比較${report.status}: ${output}`);
}
