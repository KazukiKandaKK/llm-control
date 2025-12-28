# 擬似 LLM シミュレーター

`sim/pseudoLLM.ts` は、実際の API を叩かずにコントローラを検証するための軽量フェイク LLM エンドポイントを提供します。

## 機能

| 設定項目 | 説明 |
|---|---|
| `rateLimitChance` | 429 を返す確率 (0.0〜1.0) |
| `serverErrorChance` | 503 を返す確率 |
| `timeoutChance` | タイムアウトを発生させる確率 |
| `baseFirstTokenMs` | First-token latency のベース値（ミリ秒）|
| `totalDurationMs` | 総処理時間（ミリ秒）|
| `outputTokens` | コスト精算に使用する output tokens 数 |

## 使用例

```ts
import { PseudoLLMServer } from "../sim/pseudoLLM";
import { AdmissionController, /* deps... */ } from "../src";

// 20% の確率で 429 を返すサーバ
const server = new PseudoLLMServer({ rateLimitChance: 0.2 });

const { result, meta } = await controller.run(
  { provider: "sim", model: "demo", inputText: "hello" },
  () => server.call("hello")
);
```

## ストリーミング拡張

トークンをストリーミングするには：
1. 中間の `onStreamToken` コールバックを発行
2. `ResponseMeta.firstTokenAt` を適宜更新

これにより、ストリーミングシナリオでのインクリメンタルトークンアカウンティングをテストできます。

## 注入シナリオ

### 429 バースト検証
```ts
const server = new PseudoLLMServer({
  rateLimitChance: 0.5,  // 50% で 429
  baseFirstTokenMs: 100,
  totalDurationMs: 500
});
```

### 503 / タイムアウト混在
```ts
const server = new PseudoLLMServer({
  rateLimitChance: 0.1,
  serverErrorChance: 0.1,
  timeoutChance: 0.05
});
```

### レイテンシ増加（遅延シグナルテスト）
```ts
const server = new PseudoLLMServer({
  baseFirstTokenMs: 2000,  // 2秒の first-token latency
  totalDurationMs: 5000
});
```
