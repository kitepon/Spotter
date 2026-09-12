# WAL切替の同時実行とSQLITE_BUSY

取得日: 2026-09-12。確度: 公式仕様確認済み、修正前後の最小再現済み。
出典: [SQLite busy handler](https://sqlite.org/c3ref/busy_handler.html)。
一次ソースの変換記録は `raw/2026-09-12-busy-handler.md`。

SQLiteは待機でデッドロックになると判断すると、busy handlerを呼ばずに
SQLITE_BUSYを返す。busy_timeoutの設定だけでは、同時に始まった接続が行う
journal_modeの変更を必ず待てるわけではない。

Spotterのcold startで2プロセスを最初のWAL切替直前に同期させると、旧実装は
node:sqliteのERR_SQLITE_ERROR、errcode=5で失敗した。WAL切替をschema初期化の
前へ移すだけの試行も同じエラーになった。

修正はWAL切替で返るerrcode=5だけを既存の待機時間内で再試行する。
別エラーと期限切れは元のエラーを返し、成功後は通常のbusy_timeoutへ戻す。
初期化失敗時は接続を閉じる。2プロセスの同期を入れた回帰試験と全試験が成功し、
別担当の同時化12回の再検証でも成功した。

関連箇所: `src/core/evaluation-store.mjs`、
`test/evaluation-cold-concurrency.test.mjs`。
本記事は修理時の証拠であり、現行契約は `docs/02_spotter-claude-contract.md` を参照する。
