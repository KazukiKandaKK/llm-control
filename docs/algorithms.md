# アルゴリズム

`llm_congestion_control_spec.md` から派生し、SDK スケルトン用に軽量な形で実装。

## Admission

- **両方**の条件が満たされるまで待機：`bucket >= cost_pred` かつ `inflight < floor(cwnd)`
- `Retry-After` を尊重し、指定されたデッドラインまで admission を停止
- キュータイムアウト/オーバーフローのガードレールで無制限のバックログを防止
- オプションのマルチディメンション分離（provider/model/tenant）で独立したリミッターバンドルを生成

## TokenLimiter（帯域）

### 状態変数
- `bucket`: 現在残高（tokens）
- `B` (bucketSize): バケット上限
- `r`: 補充レート（tokens/sec）※適応対象
- `debt`: 予測不足による負債
- `lastRefillAt`: 最終補充時刻

### 補充
```
bucket = min(B, bucket + r * dt)
// settlementMode=debt の場合、debt を優先返済
```

### Acquire（予約）
- 条件：`bucket >= cost_pred`
- 予約として差し引き

### Settle（精算）
- 差分：`diff = cost_pred - cost_actual`
  - `diff > 0`: 余り → バケットに返却（B まで）
  - `diff < 0`: 不足 → debt に記録（debt モード）またはバケットから減算

### リモート同期
- オプションの rate-limit ヘッダで `B` と現在のバケットを更新可能
- プロバイダ固有のヘッダ名は設定で指定（`rateLimitHeaders`）
- オプションの window/reset ヘッダで補充レート `r` を制約

### AIMD（シグナル応答）
- **成功**: `r = min(rMax, r + additiveStep)`
- **429**: `r = max(rMin, r * beta)`
- **503/timeout**: `r = max(rMin, r * betaSoft)`
- オプションで first-token latency を観測して遅延ベースの微減を追加可能

## ConcurrencyLimiter（ウィンドウ）

### 状態変数
- `cwnd`: 同時実行上限（float、実運用は floor）
- `inflight`: 実行中数

### Acquire / Release
- Acquire: `inflight < floor(cwnd)` なら許可、`inflight++`
- Release: `inflight--`

### AIMD（シグナル応答）
- **成功**: `cwnd = min(cwndMax, cwnd + 1)`
- **Loss (429/503/timeout)**: `cwnd = max(cwndMin, cwnd * betaC)`
- **遅延シグナル**（オプション）: `cwnd = max(cwndMin, cwnd * delayDecrease)`

## シグナル分類

| ステータス/条件 | シグナル | 扱い |
|---|---|---|
| 429 | `rate_limit` | 強い減少、Retry-After ヘッダがあれば尊重 |
| timeout | `soft_loss` | 緩やかな減少 |
| 5xx | `soft_loss` | 緩やかな減少 |
| 4xx (429以外) | `client_error` | 輻輳として扱わない |
| その他 | `success` | 増加 |

## コスト推定

### Input tokens
- ヒューリスティック：`ceil(文字数 / 4)`（プレースホルダー）
- tokenizer 連携時は正確に算出

### Output tokens
- (provider, model, tenant) ごとの EWMA
- デフォルト値でシード、`maxOutputTokens` がある場合はキャップ
- 精算時に EWMA を更新して将来の予測を補正

### ストリーミング
- `onStreamToken(reqId, delta)` で観測した output tokens を蓄積
- `meta.outputTokens` がない場合、蓄積したカウントを精算に使用

## テレメトリ

`TelemetrySink` フックが以下のタイミングで発火：
- キュー待ち時間
- リミッター状態更新
- エラー
- レイテンシ
- リトライ

### 参照実装
| 実装 | 用途 |
|---|---|
| `NullTelemetry` | 何もしない |
| `ConsoleTelemetry` | コンソールログ |
| `InMemoryTelemetry` | 配列にキャプチャ（テスト/アサーション用）|
| `MetricsTelemetry` | カウンタ/ゲージのスナップショット |
| `PrometheusTelemetry` | 仕様準拠のメトリクス名/バケット |

## Retry ヘルパー

`withRetries` は以下を提供：
- キャップ付きリトライ（デフォルト2回）
- Retry-After 優先、なければ jitter 付き backoff
- 429/503/timeout のみ対象
- テレメトリの `onRetry` を呼び出し

## Gateway スケルトン

`HttpProxy` は AdmissionController を上流 HTTP 呼び出しでラップ。`IncomingMessage` から `RequestMeta`、`ResponseMeta` へのマッピングはユーザー提供で、フレームワーク/プロバイダ固有の実装を分離。
