# SDK 設計

この SDK は `llm_congestion_control_spec.md` に準拠し、トークン帯域と同時実行ウィンドウを調整するアプリ内 Admission Controller を提供します。まずは組み込みライブラリとして設計され、ゲートウェイプロキシへの発展パスも用意しています。

## コンポーネント

### AdmissionController (`src/admission/admissionController.ts`)
キュー対応スケジューラ。TokenLimiter と ConcurrencyLimiter の両方がキャパシティを確保できた場合のみリクエストを許可します。Retry-After ゲートを適用し、完了時にコントローラを更新します。

### TokenLimiter (`src/limiters/tokenLimiter.ts`)
適応的補充レート `r`（AIMD）を持つ Token Bucket。debt ベースの精算をサポートし、バケットが負になることを防ぎます。

### ConcurrencyLimiter (`src/limiters/concurrencyLimiter.ts`)
cwnd ベースのコントローラ。成功/失敗時に AIMD を適用し、オプションで first-token latency の増加による遅延ベースの微減をトリガーします。

### CostEstimator (`src/estimator/costEstimator.ts`)
観測された output tokens に対する EWMA と、tokenizer が利用できない場合のヒューリスティックな input token 近似。

### SignalClassifier (`src/signals/signalClassifier.ts`)
ResponseMeta を以下に分類：
- `success` - 成功
- `rate_limit` (429) - Retry-After ヘッダがあれば尊重
- `soft_loss` (503 / timeout) - 緩やかな減少シグナル
- `client_error` - 輻輳として扱わない

### Rate-limit ヘッダ同期
AdmissionController はプロバイダ固有の limit/remaining トークンヘッダ（プロバイダごとに設定可能）を取り込み、バケット上限/残高を調整できます。

### Rate-limit ウィンドウ同期
オプションの reset/window ヘッダが利用可能な場合、補充レート `r` を制約します。

### TelemetrySink (`src/telemetry/telemetry.ts`)
メトリクス/ログ用インターフェース。以下の実装を提供：
- `NullTelemetry` - 何もしない
- `ConsoleTelemetry` - コンソール出力
- `InMemoryTelemetry` - 配列にキャプチャ（テスト用）
- `MetricsTelemetry` - カウンタ/ゲージのスナップショット
- `PrometheusTelemetry` - 仕様準拠のメトリクス名/バケット

### Gateway スケルトン (`src/gateway/httpProxy.ts`)
AdmissionController を HTTP 前段に差し込むための簡易プロキシ。Express/Fastify などへの適用を想定した薄いラッパー。

### Retry ヘルパー (`src/retry.ts`)
429/503/timeout 用の jitter 付きリトライ。Retry-After を優先します。

## 制御ループ

1. リクエストごとにコストを推定（input + output tokens）
2. バケットと cwnd の両方が予測コストとスロットを確保できるまで待機
3. ユーザー提供の関数を実行し、タイミングを追跡、ResponseMeta を収集
4. 実際のコストと予測の差分を精算、シグナルを分類し `r` と `cwnd` を適応
5. テレメトリを出力（キュー待ち時間 + リミッター状態 + エラー）

## 設定 (ControlConfig)

### queue
- `enabled`: 有効化フラグ
- `maxSize`: キュー最大サイズ
- `timeoutMs`: 待ち上限（ミリ秒）

### tokenLimiter
- `rInit`: 初期補充レート (tokens/sec)
- `rMin`, `rMax`: 補充レートの下限・上限
- `bucketSize`: バケット上限（バースト許容量）
- `additiveStep`: 成功時の増加量
- `beta`: 429 時の減少係数
- `betaSoft`: 503/timeout 時の減少係数
- `settlementMode`: `"debt"` (推奨) または `"allow_negative"`

### concurrencyLimiter
- `cwndInit`: 初期 cwnd
- `cwndMin`, `cwndMax`: cwnd の下限・上限
- `betaC`: 失敗時の減少係数
- `delayDecrease`: 遅延シグナル時の減少係数（オプション）
- `delayThresholdMs`: 遅延シグナルの閾値（オプション）

### dimensions
provider/model/tenant ごとの分離をサポートするプレースホルダー。マルチプレクサで使用。

### rateLimitHeaders
プロバイダごとのヘッダ名マッピング。

## 拡張ポイント

- `CostEstimator` を tokenizer ベースの実装に差し替え
- `SignalClassifier` を拡張してプロバイダ固有ヘッダを読み取り Retry-After を設定。limit/remaining ヘッダは既にバケット状態を同期。window/reset ヘッダで `r` を制約可能
- 本番用の `TelemetrySink` を実装（Prometheus/ログ/トレース）
- provider/model/tenant をキーとするマルチディメンショナルコントローラレジストリを追加（公平性のため。AdmissionController にオプショナルマップとして存在）
- `onStreamToken` を `settle` に接続してインクリメンタルアカウンティングのストリーミングフックを導入（スケルトンに存在。本番は tokenizer ベースのアカウンティングを導入）
- Console/Memory テレメトリを Prometheus/ログエクスポーターに置き換え。provider/model/tenant ラベルを追加

## ゲートウェイへの発展

ゲートウェイに進化させるには：
- AdmissionController を HTTP ハンドラでラップし、上流リクエストを `RequestMeta` にマッピング
- 上流レスポンス/ストリームから `ResponseMeta` を抽出し `onComplete` に渡す
- rate-limit リセットと Retry-After セマンティクス用のプロバイダヘッダアダプターを接続
