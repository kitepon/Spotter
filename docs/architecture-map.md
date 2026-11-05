# Spotter 機能図とデータフロー図（AI 向けの正本）

作成 2026-11-06。構造化した表が正本で、人間向けの図は別に作らない。コードの変更は、先にこの表を更新してから行う。
粒度は「担当する単位」まで。各単位の内部は、そこを直すときに、その単位の行だけ詳しくする。

## 1. 機能図（単位 / 役割 / 入力 / 出力 / 状態の持ち主 / 失敗時）

| 単位 | 場所 | 役割 | 入力 | 出力 | 状態の持ち主 | 失敗時 |
| --- | --- | --- | --- | --- | --- | --- |
| hook 入口 | src/hooks, src/cli/*-hook-cmd.mjs | 各 harness（Claude / Codex / Cursor / Grok）の hook を受け、監査を依頼する | harness の hook 入力（stdin） | hook 応答、hook event | なし（下の記録単位へ書く） | hook は止めない。記録の失敗は握りつぶさず stderr に出す |
| daemon | src/daemon, src/cli/daemon-cmd.mjs | セッションごとの常駐。監査呼出しを仲介し、SessionEnd か無通信 30 分で終わる | Unix socket / named pipe の要求 | 監査結果、daemon ログ | `~/.spotter/runtime/session-*.pid`、socket、`~/.spotter/logs/daemon-<session>.log` | 致命エラーは同期で log に残して終了 |
| 監査 backend | src/core/{jev,auditor,codex-cli}-backend.mjs ほか | 呼び出した tool が足りているかを判定する | tool 台帳、会話の抜粋 | SpotterJudgment | codex-cli だけ一時 dir（呼出しごとに作り、終了時に消す） | 型付きの AuditorBackendError |
| tool 台帳 | src/tool-db | host ごとの tool 一覧と説明を集める | host の設定、MCP | `tool-db*.json` | `~/.spotter/tool-db*.json`、`<project>/.spotter/tool-db*.json` | 一時的な取得失敗では前回の値を残す |
| hook event 記録 | src/core/hook-event-log.mjs | hook の発火を 1 行ずつ残し、診断が読む | event（host, hook, status ほか） | `<project>/.spotter/hook-events.jsonl`、要約 | 同左 | 記録失敗は hook を失敗させない |
| daemon ログ診断 | src/core/daemon-log-diagnostics.mjs | daemon ログの要約 | `~/.spotter/logs/daemon-*.log` | 診断要約 | なし | 読めない file は件数に数える |
| 評価ストア | src/core/evaluation-store.mjs, src/dashboard | 監査結果の評価を貯める | 評価記録 | SQLite、dashboard | `~/.spotter/evaluation.db` | store 例外は固定の応答に丸める |
| 実行時エラー報告 | src/core/runtime-error-{store,reporter}.mjs | 失敗を端末内に登録し、BugHub へ署名つきで送る | 失敗 event | `~/.spotter/runtime-errors-v1.json`、HTTP | 同左（owner だけが読める file） | 登録結果は hook event に固定語で残す |
| install / uninstall / doctor | src/cli | hook と marker の登録、状態診断 | 利用者の操作 | harness の設定、`<project>/.spotter/marker.json` | harness の設定 file | 変更前に状態を確認 |

## 2. データフロー（経路ごとの保存先と保持）

| 経路 | 発生 | 書き先 | 増え方 | 保持（回収）の現状 |
| --- | --- | --- | --- | --- |
| hook event | hook 発火のたび | `<project>/.spotter/hook-events.jsonl` | 追記のみ。fox で 37,267 行 / 7.4 MB（2026-09-23 から 44 日、約 170 KB/日） | **回収なし**。要約は全文を読む |
| daemon ログ | daemon 起動のたび | `~/.spotter/logs/daemon-<session>.log` | 1 session に 1 file。fox で 364 file / 2.6 MB（2026-08-30 から） | **回収なし**。診断は全 file を読む |
| 実行時エラー | 失敗のたび | `~/.spotter/runtime-errors-v1.json` | 登録のたび。報告済みを境に管理 | 既存の報告 cursor に従う（本表の対象外） |
| daemon の pid / socket | daemon 起動のたび | `~/.spotter/runtime/` | 終了時に消す。異常終了の残りは次回起動で掃除 | 実測 0 file（3 host） |
| codex-cli 一時 dir | 監査呼出しごと | OS の一時 dir | 呼出し内で `rm -r` | 実測 0 件（3 host） |
| 評価 / tool 台帳 | 随時 | `~/.spotter/evaluation.db`、`tool-db*.json` | 台帳は現在の tool 集合に合わせて削る | 実測 4 MB 以下 |

## 3. 保持の方針（実装前に決めた内容）

- hook event：`hook-events.jsonl` が 2 MiB を超えたら `hook-events.jsonl.1` へ置換 rename し、新しい file に書く。残すのは現行 + 1 世代で、1 project あたり最大 4 MiB。要約と診断は現行 file だけを読む（世代をまたぐ集計はしない）。rename の失敗（Windows の共有違反など）は append を止めない。
- daemon ログ：daemon 起動時に、自分以外の `daemon-*.log` のうち最終更新が 30 日より古いものを消す。消す失敗は無視する（次回に回す）。診断が見るのは 30 日以内の log になる。
- 上記以外の保存物は増えないか上限がある。変更しない。
