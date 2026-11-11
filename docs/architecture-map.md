# Spotter 機能図とデータフロー図（AI 向けの正本）

作成 2026-11-06。構造化した表が正本で、人間向けの図は別に作らない。コードの変更は、先にこの表を更新してから行う。
粒度は「担当する単位」まで。各単位の内部は、そこを直すときに、その単位の行だけ詳しくする。

## 1. 機能図（単位 / 役割 / 入力 / 出力 / 状態の持ち主 / 失敗時）

| 単位 | 場所 | 役割 | 入力 | 出力 | 状態の持ち主 | 失敗時 |
| --- | --- | --- | --- | --- | --- | --- |
| hook 入口 | src/hooks, src/cli/*-hook-cmd.mjs | 各 harness（Claude / Codex / Cursor / Grok）の hook を受け、監査を依頼する | harness の hook 入力（stdin） | hook 応答、hook event | なし（下の記録単位へ書く） | hook は止めない。記録の失敗は握りつぶさず stderr に出す |
| daemon | src/daemon, src/cli/daemon-cmd.mjs | セッションごとの常駐。監査呼出しを仲介し、SessionEnd か無通信 30 分で終わる | Unix socket / named pipe の要求 | 監査結果、daemon ログ | `~/.spotter/runtime/session-*.pid`、socket、`~/.spotter/logs/daemon-<session>.log` | 致命エラーは同期で log に残して終了 |
| 監査 backend | src/core/{jev,auditor,codex-cli}-backend.mjs ほか | 呼び出した tool が足りているかを判定する | tool 台帳、会話の抜粋 | SpotterJudgment | codex-cli だけ一時 dir（呼出しごとに作り、終了時に消す） | 型付きの AuditorBackendError |
| Jev 認証解決 | src/core/jev-backend.mjs `resolveJevApiKey` | 監査 backend が使う TypeSafe キーを呼出し時だけ解く。`op://` の参照は 1Password CLI で読む | `TYPESAFE_API_KEY`、`SPOTTER_JEV_ENV_FILE`、`~/.spotter/jev.env`（キーそのもの）、`~/.spotter/jev.op.env`（`op://` の参照だけ、秘密でない） | キー文字列（process 内だけ。参照の解決結果は 5 分だけ memory に置く） | 参照 file は利用者。キーはどこにも書かない | file の読取・破損・参照の解決失敗（app 未解錠・承認待ち・5 秒超過・参照不明）は `E_JEV_CONFIG`。別 backend へは切り替えず、次の hook が最初から再試行する |
| tool 台帳 | src/tool-db | host ごとの tool 一覧と説明を集める | host の設定、MCP | `tool-db*.json` | `~/.spotter/tool-db*.json`、`<project>/.spotter/tool-db*.json` | 一時的な取得失敗では前回の値を残す |
| hook event 記録 | src/core/hook-event-log.mjs | hook の発火を 1 行ずつ残し、診断が読む（2 MiB 目安で 1 世代に回転）| event（host, hook, status ほか） | `<project>/.spotter/hook-events.jsonl`、要約 | 同左 | 記録失敗は hook を失敗させない |
| daemon ログ診断・回収 | src/core/daemon-log-diagnostics.mjs | daemon ログの要約と、古い log の回収（起動時） | `~/.spotter/logs/daemon-*.log` | 診断要約 | なし | 読めない file は件数に数える |
| 評価ストア | src/core/evaluation-store.mjs, src/dashboard | 監査結果の評価を貯める | 評価記録 | SQLite、dashboard | `~/.spotter/evaluation.db` | store 例外は固定の応答に丸める |
| 実行時エラー報告 | src/core/runtime-error-{store,reporter}.mjs | 失敗を端末内に登録し、BugHub へ署名つきで送る | 失敗 event | `~/.spotter/runtime-errors-v1.json`、HTTP | 同左（owner だけが読める file） | 登録結果は hook event に固定語で残す |
| install / uninstall / doctor | src/cli | hook と marker の登録、状態診断 | 利用者の操作 | harness の設定、`<project>/.spotter/marker.json` | harness の設定 file | 変更前に状態を確認 |

## 2. データフロー（writer → 保存物 → reader / 変換 → 返却先）

関数名は変更後（PR #22）のもの。「失敗・結果不明で残る物」は、その経路が途中で止まったとき保存物に何が残るか。

| 経路 | writer | 保存物 | reader / 変換 | 返却先 | 失敗・結果不明で残る物 |
| --- | --- | --- | --- | --- | --- |
| hook event | 各 hook process の `appendHookEventSafe` → `appendHookEvent`（→ `rotateHookEvents`） | `<project>/.spotter/hook-events.jsonl`、世代 `.1`、回転中だけ `.lock` | `summarizeHookEvents`（現行 file だけ。`firstTimestamp`、`previousGeneration` を付ける） | `spotter diagnostics` の hook-events 行と note | append 失敗は stderr に出すだけで hook は失敗させない（その event は残らない）。回転の失敗・競合は上限超過のまま残るだけで event は失われない。`.lock` が残っても 10 秒後に次の回転が消す |
| daemon ログ | daemon（`daemon-cmd.mjs` の `log`、致命時は同期 append） | `~/.spotter/logs/daemon-<session>.log` | `summarizeDaemonLogs`（logs 直下の全 `daemon-*.log`） | `spotter diagnostics` の daemon 要約 | 異常終了でも致命エラー行は残る。回収（`pruneDaemonLogs`）の失敗は `failed` 件数として daemon ログに 1 行残り、daemon 起動は失敗させない |
| 実行時エラー | hook / daemon の observer → `runtime-error-store` | `~/.spotter/runtime-errors-v1.json` | `runtime-error-reporter`（報告 cursor と ACK で管理） | BugHub、`spotter diagnostics runtime-errors` | 未 ACK の記録は cursor より後ろに残り、次回に再送（本表の対象外） |
| daemon の pid / socket | `startDaemon` | `~/.spotter/runtime/session-<id>.pid`、socket | status、起動時の孤児掃除 | `spotter status` | 異常終了では pid が残り、次の daemon 起動が掃除する |
| codex-cli 一時 dir | `codex-cli-backend` | OS の一時 dir（`spotter-codex-cli-*`） | 呼出し内だけ | なし | 正常な呼出しは finally で `rm -r`。強制終了（kill、電源断）では残る。Spotter は次の呼出しでも掃除しないので、回収は OS の再起動や一時領域の掃除に依存し、Windows の `%TEMP%` は自動では消えない。実測は 3 端末（main-server・rabbit・local）で 0 件、fox と macbook は未測定 |
| Jev 認証 | 利用者（`jev.op.env` に参照を書く）。キーの正本は 1Password | `~/.spotter/jev.op.env`（`TYPESAFE_API_KEY=op://<保管庫ID>/<項目ID>/credential`） | `resolveJevApiKey`: file を読み、`op://` なら `op read -n <参照>` を 1 回起こす（子の環境から `OP_*` を除く。1Password デスクトップ app の認証を使う。Mac は `/opt/homebrew/bin` と `/usr/local/bin` も PATH に足す。5 秒で打ち切る）。process ごとに memory cache（5 分） | Jev の HTTP 要求（`Authorization`）。診断・log・例外には書かない | 解決に失敗しても何も残らない。`E_JEV_CONFIG` で hook は監査せずに終わり、次の hook が再試行する（cache は失敗を覚えない） |
| 評価 / tool 台帳 | evaluation store、tool-db refresh | `evaluation.db`、`tool-db*.json` | dashboard、監査 | dashboard、監査入力 | 台帳は現在の tool 集合に合わせて削る。実測 4 MB 以下 |

### 2-1. 変更前（1.9.9）の保持
- hook event: 回収なし（追記のみ）。fox で 37,267 行 / 7.4 MB、約 170 KB/日。要約は全文を読む。
- daemon ログ: 回収なし。fox で 364 file / 2.6 MB。診断は全 file を読む。

## 3. 保持の方針（変更後、PR #22）

いずれも best effort で、厳密な上限や完全な回収を保証しない。

- **hook event**
  - `appendHookEvent` が追記の前に大きさを見て、2 MiB を超えていたら `rotateHookEvents` が `.1` へ置換 rename する（現行 + 1 世代）。
  - 回転は `<file>.lock`（排他作成）を取った 1 process だけが行い、取れた後にもう一度大きさを見る。他の process は回転せず追記だけする。10 秒より古い `.lock` は次の回転が消す。同じ project の同時 hook が重ねて世代を置換して、想定より早く古い世代を失うことは防ぐが、完全には排除しない。
  - 2 MiB は目安である。1 行は分割せず書くので単一の大きな行は超過し、判定と追記の間の並行 writer も超過する。rename の失敗（Windows の共有違反など）では次の event まで超過したままになる。「最大 4 MiB」は通常の目安で保証ではない。
  - 診断の件数は現行 file だけで、回転後に数え直す。誤認を避けるため要約に `firstTimestamp` と `previousGeneration` を持ち、診断に「現行 file のみ・最初の event 時刻・古い event は `.1`」の note を出す。
  - この 2 世代は診断用であり、保持が必要な原本をここへ任せない。
- **daemon ログ**
  - daemon 起動時に `pruneDaemonLogs` が、自分の log 以外の `daemon-<session>.log` を回収する。条件は全部満たすときだけ：logs 直下の通常 file（symlink は対象外）、この user の所有、最終更新が 30 日より古い、その session の `runtime/session-<id>.pid` が無い。
  - pid file の有無は `lstat` が ENOENT を返したときだけ「無し」とする。それ以外の読取失敗（EACCES、EIO など）は稼働中かどうか不明なので、その log を残して `failed` に数える。
  - pid file がある log は、稼働中か異常終了かを区別できないので残す（pid が残り続ければ log も残る）。daemon が起動しない間は古い log も残る。「診断は 30 日以内」は保証でなく、残存する古い log や pid 付きの log は診断に入る。
  - 回収の失敗は `failed` として数え、daemon ログに 1 行残す。回収は完了扱いにせず、daemon の起動と元の hook は失敗させない。
- 上記以外の保存物は増えないか、上限がある。変更しない。
