# Open Issues

Spotterの現在の未完事項だけを記録する。
完了済みの実装・過去バージョンの観測・採用しなかった案はCHANGELOGと`docs/archive/`を参照する。

## 運用ルール

- 実際に次の行動がある項目だけを置く。
- 「念のため観測」「機会があれば」だけの項目は置かず、実害が出た時に追加する。
- 解決した項目は本文へ残さず、CHANGELOGまたは完了計画へ移す。
- P0は現在のrollout判断、P1は次の運用窓、P2は既知だが未発生のplatform固有リスク。

## P0 — BugHubへの製品報告rollout

Spotter専用のopt-in送信CLIはdraft PR #5で実装済み。BugHubの受け口と各端末の合鍵は担当者側で準備中で、
Spotterのreleaseと4端末への適用にはオーナー承認が必要。既存のauditor修正PR #4も
版付きreleaseと4端末への導入まで台帳上は未解決。

### 次の行動

署名試験、製品CI、レビューを通してdraft PRを用意する。BugHubの受け口と合鍵が届いたら、
オーナーの公開・適用承認後に4端末で送信を有効にし、端末・版・送信時刻・受領結果を報告する。

## P1 — Grok監査結果の会話内表示

Grok 1.0.41のnative `UserPromptSubmit` / `Stop` hookはstdoutを会話へ渡さない。
SpotterはGrok固有のcatalogを使って監査し、findingを構造eventと評価DBに記録するが、
入力時の提案をGrokの親会話へ届ける経路は現時点でない。

### 次の行動

Grokに受動hookから会話へ安全に情報を渡す公式機能が追加された時、
固定文のparent-output projectorを接続する。追加まではGrokの表示機能を対応済みと数えない。

## P1 — v1.5.4以降のPrimary auditor SLO判定

旧version・認証失効・usage limitを含む累積値ではなく、Throughline hard gate撤去後のv1.5.4以降を
7日移動窓かつ各Hook 50 call以上で
判定する。基準は[`04_operational-slo.md`](04_operational-slo.md)。

### 次の行動

母数到達後、UserPromptSubmit / Stopをbackend別に集計し、次を判定する。

- p50 6秒以下
- p95 15秒以下
- auditor timeout率1%以下
- auth / usage limitを除くbackend失敗率2%以下

未達時はHook重複、catalog/prompt workload、model/effortの順で直し、timeout延長だけで正常扱いしない。

## P1 — prompt変更releaseのp95 gate逸脱

v1.5.7のprompt version 3は品質54/54 exact、FP/FN/timeout 0だったが、2回のp95が
15.432秒と11.687秒で、release gateの10秒以下を満たさないまま公開された。

### 次の行動

次のprompt変更releaseではrepeat=3を2回実行し、p95 10秒以下を満たすまで公開しない。
基準を変える場合は実測とowner裁定を先に`04_operational-slo.md`へ反映する。

## P2 — Windows Named PipeのDACL制限

Unix socketはowner-onlyだが、Windows Named Pipeは明示DACLを設定していない。同一マシンの別ユーザーから
接続できる可能性がある。現在まで実害報告はない。

### 次の行動

Windowsで他ユーザー接続を再現した時点でP1へ上げ、SECURITY_DESCRIPTOR設定または専用transport層を実装する。
再現がない間はrelease blockerにしない。
