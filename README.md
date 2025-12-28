# LLM Control

LLM API 呼び出しのためのトークン帯域 + 同時実行数制御 TypeScript SDK。`llm_congestion_control_spec.md` に準拠。

## 概要

LLM API で発生する 429 / 503 / timeout を「単純リトライ」ではなく、**輻輳制御（送信側の適応）** として抑制しつつスループットを最大化します。

### 主な機能

- **Token レート制御（帯域）**: tokens/sec を Token Bucket + 適応レート（AIMD）で制御
- **Concurrency 制御（窓/cwnd）**: 同時実行数を AIMD で適応
- **コスト推定**: EWMA による output tokens 予測、tokenizer 連携対応
- **シグナル分類**: 429/503/timeout を適切に分類し Retry-After を尊重
- **テレメトリ**: Prometheus 互換メトリクス出力
- **プロバイダ非依存**: OpenAI / Anthropic / 他プロバイダに対応可能な抽象化

## インストール

```bash
npm install
npm run build       # TypeScript コンパイル（dist/ に出力）
npm test            # vitest でテスト実行
```

## クイックスタート

```ts
import {
  AdmissionController,
  TokenLimiter,
  ConcurrencyLimiter,
  EWMAEstimator,
  BasicSignalClassifier,
  ControlConfig
} from "llm-control";

const config: ControlConfig = {
  queue: {
    enabled: true,
    maxSize: 100,
    timeoutMs: 30_000
  },
  tokenLimiter: {
    rInit: 500,        // 初期補充レート (tokens/sec)
    rMin: 50,
    rMax: 5000,
    bucketSize: 2000,  // バースト許容量
    additiveStep: 50,  // 成功時の増加量
    beta: 0.7,         // 429 時の減少係数
    betaSoft: 0.85,    // 503/timeout 時の減少係数
    settlementMode: "debt"
  },
  concurrencyLimiter: {
    cwndInit: 4,
    cwndMin: 1,
    cwndMax: 64,
    betaC: 0.7,
    delayDecrease: 0.9,
    delayThresholdMs: 500
  }
};

const controller = new AdmissionController(config, {
  costEstimator: new EWMAEstimator(),
  tokenLimiter: new TokenLimiter(config.tokenLimiter),
  concurrencyLimiter: new ConcurrencyLimiter(config.concurrencyLimiter),
  signalClassifier: new BasicSignalClassifier()
});

// LLM API 呼び出し
const { result, meta } = await controller.run(
  { provider: "openai", model: "gpt-4", inputText: "Hello, world!" },
  async () => {
    const response = await fetch("https://api.openai.com/...");
    return {
      result: await response.json(),
      meta: {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        startAt: Date.now(),
        endAt: Date.now()
      }
    };
  }
);
```

## 構成

```
src/
├── admission/          # AdmissionController（スケジューラ）
├── limiters/           # TokenLimiter, ConcurrencyLimiter
├── estimator/          # CostEstimator（EWMA + tokenizer対応）
├── signals/            # SignalClassifier（429/503/timeout分類）
├── telemetry/          # TelemetrySink（Prometheus互換）
├── gateway/            # HttpProxy（ゲートウェイ用）
├── retry.ts            # リトライヘルパー
└── types.ts            # 型定義

sim/                    # 擬似LLMサーバ（テスト用）
tests/                  # vitest テスト
docs/                   # 設計ドキュメント
```

## ドキュメント

- [設計ドキュメント](docs/design.md) - アーキテクチャと拡張ポイント
- [アルゴリズム詳細](docs/algorithms.md) - 制御ループの詳細
- [テスト計画](docs/test-plan.md) - テスト戦略
- [シミュレーター](docs/simulator.md) - 擬似LLMサーバの使い方

## メトリクス

Prometheus 互換のメトリクス名を使用：

| メトリクス名 | 種類 | 説明 |
|---|---|---|
| `llm_cc_cwnd` | Gauge | 現在の cwnd（同時実行上限） |
| `llm_cc_inflight` | Gauge | 実行中リクエスト数 |
| `llm_tr_rate` | Gauge | 現在の補充レート r |
| `llm_tr_bucket` | Gauge | バケット残高 |
| `llm_tr_debt` | Gauge | 負債（予測不足分） |
| `llm_queue_wait_seconds_bucket` | Histogram | Admission 待ち時間 |
| `llm_latency_first_token_seconds_bucket` | Histogram | First-token latency |
| `llm_latency_total_seconds_bucket` | Histogram | Total latency |
| `llm_errors_total` | Counter | エラー数（signal種別ラベル付き）|
| `llm_retries_total` | Counter | リトライ数 |

## ライセンス

Apache-2.0
