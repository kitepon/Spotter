# Jev選別方式の比較

取得日: 2026-09-21。確度: 実API測定。基準commit: `596e885`。

公式資料: [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)、
[Choice](https://docs.typesafe.ai/primitives/choice)、[Noul](https://docs.typesafe.ai/primitives/noul)。
公式例はHermesの182スキルから最大1件を選ぶ二段階処理。今回の比較はその再現ではない。
Spotterの複数提案を維持した独自の候補方式を検証した。

## 採用判断の更新（2026-09-21）

ownerは同機能の候補2件の重複を許容し、短い質問＋Noulの実装を指示した。
独立確認での欠落12→3、完全一致18/30→25/30、入力token約3割減を評価する。
重複2件は同じ人工ケースを繰り返した結果であり、無関係な作業への誘導ではない。
親AIは提案の採用・実行を判断する。前回の見送りは重複を過大評価した判断だった。
元の測定値と当初判断は時点証拠として保持し、dashboardにも判断変更を追記する。

## 当初の判定（採用判断は上記で更新）

候補方式は採用しない。productionのJev判定は維持する。

- 現行Choiceの確率に足切りを加えても改善しなかった。開発ケースで選ばれた0.5は
  選択集合を変えず、高い閾値は必要な提案を落とした。
- 現行の提案が複数ある時だけ候補同士を再比較しても改善しなかった。
  最初に落ちた候補を二段目が復活させることはできない。
- 短い質問＋Noulは最初の16ケース×3回で48/48一致、入力tokenは現行から約34%減った。
  独立した10ケース×3回では25/30一致で、重複提案2件、欠落3件が残った。
- 実catalogでは短い質問で周辺候補の提案が増えた。主要操作だけを期待値としたため、
  期待外の補助操作をそのまま誤提案とは数えない。実運用精度の証明に使わない。

主な違いは、相互排他的な候補の選別と、別動作・スキルと実行ツールの併用を
同時に扱う必要があること。単一Choiceへの置換や高確率だけ残す方式では両立を保証できない。

## 再現と閲覧

- `scripts/benchmark-jev-selection.mjs <出力JSON> <反復数>`: 現行・確率足切り・候補再比較。
- `scripts/benchmark-jev-questions.mjs <fixture JSON> <出力JSON> <反復数>`: 現行・短いChoice・短いNoul。
- fixtureは`test/fixtures/jev-selection.v1.json`、`jev-selection-challenge.v1.json`。
- 認証は製品と同じJev設定を利用する。実APIを呼ぶためtokenを消費する。
- 測定時の全結果とcatalogの識別情報は`src/dashboard/experiments/jev-selection-2026-09-21.json`。
  実catalogの説明本文は公開成果物へ入れない。
- dashboardの各端末画面から「判定方式の比較実験」を開く。
- 当初のChoice基準を再現する場合は基準commitのscriptを使う。現行scriptの基準は現行backendである。
- `scripts/smoke-jev-release.mjs <出力JSON>`は製品backendを26ケース×3反復×2回確認する。

各入力の反復は独立標本ではない。親AIへの提案配送や実際の作業改善は今回測っていない。
質問の変更は小さな制御ケースだけで採用せず、実catalogでも適合を確認する必要がある。
