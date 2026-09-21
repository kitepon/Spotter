import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { escapeHtml as escape } from './render.mjs';

const DIRECTORY = new URL('./experiments/', import.meta.url);

function invalid(message) {
  return Object.assign(new Error(message), { code: 'E_EXPERIMENT_SCHEMA' });
}

// 目録にない成果物や描画できないschemaを、公開前の検証で検出する。
export function loadExperimentReports(directory = DIRECTORY) {
  const entries = JSON.parse(readFileSync(new URL('index.json', directory), 'utf8'));
  const files = readdirSync(fileURLToPath(directory)).filter(name => name.endsWith('.json') && name !== 'index.json').sort();
  if (!Array.isArray(entries) || new Set(entries.map(entry => entry.file)).size !== entries.length
      || JSON.stringify(entries.map(entry => entry.file).sort()) !== JSON.stringify(files)) throw invalid('比較結果の目録と成果物が一致しません');
  return entries.map(entry => {
    const report = JSON.parse(readFileSync(new URL(entry.file, directory), 'utf8'));
    if (report.schema !== 'spotter.selection-experiment.v1' || !['complete', 'failed'].includes(report.status)
        || !Array.isArray(report.groups) || !report.groups.every(group => Array.isArray(group.rows) && Array.isArray(group.cases))) {
      throw invalid(`描画できない比較結果です: ${entry.file}`);
    }
    return { ...entry, report };
  });
}

export function summarizeExperiment(rows) {
  return [...new Set(rows.map(row => row.variant))].map(variant => {
    const selected = rows.filter(row => row.variant === variant);
    const times = selected.map(row => row.durationMs).sort((a, b) => a - b);
    return { variant, count: selected.length, exact: selected.filter(row => row.exact).length,
      fp: selected.reduce((n, row) => n + row.falsePositives.length, 0),
      fn: selected.reduce((n, row) => n + row.falseNegatives.length, 0),
      inputTokens: selected.reduce((n, row) => n + row.inputTokens, 0),
      outputTokens: selected.reduce((n, row) => n + row.outputTokens, 0),
      calls: selected.reduce((n, row) => n + (row.calls ?? 1), 0),
      p95: times[Math.ceil(times.length * 0.95) - 1] ?? 0,
    };
  });
}

const LABELS = { baseline: '現行Choice', thresholded: '確率で足切り', verified: '現行＋候補再比較', 'compact-choice': '短い質問＋Choice', 'compact-noul': '短い質問＋Noul' };
const list = names => names.length ? names.join('、') : 'なし';

export function renderExperiments({ deviceId, reports = loadExperimentReports() }) {
  const body = reports.map(({ title, report }) => `<article><h1>${escape(title)}</h1>
    <p class="status">状態: ${report.status === 'complete' ? '測定完了' : '測定失敗'} · ${escape(report.completedAt)} · ${escape(report.model)}</p>
    <p class="decision">${escape(report.decision)}</p><p>${escape(report.scope)}</p>
    <p>基準commit: <code>${escape(report.baselineCommit)}</code> · 判定値は確率であり、正しさの保証ではありません。</p>
    <p><a href="https://docs.typesafe.ai/cookbooks/skill_suggestion">参考: TypeSafe公式 Skill suggestion</a>。この実験は公式例の再現ではなく、Spotter用の候補方式との比較です。</p>
    ${report.groups.map(group => `<section><h2>${escape(group.title)}</h2><p>${escape(group.note)}</p>
      <div class="scroll"><table><thead><tr><th>方式</th><th>完全一致</th><th>期待外の提案</th><th>期待した提案の欠落</th><th>入力token合計</th><th>出力token合計</th><th>API回数</th><th>p95</th></tr></thead><tbody>
      ${summarizeExperiment(group.rows).map(summary => `<tr><th>${escape(LABELS[summary.variant] ?? summary.variant)}</th><td>${summary.exact}/${summary.count}</td><td>${summary.fp}</td><td>${summary.fn}</td><td>${summary.inputTokens.toLocaleString('ja-JP')}</td><td>${summary.outputTokens.toLocaleString('ja-JP')}</td><td>${summary.calls}</td><td>${Math.round(summary.p95)} ms</td></tr>`).join('')}
      </tbody></table></div><p>期待外・欠落はツール件数。反復は同一入力の繰返しで、独立した依頼の数ではありません。時間は今回の接続環境での実測です。入力と判定の詳細は下で確認できます。</p>
      <details><summary>入力・期待値・全判定を見る</summary>${group.cases.map(item => {
        const rows = group.rows.filter(row => row.id === item.id);
        const expected = item.acceptableSets ? item.acceptableSets.map(list).join(' または ') : list(item.expected);
        return `<details><summary>${escape(item.id)} — ${escape(item.category)}</summary><p>${escape(item.input.userInput ?? item.input.finalResponse)}</p><p>段階: ${escape(item.input.stage)} · 使用済み: ${escape(list(item.input.usedTools ?? []))}</p><p>期待値: ${escape(expected)}</p>${item.catalogSize ? `<p>候補数: ${item.catalogSize}</p>` : ''}
        <table><thead><tr><th>方式／反復</th><th>判定</th><th>提案</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(LABELS[row.variant] ?? row.variant)}／${row.round + 1}</td><td class="${row.exact ? 'pass' : 'fail'}">${row.exact ? '一致' : '不一致'}</td><td>${escape(list(row.selected))}</td></tr>`).join('')}</tbody></table>
        <details><summary>確率と測定値</summary><pre>${escape(JSON.stringify(rows, null, 2))}</pre></details></details>`;
      }).join('')}</details></section>`).join('')}</article>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Spotter 判定方式の比較</title><style>
  :root{font-family:system-ui,sans-serif;color:#182334;background:#f4f6f8}body{margin:0}main{max-width:1150px;margin:auto;padding:2rem}a{color:#1757a6}h1{font-size:1.8rem}h2{font-size:1.25rem}section{background:white;padding:1.3rem;margin:1.5rem 0;border:1px solid #d6dce5;border-radius:10px}.decision{font-size:1.15rem;font-weight:650}.status{color:#526175}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.65rem;border-bottom:1px solid #d6dce5}th{white-space:nowrap}p{line-height:1.7}summary{cursor:pointer;padding:.5rem}.pass{color:#126038}.fail{color:#a11c22}pre{overflow:auto;max-height:28rem;font-size:.8rem}details details{margin:.4rem 0;padding:.25rem;border-left:3px solid #d6dce5}
  </style></head><body><main><a href="/devices/${encodeURIComponent(deviceId)}/">← 端末の運用集計</a>${body}</main></body></html>`;
}
