# Chaos Tuning Lab: パフォーマンスチューニングの実践学習環境

> **目的**: 「あらゆるパフォーマンス問題に対処できる力」をハンズオンで習得する
>
> **方針**: 問題を自分で発生させながら、プロファイラで原因を特定し、解決する実践を通じた学習

---

## 📚 全体構成

```
.
├── README.md                           ← このファイル
├── docs/                               ← 学習資料
│   ├── 00_overview.md                  （全体像）
│   └── 01_scenarios/                   （4つのシナリオ詳細）
│       ├── 01_appserver_model.md       （Scenario 1: Ruby vs Node.js vs Go）
│       ├── 02_db_access.md             （Scenario 2: DB層のボトルネック）
│       ├── 03_memory_gc.md             （Scenario 3: メモリリーク & GC）
│       └── 04_network_serialize.md     （Scenario 4: ネットワーク最適化）
├── docker-compose.yml                  ← Chaos Lab 環境定義
├── apps/                               ← 言語別実装
│   ├── nodejs/
│   ├── ruby/
│   └── go/
├── k6/                                 ← 負荷テストスクリプト
│   ├── scenario1_appserver.js
│   ├── scenario2_db.js
│   ├── scenario3_memory.js
│   └── scenario4_network.js
└── monitoring/                         ← Prometheus / Grafana 設定
    ├── prometheus.yml
    └── grafana/
```

---

## 🚀 クイックスタート

### 1. ドキュメント読了（30分）

まず [docs/00_overview.md](docs/00_overview.md) で全体像を把握

```bash
# ドキュメント構成の確認
open docs/00_overview.md
```

### 2. 環境起動

```bash
# 3つの言語環境を同時起動（Node.js, Ruby, Go）
docker-compose up -d

# 確認
docker-compose ps
# chaos-nodejs    3000:3000
# chaos-ruby      3001:3000
# chaos-go        3002:3000
```

### 3. Scenario を選んで実装・計測

**例: Scenario 1（アプサバモデル比較）を実施**

```bash
# Node.js 実装を確認
cat apps/nodejs/scenarios/scenario1.js

# k6 で負荷テスト実行（100 RPS × 1分）
k6 run k6/scenario1_appserver.js

# プロファイラで診断
# Node.js: clinic.js doctor
# Ruby: stackprof
# Go: pprof
```

---

## 📖 学習パス

### Phase 1: 基礎理解（Week 1）
- [ ] [Scenario 1: アプサバモデル特性](docs/01_scenarios/01_appserver_model.md)
  - Ruby GVL の理解
  - Node.js Event Loop の理解
  - Go Goroutine の理解

### Phase 2: 実装・計測（Week 2-3）
- [ ] 各言語で "CPU 計算 + I/O 待機" の処理を実装
- [ ] k6 で限界負荷テスト実施
- [ ] プロファイラで原因特定
- [ ] チューニング実施 → 効果測定

### Phase 3: 発展シナリオ（Week 4+）
- [ ] [Scenario 2: DB層の限界](docs/01_scenarios/02_db_access.md)
- [ ] [Scenario 3: メモリリーク & GC](docs/01_scenarios/03_memory_gc.md)
- [ ] [Scenario 4: ネットワーク最適化](docs/01_scenarios/04_network_serialize.md)

---

## 🔧 Chaos Lab 環境の特徴

### リソース制限

```yaml
services:
  chaos-nodejs:
    cpus: '1.0'          # 1コアに制限
    mem_limit: '512m'    # 512MB に制限
```

**なぜ制限するのか:**
- ローカルの高スペック環境ではボトルネックが見えにくい
- 本番環境に近い制約条件を再現
- パフォーマンス改善の効果が明確に見える

### ネットワーク遅延注入

```bash
# コンテナ内でネットワーク遅延を設定
docker exec chaos-nodejs tc qdisc add dev eth0 root netem delay 100ms

# 確認
docker exec chaos-nodejs tc qdisc show dev eth0

# 削除
docker exec chaos-nodejs tc qdisc del dev eth0 root
```

---

## 📊 計測・プロファイリング

### 言語別プロファイラ

#### Ruby
```bash
# stackprof（CPU + Wall time）
gem 'stackprof'
StackProf.run(mode: :wall, out: 'tmp/profile.dump') { app.run }
stackprof --text tmp/profile.dump

# memory_profiler
gem 'memory_profiler'
report = MemoryProfiler.report { ... }
report.pretty_print
```

#### Node.js
```bash
# clinic.js（GC / Event Loop 可視化）
npm install -g clinic
clinic doctor -- node app.js

# heapdump（V8 Heap スナップショット）
npm install heapdump
# Chrome DevTools で分析
```

#### Go
```bash
# pprof（CPU / メモリ / Goroutine）
import _ "net/http/pprof"

# CPU プロファイル
go tool pprof http://localhost:6060/debug/pprof/profile?seconds=30

# メモリプロファイル
go tool pprof http://localhost:6060/debug/pprof/heap

# Goroutine プロファイル
go tool pprof http://localhost:6060/debug/pprof/goroutine
```

### k6 負荷テスト

```bash
# Scenario 1: アプサバモデル比較
k6 run k6/scenario1_appserver.js

# 結果確認（JSON 形式）
k6 run --out json=results.json k6/scenario1_appserver.js
```

---

## 🎯 学習のポイント

### 1. **推測ではなく、プロファイラで計測する**
- 「GVL が詰まってそう」ではなく、`stackprof` で確認
- 「Event Loop が遅そう」ではなく、`clinic.js` で可視化

### 2. **言語の実行モデルを理解すると、チューニング戦略が見える**
- Ruby の GVL → Process 増加が解決策
- Node.js の Single Thread → worker_threads が有効
- Go の M:N スケジューラ → Goroutine Pool が必要

### 3. **トレードオフを定量化する**
- Process 増加 → メモリコスト増加（測定する）
- worker_threads → スレッド管理の複雑さ
- 圧縮 → CPU 消費増加

### 4. **実測 → 仮説 → 改善 のサイクルを習慣化**

```
┌─────────────────────────────────┐
│ 1. k6 で限界負荷をかける        │
│    → エラー率増加 / Latency急増 │
├─────────────────────────────────┤
│ 2. プロファイラで原因特定       │
│    → CPU / I/O / メモリのどこが │
├─────────────────────────────────┤
│ 3. 仮説設定と修正               │
│    → Puma設定 / 非同期化など    │
├─────────────────────────────────┤
│ 4. 再計測でビフォーアフター比較 │
│    → 改善効果を定量化           │
└─────────────────────────────────┘
```

---

## 📝 各 Scenario の概要

| Scenario | テーマ | 検証内容 |
|----------|--------|--------|
| **1** | アプサバモデル | CPU 計算 + I/O 混在時の言語別ボトルネック |
| **2** | DB 層の限界 | Connection Pool / Lock 競合 / Deadlock |
| **3** | メモリ & GC | メモリリーク / GC スパイク / Goroutine リーク |
| **4** | ネットワーク最適化 | JSON シリアライズ / 圧縮 / ストリーミング |

各シナリオの詳細は [docs/01_scenarios/](docs/01_scenarios/) を参照

---

## 🛠️ 開発

### アプリケーション追加

```bash
# 新しい言語の Scenario を追加
mkdir -p apps/newlang/scenarios
# → apps/newlang/scenarios/scenario1.js（または .rb, .go）を実装
```

### docker-compose に追加

```yaml
chaos-newlang:
  image: newlang:latest
  working_dir: /app
  volumes:
    - ./apps/newlang:/app
  ports:
    - "3003:3000"
  cpus: '1.0'
  mem_limit: '512m'
  cap_add:
    - NET_ADMIN
```

---

## 📚 参考資料

### Ruby & Puma
- [Puma Configuration](https://github.com/puma/puma#configuration)
- [Ruby GVL を理解する](https://ruby-doc.org/docs/)
- [stackprof](https://github.com/tmm1/stackprof)

### Node.js
- [Event Loop の仕組み](https://nodejs.org/en/docs/guides/nodejs-performance-hooks/)
- [worker_threads](https://nodejs.org/api/worker_threads.html)
- [clinic.js](https://clinicjs.org/)

### Go
- [Goroutine スケジューラ](https://golang.org/s/go11sched)
- [pprof](https://pkg.go.dev/runtime/pprof)
- [Goroutine リーク検出](https://go.dev/blog/pipelines)

### 負荷テスト
- [k6 Documentation](https://k6.io/docs/)
- [k6 Performance Testing Best Practices](https://k6.io/docs/general/best-practices/)

---

## 🤝 進め方

1. **ドキュメントを熟読** → 概念理解
2. **アプリを実装** → 手を動かす
3. **k6 で負荷テスト** → 限界を確認
4. **プロファイラで診断** → ボトルネック特定
5. **チューニング実施** → 改善効果測定
6. **学習記録を残す** → 次の参考資料に

---

## 📞 トラブルシューティング

### Docker ビルドエラー
```bash
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

### ポート競合
```bash
# 既に起動中のサービスを確認
lsof -i :3000

# 既存のコンテナを停止
docker-compose down
```

### メモリ不足
```bash
# Docker Desktop のメモリ制限を増加
# Settings → Resources → Memory: 4GB+ に設定
```

---

**Happy Tuning! 🚀**
