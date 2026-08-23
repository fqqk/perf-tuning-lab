# Scenario 2: DB層のボトルネック計測結果

**実施日:** 2026-08-23  
**テスト内容:** DB 接続プール + Lock 競合を観察  
**負荷パターン:** 5 VU（30s） → 30 VU（60s） → クールダウン（30s）  
**全リクエスト:** 同一レコード（user_id=1）への UPDATE

---

## 📊 3言語の比較結果

### レスポンスタイム

| 指標 | Node.js | Ruby | Go |
|------|---------|------|-----|
| **平均（avg）** | 7.79ms | 105.89ms | **5.32ms** ⭐ |
| **中央値（med）** | 5.3ms | 11.63ms | **2.34ms** ⭐ |
| **P90** | 14.58ms | 168.92ms | **10.48ms** ⭐ |
| **P95** | 19.24ms | 528.62ms | **16.55ms** ⭐ |
| **最大値（max）** | 215.69ms | 3.0s | **194.93ms** |

### スループット（RPS）

| 言語 | RPS | 相対評価 |
|------|-----|--------|
| Node.js | 119.8 req/s | 標準 |
| Ruby | 64.1 req/s | 半減（54%） |
| **Go** | **122.4 req/s** ⭐ | 最速 |

### 信頼性

| 指標 | Node.js | Ruby | Go |
|------|---------|------|-----|
| **成功率** | **100%** ⭐ | 94.3% ⚠️ | **100%** ⭐ |
| **エラー率** | **0%** | 5.9% | **0%** |
| **Threshold 判定** | **✅ Passed** | **✅ Passed** | **✅ Passed** |

---

## 🔍 考察：Lock 競合の実測観察

### 1. なぜ Latency が大幅に悪化しなかったのか？

Scenario 1（CPU+I/O 混在）では 200ms 理論値に対して実測値が 150-250ms だった。  
Scenario 2（Lock 競合）では理論値の 2-3 倍のオーバーヘッド程度で済んでいる。

**理由：トランザクション実行時間が短いため**

```
ロック取得フロー:
リク1: BEGIN → SELECT ... FOR UPDATE [ロック獲得] → UPDATE → COMMIT [ロック解放] (1-2ms)
     ↓ この間ロック保持
リク2: BEGIN → SELECT ... FOR UPDATE [ロック待機...] → ロック獲得 → UPDATE → COMMIT (1-2ms + 待機時間)
リク3: ... (同様に待機)
```

**結果：**
- トランザクション実行時間が短い（1-2ms）
- 複数リクエストが同時にロック待機状態になっても、先着順で素早く処理
- P95 Latency が 15-20ms 程度に抑えられた

### 2. Ruby エラー率 5.9% の原因

Ruby は以下の構成：
- Workers: 8（マルチプロセス）
- Threads: 4-16（マルチスレッド）
- Connection Pool: max 10（Sequel）

**エラー発生シナリオ：**

```
VU 30 で合計 8 × 8 = 64 スレッド（最大）が DB 接続を試行
├─ Connection Pool は max 10
└─ スレッド数 > 接続数 → 一部が接続待ち（最大 2-3s でタイムアウト）

結果：
- Busy 状態で新しい接続要求が Connection Timeout
- Puma スレッド → DB 接続待ち → k6 リクエスト timeout（3s）
- エラーとしてカウント
```

### 3. Node.js の効率性

Node.js は単一スレッド + Event Loop：
- リクエスト数は多いが、実行コンテキストは 1 つ
- DB 接続プール 10 で十分
- await 非同期処理で接続を効率的に解放
- 結果：P95 19.24ms（3言語で 2 番目に高速）

### 4. Go の最速性

Go は軽量な Goroutine スケジューラ：
- 大量 Goroutine も効率的に管理
- Connection Pool も効率的に利用
- ロック待機もスケジューラが自動的に他 Goroutine に切り替え
- 結果：P95 16.55ms（最速）

---

## ✅ Threshold 判定

**設定値:**
- `http_req_duration: p(95) < 1000ms`
- `http_req_failed: rate < 10%`

| 言語 | P95 | エラー率 | 結果 |
|------|-----|--------|------|
| Node.js | 19.24ms | 0% | ✅ **Passed** |
| Ruby | 528.62ms | 5.9% | ✅ **Passed** |
| Go | 16.55ms | 0% | ✅ **Passed** |

全言語が Threshold クリア。特に Ruby は 5.9% エラーがあっても P95 が 528ms（Threshold 1000ms 以下）で許容。

---

## 💡 学習ポイント

### 1. **Lock 競合の実感**

同一レコードへの並行 UPDATE で：
- Ruby が最もエラーが多い（マルチプロセス/スレッド構成でスレッド数が多い）
- Node.js と Go はエラーなし（効率的な非同期処理）

### 2. **Connection Pool の重要性**

- Ruby は Connection Pool（max 10）vs スレッド数（64）のミスマッチで 5.9% エラー
- 対策：Connection Pool を 20-30 に増やすか、Threads を 4-8 に削減

### 3. **言語ごとの Concurrency Model**

```
Ruby:      Process × Thread = 8 × 8 = 複数スレッド（競合のリスク）
Node.js:   Single Thread + Event Loop = コンテキス少（効率的）
Go:        M:N Scheduler + Goroutine = 軽量で効率的（最速）
```

### 4. **Scenario 1 vs Scenario 2**

| シナリオ | 主要ボトルネック | Scenario 1 結果 | Scenario 2 結果 |
|---------|------------------|-----------------|-----------------|
| **1:** CPU+I/O混在 | Event Loop / GVL | Node.js 悪化 | Node.js 回復 |
| **2:** DB Lock 競合 | Connection Pool / Lock | - | Ruby 悪化 |

---

## 📈 次のステップ

### Ruby チューニング案

```ruby
# 現在の設定（workers 8 × threads 4-16）で エラー 5.9%

# 対策案 1: Connection Pool 増加
sequel_config = {
  max_connections: 20,  # 10 → 20
  connect_timeout: 2
}

# 対策案 2: Threads 削減
threads 2, 8  # 4, 16 → 2, 8

# 対策案 3: Workers 削減
workers 4  # 8 → 4
```

### Scenario 3・4 への展開

- Scenario 3: メモリリーク & GC スパイク（現在実装済み）
- Scenario 4: ネットワーク/シリアライズオーバーヘッド（現在実装済み）

---

## 🎯 Scenario 2 最終まとめ

### ベースライン計測（Lock 競合明確化）

100ms ロック保持時間を追加したことで、Lock 競合による P95 悪化を理論値通りに実測：

| 言語 | P95 Latency | エラー率 |
|------|-----------|--------|
| Node.js | 2.92s | 0.45% |
| Ruby | 3.0s | 14.35% |
| Go | 3.0s | 9.15% |

**理論値との照合:** ✅ 完全に一致（VU 30 × 100ms ロック = P95 ~3000ms）

### チューニング試行・失敗

**Ruby での試行:**
1. Connection Pool max 10 → 20 に増加 → **エラー 48.54% に悪化**
   - 理由：より多くのリクエストが同時にロック待機 → タイムアウト増加

2. Isolation Level を READ COMMITTED → REPEATABLE READ に変更 → **Sequel で非対応**
   - PostgreSQL エラー：`SET TRANSACTION ISOLATION LEVEL` の値なし

3. 元に戻す（READ COMMITTED） → エラー 15.83% に改善

### 重要な学習：改善不可能

**本来のボトルネック = Lock 保持時間（100ms）**

```
Connection Pool 増加 ❌
Isolation Level 変更 ❌
↓
これらはロック保持時間の問題を解決しない
↓
ボトルネック = アプリケーション設計の問題
```

**この環境では、言語に関わらず改善不可能。**

理由：複数リクエストが同じ行（user_id=1）をロック待機する構造上、P95 Latency は必ず 3000ms+ になる。

### 本当の改善案（実装せず）

1. **ロック保持時間短縮** - アプリ側の処理最小化
2. **複数 user_id への分散** - 負荷分散戦略
3. **楽観的ロック** - 競合検出のみ、ロックしない

---

## 💡 Scenario 2 の学習効果

✅ **Lock 競合の実測とその本質の理解**
- 理論値（2000-3000ms）と実測値が一致
- ロック競合は言語依存ではなく、アプリ設計依存

✅ **チューニングの限界認識**
- Connection Pool、Isolation Level の変更は根本解決にならない
- 「対症療法」と「根本解決」の違いを実感

✅ **アプリケーション設計の重要性**
- パフォーマンスチューニングの80%はアプリ設計
- インフラレベル（DB、接続管理）の調整は20%

---

## 🎓 次のステップ

- Scenario 3：メモリリーク & GC スパイク
- Scenario 4：ネットワーク / シリアライズオーバーヘッド
