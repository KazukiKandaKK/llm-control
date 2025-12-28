# テスト計画

この計画は SDK スケルトンを対象としています。実装の成熟に伴いカバレッジを拡大してください。

## ユニットテスト

### TokenLimiter
- 補充計算
- debt 精算
- 加算/乗算更新
- `rMin/rMax` と `bucketSize` へのクランプ

### ConcurrencyLimiter
- cwnd の floor/ceil 動作
- AIMD 応答
- 遅延微減

### SignalClassifier
- Retry-After パース（秒数 + HTTP-date 形式）
- ステータスからシグナルへのマッピング

### CostEstimator
- EWMA 収束
- `maxOutputTokens` キャップ
- input ヒューリスティックのエッジケース

## 統合テスト（Vitest）

### 正常パス
- 両方のリミッターが許可した時にリクエストが受理される
- キュー待ち時間が記録される

### Rate-limit パス
- 擬似サーバからの 429 が r/cwnd 減少をトリガー
- Retry-After ゲートを尊重

### Soft-loss パス
- 503/timeout が betaSoft で r と cwnd を減少

### タイムアウト/オーバーフロー
- キュータイムアウトとオーバーフローが専用エラーとして表面化

### ストリーミング
- `onStreamToken` が `meta.outputTokens` 不在時に精算を調整

### 遅延ベース
- first-token latency の増加が有効時に cwnd 微減をトリガー

### Rate-limit ヘッダ
- プロバイダ固有の limit/remaining ヘッダがバケット状態を同期

### テレメトリ
- キュー待ち、リミッター状態、エラーシグナルが TelemetrySink に出力

### メトリクス
- MetricsTelemetry スナップショットがカウンタ/ゲージを追跡
- テストで更新をアサートに使用

### Retry ヘルパー
- `withRetries` の jitter 付き backoff が Retry-After を尊重
- SDK フローでの採用時にユニット/統合でカバー

### Gateway スケルトン
- HTTP フレームワークラップ時にアダプターテストを追加
- RequestMeta/ResponseMeta マッピングの正確性と Retry-After 伝播を確認

### Rate-limit ウィンドウ
- reset/window ヘッダが補充レートを調整
- ヘッダ注入テストで `r` がクランプされることを確認

### PrometheusTelemetry
- 仕様メトリクス（`llm_cc_*`, `llm_tr_*`, `llm_queue_wait_seconds_bucket`, `llm_latency_*_seconds_bucket`, `llm_errors_total`, `llm_retries_total`）が provider/model/tenant ラベル付きで設定されることを検証

## シミュレーター駆動テスト

`sim/pseudoLLM.ts` を使用して以下を注入：
- **429 バースト**（tokens/min スタイル）でバックオフを検証
- **503 バースト** で soft-loss 処理を観察
- **レイテンシ増加** で遅延ベースシグナルを実験

テストシンクでテレメトリを記録し、実行間のリミッター状態の進化をアサート。

## 非目標（v0）

以下は延期。実装時に対象テストを追加：
- 分散/共有バジェット
- マルチテナント公平性
- ストリーミングトークンレベルアカウンティング
