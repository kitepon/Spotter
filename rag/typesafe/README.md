# TypeSafe Jev API

取得日: 2026-09-21。確度: 公式仕様および実API確認済み。

- 出典: https://docs.typesafe.ai/api.md 、 https://docs.typesafe.ai/models.md
- `POST https://api.typesafe.ai/v1/systemone`へBearer認証で`model`、`state`、`questions`を送る。
- Choiceは`type=choice`、`instructions`、`criteria`を受け、`choice`を返す。
- 同じstateに対する複数質問を一括送信できる。応答は実model名とtoken使用量を含む。
- 取得時のmodelは`jev-1.13.0`。入力課金は100万tokens当たり$0.042、出力は無料。
- 取得時の全request上限は64k tokens、stateと最長質問の合計は32k tokens。
- SpotterはHTTPを直接呼び、失敗時は固定errorで報告する。SDK既定の自動retryは導入しない。

実測: [v1.7.0受入](../../docs/evidence/jev-v1.7.0.md)。現行実装の正本は
`src/core/jev-backend.mjs`と[製品契約](../../docs/02_spotter-claude-contract.md)。
