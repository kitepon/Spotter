// 測定結果を一つの閲覧用成果物へまとめる。実catalogの説明本文は公開物へ含めない。
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const paths = process.argv.slice(2);
if (paths.length !== 4) throw new Error('選別・質問比較・独立確認・実catalogの4結果を指定してください');
const [selection, questions, challenge, real] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
if ([selection, questions, challenge, real].some(report => report.status !== 'complete')) throw new Error('未完了の比較は公開できません');
const digest = value => createHash('sha256').update(value).digest('hex');
const caseView = (item, catalog) => {
  const { catalog: privateCatalog, ...safe } = item;
  const actual = privateCatalog ?? catalog;
  return { ...safe, catalogSize: actual.length, catalogSha256: digest(JSON.stringify(actual)) };
};
const sourceFile = await readFile(new URL('./jev-selection-candidates.mjs', import.meta.url), 'utf8');
const report = {
  schema: 'spotter.selection-experiment.v1', status: 'complete', completedAt: new Date().toISOString(), model: selection.model,
  baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  candidateSourceSha256: digest(sourceFile),
  decision: '候補方式は採用しない。確率の足切りと再比較は改善せず、短い質問＋Noulは制御ケースを改善したが、独立確認で重複提案が残った。現行の判定を維持する。',
  scope: '固定した日本語ケースの判定実験。親AIの行動改善・実運用の有用性・公式Hermes例との優劣は測っていない。入力tokenは処理量であり請求額ではない。',
  threshold: selection.threshold, thresholdScores: selection.thresholdScores,
  groups: [
    { title: '1. 現行判定の確率と候補再比較', note: '16ケース×3回。閾値は開発8ケースで選び、残る8ケースで確認。選ばれた閾値は0.5で、現行の選択集合は変わらなかった。再比較は提案が2件以上の時だけ実行。確率足切りは同じ応答の再集計なのでAPIの追加呼出しはない。',
      cases: selection.fixtures.cases.map(item => caseView(item, selection.fixtures.catalog)),
      rows: selection.rows.flatMap(row => ['baseline', 'thresholded', 'verified'].map(variant => {
        const result = variant === 'baseline' ? row : row[variant];
        return { id: row.id, category: row.category, split: row.split, round: row.round, variant, expected: row.expected, selected: result.selected, probabilities: row.probabilities,
          exact: result.exact, falsePositives: result.falsePositives, falseNegatives: result.falseNegatives,
          inputTokens: row.inputTokens + (variant === 'verified' ? row.verified.inputTokens : 0),
          outputTokens: row.outputTokens + (variant === 'verified' ? row.verified.outputTokens : 0),
          durationMs: row.durationMs + (variant === 'verified' ? row.verified.durationMs : 0),
          calls: 1 + (variant === 'verified' ? row.verified.calls : 0) };
      })) },
    ...[[questions, '2. 質問文と判定形式の切り分け', '前段で使用した16ケース×3回。同じ短い質問をChoiceとNoulで比較。Noulの採否は0.5超。既知ケースなので、この結果だけを採用根拠にしない。'],
      [challenge, '3. 独立した確認ケース', '候補の質問を固定後に追加した10ケース×3回。この結果で質問を調整していない。完全に同じ機能の検索ツールは、どちらか1件だけ選べば正解。'],
      [real, '4. 実catalogでの挙動', 'Claude 133候補・Codex 83候補、各4入力×2回。期待値は明示した主要操作だけ。期待外の提案には補助操作も含まれるため、不適切との判定ではない。完全一致数を実運用の精度と解釈しない。実catalogの本文は公開せず、候補数とSHAだけ記録。']].map(([data, title, note]) => ({ title, note,
        cases: data.fixtures.cases.map(item => caseView(item, data.fixtures.catalog)),
        rows: data === real ? data.rows.map(row => ({ ...row,
          probabilities: Object.fromEntries(Object.entries(row.probabilities).filter(([name]) => row.selected.includes(name) || row.expected.includes(name))),
        })) : data.rows })),
  ],
};
await writeFile(new URL('../src/dashboard/experiments/jev-selection-2026-09-21.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('比較成果物を作成しました');
