# Jev対応の受入記録

取得日: 2026-09-21。対象: v1.7.0。確度: 実APIで確認済み。

`test/fixtures/auditor-model-matrix.v1.json`の4ケースを各3回、2巡実行した。
実modelは`jev-1.13.0`、全24件が期待値と一致し、schema失敗・FP・FN・timeoutは0。
p95は1巡目527ms、2巡目268msだった。

dotagentsの実host-local catalogでも、Claude 133件、Codex 83件の両方で
「ありがとう。」は提案なし、「Caveatに記録済みのSQLiteの既知の罠を検索してください。」は
`mcp__caveat__caveat_search`だけを返した。4件は358〜980ms。
入力tokensはClaude 56,557〜56,582、Codex 39,305〜39,330だった。
この少数の確認を運用全体の有効性やSLO達成の証明とは扱わない。

共通規則をstateへ移して各質問から参照した試行では、実catalogの検索依頼で不要な
`caveat_pull`も提案された。各質問へ規則を含める形へ戻して再確認したものが上記結果である。

関連試験はJev優先、旧backend直接呼出し拒否、HTTP失敗、timeout、不正応答、認証file、
使用済みtool除外、Codex hookから評価DBへのmodel保存を含む。

API仕様の出典: [TypeSafe HTTP API](https://docs.typesafe.ai/api)、
[model仕様](https://docs.typesafe.ai/models)。認証は既存のTypeSafeキーを利用し、内容を記録していない。
