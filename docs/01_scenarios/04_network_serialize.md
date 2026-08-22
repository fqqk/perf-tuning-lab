# Scenario 4: ネットワーク/シリアライズオーバーヘッド

## 概要

**目標:** JSON シリアライズ、ネットワーク転送、データ圧縮がボトルネックになる状況を実測し、各種最適化手法の効果を定量的に習得する

**検証テーマ:** 数千件のデータセットを API レスポンスとして返すシナリオで、CPU バウンド（シリアライズ）、ネットワーク I/O、圧縮の効果を可視化

---

## パフォーマンスボトルネック

### 典型的な遅いAPI

```js
// Node.js の例
app.get('/api/reports', async (req, res) => {
  const reports = await db.query('SELECT * FROM reports LIMIT 5000');
  
  // ここで 5000件を JSON シリアライズ
  res.json(reports);  // ← JSON.stringify が CPU を占有
  // レスポンス時間: 200ms の内訳:
  //   - DB クエリ: 50ms
  //   - JSON シリアライズ: 100ms  ← CPU バウンド
  //   - ネットワーク送信: 50ms（5MB データ）
});
```

**実際の計測例:**

```
┌────────────────────────────────┐
│ API Response Waterfall        │
├────────────────────────────────┤
│ DB Query          [====] 50ms │
│ JSON Serialize    [========] 100ms  ← 最大の時間消費
│ Network Send      [==] 50ms   │
├────────────────────────────────┤
│ Total             200ms        │
└────────────────────────────────┘
```

---

## ボトルネックの詳細分析

### 1. JSON シリアライズ（CPU Bound）

**問題:**
- 大規模オブジェクトのシリアライズは CPU 集約的
- `JSON.stringify()` がメインスレッドをブロック

**測定：**
```js
const largeData = Array(5000).fill({
  id: 123,
  name: "report",
  value: 456.789,
  created_at: "2024-01-01T00:00:00Z",
  nested: { a: 1, b: 2, c: 3, ... }
});

console.time('serialize');
const json = JSON.stringify(largeData);
console.timeEnd('serialize');
// serialize: 150.234ms  ← この間イベントループ停止（Node.js）

console.log(json.length);
// 1048576 bytes (≈ 1MB)
```

### 2. ネットワーク転送（I/O Bound）

**問題:**
- 大データサイズ × 低速ネットワーク = 大きな遅延
- 実験環境での遅延注入：`tc qdisc` で帯域幅制限

**例: 遅延環境でのシミュレーション**

```bash
# 10 Mbps 帯域幅制限
docker exec app tc qdisc add dev eth0 root tbf rate 10mbit burst 1m latency 100ms

# 1MB のデータ送信にかかる理論値:
# 1,000,000 bytes × 8 bits / (10 * 1,000,000 bits/sec) = 0.8 秒
```

---

## 最適化手法

### 最適化1: JSON フィールド絞り込み（データ削減）

**ビフォー:**
```js
const reports = await db.query('SELECT * FROM reports LIMIT 5000');
res.json(reports);  // 全カラムを含む → 5MB

// レスポンス:
[
  {
    id: 1,
    name: "...",
    description: "........" (長い),  // ← 不要なカラムも含まれる
    created_at: "...",
    updated_at: "...",
    internal_status: "...",
    ... (その他カラム多数)
  },
  ...
]
```

**アフター:**
```js
const reports = await db.query(
  'SELECT id, name, created_at FROM reports LIMIT 5000'  // ← 必要なカラムのみ
);
res.json(reports);  // 1.5MB

// レスポンス:
[
  { id: 1, name: "...", created_at: "..." },
  { id: 2, name: "...", created_at: "..." },
  ...
]
```

**効果:**
| 指標 | ビフォー | アフター | 削減率 |
|------|--------|--------|------|
| レスポンスサイズ | 5.0 MB | 1.5 MB | 70% |
| JSON シリアライズ時間 | 150ms | 50ms | 67% |
| P99 Latency | 250ms | 120ms | 52% |

---

### 最適化2: gzip/brotli 圧縮

**ビフォー（圧縮なし）:**
```
レスポンス: 5.0 MB (JSON テキスト)
ネットワーク送信時間: 4.0 秒（10 Mbps）
```

**アフター（gzip 圧縮）:**
```js
// Express の例
const compression = require('compression');
app.use(compression());

// または Nginx/ロードバランサ側で設定
```

**圧縮率:**
```
JSON テキスト: 5.0 MB
  ↓ gzip
圧縮後: 0.5 MB （90% 圧縮）
  
ネットワーク送信時間: 0.4 秒（10 Mbps）
```

**効果:**
| 指標 | 元の JSON | gzip | brotli |
|------|---------|------|--------|
| サイズ | 5.0 MB | 0.5 MB | 0.3 MB |
| 圧縮率 | - | 90% | 94% |
| ネットワーク送信時間 | 4.0s | 0.4s | 0.24s |
| サーバーCPU（圧縮） | 0% | 20-30% | 30-40% |

**トレードオフ:**
- gzip: CPU 消費が少ない（推奨）
- brotli: 圧縮率が高いが CPU 消費大（バックグラウンド圧縮向き）

---

### 最適化3: ストリーミングレスポンス

**ビフォー（全データをメモリに構築）:**
```js
const reports = await db.query('SELECT * FROM reports LIMIT 5000');
const json = JSON.stringify(reports);  // ← 5.0 MB がメモリに展開
res.write(json);
res.end();
```

**アフター（ストリーミング）:**
```js
res.setHeader('Content-Type', 'application/x-ndjson');
res.setHeader('Transfer-Encoding', 'chunked');

const stream = db.query('SELECT * FROM reports LIMIT 5000').stream();

stream.on('data', (row) => {
  res.write(JSON.stringify(row) + '\n');  // ← 1行ずつ送信
});

stream.on('end', () => {
  res.end();
});

// レスポンス時間:
// - ファーストバイト: 50ms（最初の行を送信）
// - データ全送信: 2.0s（1行ずつストリーム）
```

**効果:**
| 指標 | 一括送信 | ストリーミング |
|------|--------|-------------|
| ファーストバイト時間 | 150ms | 50ms |
| ピークメモリ使用量 | +500MB | +10MB |
| レイテンシ改善 | - | クライアント側で先読み可能 |

---

### 最適化4: Protocol Buffers（protobuf）または MessagePack

**JSON の問題:**
- テキストベース → サイズが大きい
- キー名を毎行繰り返す（冗長）
- シリアライズ/デシリアライズに CPU 消費

**Binary Format の例:**

JSON:
```json
[
  {"id": 1, "name": "Alice", "age": 30},
  {"id": 2, "name": "Bob", "age": 25},
  ...
]
```

MessagePack:
```
92 (配列2要素)
  83 (Map 3キー)
    a2 "id"    01
    a4 "name"  a5 "Alice"
    a3 "age"   1e
  83
    a2 "id"    02
    ...
```

**効果:**
| 指標 | JSON | MessagePack | protobuf |
|------|------|-----------|---------|
| サイズ | 100 bytes | 60 bytes | 30 bytes |
| 圧縮率 | - | 40% | 70% |
| シリアライズ速度 | 1.0x | 0.5x | 0.3x |
| デシリアライズ速度 | 1.0x | 0.4x | 0.2x |
| クライアント対応 | 全て対応 | ライブラリ必要 | .proto定義必要 |

---

## 実験フロー

### フェーズ1: ベースライン計測

```
エンドポイント: GET /api/reports
  └─ データ数: 5000件
  └─ カラム数: 20（全て返す）
  └─ レスポンス形式: JSON
  └─ 圧縮: なし
  
k6 負荷: 10 RPS × 1分
```

**計測項目:**
```js
// k6 スクリプト
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const responseSize = new Trend('response_size');
const jsonParseTime = new Trend('json_parse_time');

export default function () {
  let res = http.get('http://localhost:3000/api/reports');
  
  responseSize.add(res.body.length);
  jsonParseTime.add(res.timings.duration);
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'latency < 1000ms': (r) => r.timings.duration < 1000,
  });
}
```

**ベースライン結果:**
```
RPS:                    10.0
Duration (P50):         150ms
Duration (P99):         250ms
Response Size (avg):    5.0 MB
JSON Serialize (CPU):   ~20% per request
```

### フェーズ2: 最適化1（フィールド絞り込み）

```
エンドポイント: GET /api/reports?fields=id,name,created_at
  └─ 返すカラム: 3個（id, name, created_at）
  └─ レスポンス: 1.5 MB
```

**結果:**
```
Duration (P50):         60ms    ← 150ms → 60ms (60% 削減)
Duration (P99):         100ms   ← 250ms → 100ms (60% 削減)
```

### フェーズ3: 最適化2（gzip 圧縮）

```
エンドポイント: GET /api/reports?fields=id,name,created_at
  └─ 圧縮: gzip enabled
```

**結果:**
```
Response Size:          150 KB   ← 1.5 MB → 150 KB (90% 削減)
Duration (P50):         40ms     ← 60ms → 40ms (サーバー処理軽減）
Duration (P99):         70ms
```

### フェーズ4: 最適化3（ストリーミング）

```
エンドポイント: GET /api/reports/stream
  └─ Content-Type: application/x-ndjson
  └─ Transfer-Encoding: chunked
```

**結果:**
```
First Byte Time:        20ms     ← クライアントが先読み開始
Total Duration:         1.5s     ← データ全体の受信完了時間
```

### フェーズ5: 最適化4（Binary Format - MessagePack）

```
エンドポイント: GET /api/reports?format=msgpack
  └─ Content-Type: application/msgpack
  └─ レスポンス: 60 KB
```

**結果:**
```
Duration (P50):         25ms     ← 40ms → 25ms
Duration (P99):         35ms     ← 70ms → 35ms
CPU Usage (serialize):  5%       ← 20% → 5%
```

---

## 総合比較表

| 手法 | 実装難度 | 効果 | トレードオフ |
|------|--------|------|-----------|
| フィールド絞り込み | ★ 低 | 60% 削減 | DB クエリ修正必要 |
| gzip 圧縮 | ★ 低 | 90% サイズ削減 | CPU 消費 (20-30%) |
| ストリーミング | ★★ 中 | ファーストバイト改善 | クライアント側の処理 |
| Binary Format | ★★★ 高 | 70% サイズ削減 + CPU 削減 | クライアント対応が困難 |

---

## 学習のポイント

1. **ボトルネック特定が最優先**
   - 「ネットワークが遅そう」ではなく、プロファイラで確認
   - CPU（JSON シリアライズ）vs ネットワーク（送信時間）のどちらが支配的か

2. **単純な最適化から始める**
   - フィールド絞り込み（実装が簡単、効果大）
   - gzip 圧縮（ほぼ無料、デフォルトで有効化すべき）

3. **高度な最適化は後で**
   - ストリーミング（実装複雑、用途限定）
   - Binary Format（クライアント対応困難、特定シナリオのみ）

4. **ユーザー体験と技術的指標**
   - ファーストバイト改善 → ユーザーが応答を感じ始める
   - トータルレイテンシ改善 → 全データ取得完了までの時間
   - 両者のバランスが重要
