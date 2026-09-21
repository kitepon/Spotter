# RAG Index

RAGは取得日付きの外部仕様・実測artifactであり、Spotter現行runtime契約の正本ではない。
`raw/`と`evals/`は当時の内容を保持し、後日の判断変更は元記録を書き換えず注記または
コンパイル文書へ追記する。現行実装は`docs/00_overview.md`のauthority mapから辿る。

現状エントリ:

- `typesafe/` — 2026-09-21のJev HTTP API・model仕様とSpotter受入結果
- `typesafe/selection-comparison.md` — 2026-09-21の確率・候補再比較・Choice/Noul比較と採用見送りの実測

- `sqlite-wal/` — 2026-09-12のSQLite公式busy handler仕様、WAL同時切替の再現と修理
- `codex-hooks/` — 2026-07-12のraw snapshot、2026-08-05公式再照合、修正前drift、Stop deliveryのCLI/App実測
- `hook-output-safety/` — Claude / Codexの親コンテキスト境界、自由文を固定助言へ投影する安全契約、2026-07-12の注入事故実測
- `openai-model-policy/` — GPT-5.6 の公式モデル区分、Codex model/effort 設定、Spotter auditor の versioned policy と評価 artifact
- `openai-model-policy/evals/2026-07-12-throughline-context-evaluation.md` — v1.4.20〜v1.4.21の
  Throughline監査文脈実測。v1.5.4で監査条件・入力としては撤回済みの歴史記録

運用規約: 外部仕様・研究と出力物は dotagents/PLAN.md 原則10に従い、`rag/<topic>/raw/` の一次ソース、コンパイル記事、ここへの1行台帳で還流する。
