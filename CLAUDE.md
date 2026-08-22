# Chaos Tuning Lab - Development Guide

## 🎯 プロジェクト概要

**Chaos Tuning Lab** は、パフォーマンスチューニングの実践学習環境です。

- **目的:** 「あらゆるパフォーマンス問題に対処できる力」をハンズオンで習得
- **方針:** 問題を自分で発生させ、プロファイラで原因を特定し、解決する実践ベース
- **対象:** Ruby (Puma) / Node.js / Go の3言語で同じシナリオを実装・比較

---

## 📚 重要なドキュメント

最初に読むべき順序：

1. **[README.md](README.md)** — クイックスタート、全体構成
2. **[docs/00_overview.md](docs/00_overview.md)** — 学習の前提、Chaos Lab 環境の特徴
3. **[docs/01_scenarios/](docs/01_scenarios/)** — 各シナリオの詳細（計測項目、期待される課題）

---

## 🔧 開発ワークフロー

各シナリオの実装・改善サイクル：

```
Phase 1: ドキュメント理解（30-60分）
  ↓
Phase 2: アプリ実装（1-2時間）
  ├─ Ruby / Node.js / Go で同じエンドポイントを実装
  └─ 実装テンプレートは apps/<lang>/ に配置
  ↓
Phase 3: ベースライン計測（30分）
  ├─ k6 で限界負荷をかける（段階的に 10 → 50 VU へ増加）
  ├─ プロファイラで現状を記録
  └─ 結果を docs/01_scenarios/result_comparison.md に記録
  ↓
Phase 4: チューニング実施（1-2時間）
  ├─ プロファイラの結果から仮説設定
  ├─ 言語別のチューニングレバーを実装
  └─ コード変更を comments で記録
  ↓
Phase 5: 再計測 & ビフォーアフター比較（30分）
  ├─ 同じ k6 スクリプトで再計測
  ├─ RPS / P99 Latency / CPU使用率 を比較
  └─ 改善効果を定量化
```

---

## 📋 各シナリオの実装方針

### Scenario 1: アプサバモデル特性の限界突破

**エンドポイント:** `GET /cpu-io-mixed`

実装パターン（必須）：
```
処理 = CPU計算（100ms） + I/O待機（100ms）
目的 = 言語別のボトルネック観察
計測 = RPS / P99 Latency / CPU使用率
```

各言語での検証テーマ：
- **Ruby:** GVL による競合（Process 数増加でスケール可能か）
- **Node.js:** Event Loop ブロック（worker_threads 化で改善か）
- **Go:** Goroutine リーク（Pool 制御で安定性向上か）

---

### Scenario 2: DB/データアクセス層の限界

**エンドポイント:** `POST /deduct-points` （同一レコードへの集中更新）

実装パターン（未実装）：
```
処理 = SELECT ... FOR UPDATE → 更新 → COMMIT
目的 = Connection Pool 枯渇 / Lock 競合 を観察
計測 = Connection Timeout / Deadlock 発生率
```

---

### Scenario 3: メモリリーク & GC スパイク

**エンドポイント:** `GET /leak`

実装パターン（実装済み）：
```
処理 = グローバル配列に 10KB ずつ追加（毎リクエスト）
目的 = メモリリーク / GC スパイク を観察
計測 = メモリ使用量 / P99 Latency 悪化傾向
```

プロファイラで詳細確認：
- **Ruby:** `memory_profiler` でリーク箇所特定
- **Node.js:** `heapdump` で V8 Heap スナップショット取得
- **Go:** `pprof` の goroutine profile で リーク検出

---

### Scenario 4: ネットワーク/シリアライズオーバーヘッド

**エンドポイント:** `GET /serialize-heavy?size=5000`

実装パターン（実装済み）：
```
処理 = 5000件の JSON データをレスポンス
目的 = CPU（JSON シリアライズ）+ ネットワーク を観察
計測 = シリアライズ時間 / レスポンスサイズ / ネットワーク送信時間
```

最適化手順：
1. フィールド絞り込み（カラム数削減）
2. gzip 圧縮有効化
3. ストリーミング化（NDJSON）
4. Binary Format（MessagePack / protobuf）

---

## 🛠️ プロファイラの使用方法

### Ruby (Puma)

```bash
# stackprof で CPU/Wall time サンプリング
bundle exec stackprof --text tmp/stackprof.dump | head -50

# memory_profiler でメモリリーク特定
MemoryProfiler.report(top: 20).pretty_print
```

### Node.js

```bash
# clinic.js で GC / Event Loop lag を可視化
clinic doctor -- node apps/nodejs/app.js

# heapdump で V8 Heap スナップショット
node --expose-gc apps/nodejs/app.js
# ブラウザから /heapdump にアクセス → Chrome DevTools で分析
```

### Go

```bash
# pprof で CPU プロファイル（30秒間）
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# メモリプロファイル（Heap）
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine プロファイル（リーク検出）
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

**重要:** プロファイラは「推測を避ける」ための最重要ツール。ボトルネック特定時は必ず利用する。

---

## 📊 k6 テスト実行

### Scenario 1: アプサバモデル比較

```bash
# Node.js
k6 run k6/scenario1_appserver.js -e TARGET=http://localhost:3000

# Ruby
k6 run k6/scenario1_appserver.js -e TARGET=http://localhost:3001

# Go
k6 run k6/scenario1_appserver.js -e TARGET=http://localhost:3002
```

期待される結果（制限なし環境）：
- **Ruby:** P99 Latency ~250ms（GVL による競合あり）
- **Node.js:** P99 Latency ~300ms（Event Loop ブロック）
- **Go:** P99 Latency ~150ms（効率的にスケール）

### Scenario 3: メモリリーク検出

```bash
# 10分間継続してメモリリークを観察
k6 run k6/scenario3_memory.js -e TARGET=http://localhost:3000 --duration 10m
```

期待される結果：
- 最初の1分: RPS 安定、Latency 安定
- 5分後: メモリ使用量が右肩上がり
- 8分後: P99 Latency が 500ms+ に悪化（GC スパイク）
- 10分後: Out of Memory エラー

---

## 🚀 環境起動・確認

```bash
# 3つのサーバーを同時起動
docker-compose up -d

# 確認
docker-compose ps

# ログ確認
docker-compose logs chaos-nodejs
docker-compose logs chaos-ruby
docker-compose logs chaos-go

# ヘルスチェック
curl http://localhost:3000/health   # Node.js
curl http://localhost:3001/health   # Ruby
curl http://localhost:3002/health   # Go
```

### ネットワーク遅延注入（Chaos Engineering）

```bash
# Node.js コンテナに 100ms 遅延を注入
docker exec chaos-nodejs tc qdisc add dev eth0 root netem delay 100ms

# 設定確認
docker exec chaos-nodejs tc qdisc show dev eth0

# 設定変更（100ms + 5% パケットロス）
docker exec chaos-nodejs tc qdisc change dev eth0 root netem delay 100ms 10ms loss 5%

# 設定クリア
docker exec chaos-nodejs tc qdisc del dev eth0 root
```

---

## 📁 ディレクトリ構造

```
.
├── README.md                           ← クイックスタート
├── CLAUDE.md                           ← このファイル
├── docs/                               ← 学習資料
│   ├── 00_overview.md                  （全体像・前提）
│   └── 01_scenarios/                   （4つのシナリオ詳細）
├── docker-compose.yml                  ← 環境定義（CPU/メモリ制限）
├── apps/                               ← 言語別実装
│   ├── nodejs/
│   │   ├── package.json
│   │   └── app.js
│   ├── ruby/
│   │   ├── Gemfile
│   │   └── app.rb
│   └── go/
│       ├── go.mod
│       └── main.go
├── k6/                                 ← 負荷テストスクリプト
│   ├── scenario1_appserver.js
│   └── scenario3_memory.js
└── monitoring/                         ← Prometheus/Grafana 設定（オプション）
```

---

## 💡 実装時の注意点

### 1. **推測ではなく計測する**
- 「GVL が詰まってそう」ではなく、stackprof で確認
- 「メモリが増えてそう」ではなく、メモリプロファイラで計測
- 定量データに基づいて判断

### 2. **トレードオフを明示する**
- Process 増加 → メモリコスト増加（定量化）
- worker_threads → スレッド管理の複雑さ（測定）
- 圧縮 → CPU 消費増加（計測）

### 3. **言語特性に基づいたチューニング**
- Ruby: GVL を理解 → Process 増加が解決策
- Node.js: Single Thread を理解 → worker_threads が有効
- Go: M:N スケジューラを理解 → Goroutine Pool が必要

### 4. **結果を記録する**
各シナリオの計測結果を `docs/01_scenarios/result_comparison.md` に記録：

```markdown
# Scenario 1 計測結果

## ベースライン（最適化なし）
| 言語 | RPS | P99 Latency | CPU使用率 |
|------|-----|-----------|---------|
| Ruby | 20 | 250ms | 80% |
| Node.js | 18 | 300ms | 85% |
| Go | 35 | 150ms | 60% |

## 最適化後
| 言語 | RPS | P99 Latency | CPU使用率 | 改善率 |
|------|-----|-----------|---------|------|
| Ruby | 45 | 120ms | 75% | +125% |
| ...
```

---

## 🎓 学習の進め方

### Week 1: Scenario 1（基礎）
- [ ] docs/00_overview.md を熟読
- [ ] docs/01_scenarios/01_appserver_model.md を理解
- [ ] 各言語で `/cpu-io-mixed` エンドポイント実装
- [ ] k6 で基本的な負荷テスト実施
- [ ] プロファイラで各言語の特性を観察

### Week 2: Scenario 1（深掘り）
- [ ] チューニング仮説を設定
- [ ] Ruby: Process 数増加 / YJIT 有効化
- [ ] Node.js: worker_threads 導入
- [ ] Go: Goroutine Pool 制御
- [ ] ビフォーアフター比較で改善効果を定量化

### Week 3-4: Scenario 2 & 3
- [ ] DB層のボトルネック学習
- [ ] メモリリーク / GC スパイク検出
- [ ] プロファイラの実践習得

### Week 5+: Scenario 4
- [ ] ネットワーク最適化技法習得
- [ ] 4つのシナリオ全て通関

---

## 🔗 参考資料リンク

**Ruby & Puma**
- [Puma Configuration](https://github.com/puma/puma#configuration)
- [stackprof](https://github.com/tmm1/stackprof)

**Node.js**
- [Event Loop](https://nodejs.org/en/docs/guides/nodejs-performance-hooks/)
- [worker_threads](https://nodejs.org/api/worker_threads.html)
- [clinic.js](https://clinicjs.org/)

**Go**
- [Goroutine スケジューラ](https://golang.org/s/go11sched)
- [pprof](https://pkg.go.dev/runtime/pprof)

**負荷テスト**
- [k6 Documentation](https://k6.io/docs/)

---

## ❓ よくある質問

### Q: どのシナリオから始めるべき？
**A:** Scenario 1（アプサバモデル）からスタート。3言語の基本的な特性を理解してから、他のシナリオに進む。

### Q: プロファイラが複雑で理解できない
**A:** まずは簡単な例（小規模なデータセット）で試す。結果の見方が分かれば、大規模データでの利用も簡単。

### Q: メモリ制限（512MB）がきつい
**A:** 意図的な制限。本番環境に近い制約を体験することが学習目標。必要に応じて Docker Desktop のメモリを増加。

### Q: チューニング後に悪化した場合
**A:** 結果を記録しておく。トレードオフの学習が目的。「このチューニングは このシナリオではマイナス」という知見も重要。

---

## 🔄 改善の流れ

1. **新しいシナリオを追加するには**
   ```
   docs/01_scenarios/05_new_scenario.md を作成
   ↓
   apps/<lang>/scenarios/scenario5.js を実装
   ↓
   k6/scenario5_test.js を作成
   ↓
   README.md / docker-compose.yml を更新
   ```

2. **新しい言語を追加するには**
   ```
   apps/<newlang>/ ディレクトリ作成
   ↓
   docker-compose.yml に chaos-<newlang> サービス追加
   ↓
   各シナリオのエンドポイント実装
   ```

---

## 🚨 トラブルシューティング

| 問題 | 解決方法 |
|------|--------|
| Docker ビルドエラー | `docker-compose down -v && docker-compose build --no-cache` |
| ポート競合 | `lsof -i :3000` で既存プロセスを確認・停止 |
| メモリ不足 | Docker Desktop 設定で メモリを 4GB+ に増加 |
| プロファイラが起動しない | 言語別の依存ライブラリをインストール |
| k6 スクリプトエラー | `k6 run --help` で オプション確認 |

---

**最後に:** このラボは「実践」が全て。手を動かし、計測し、改善する。その過程で、パフォーマンス最適化のメソッドが身につきます！🚀
