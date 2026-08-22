# Chaos Tuning Lab: パフォーマンスチューニングの実践学習環境

## 目的

「あらゆるパフォーマンス問題に対処できる力」をハンズオンで習得すること。

単なる理論学習ではなく、**問題を自分で発生させながら、プロファイラで原因を特定し、解決する**という実践を通じて、以下を身につけます：

- **アプリケーションサーバー/ランタイムのモデル差異**の理解（Ruby GVL vs Node.js Event Loop vs Go Goroutine）
- **CPU・I/O・メモリ・DB**のどこが詰まっているかをプロファイラで**推測ではなく計測**する習慣
- 言語別のチューニングレバーと効果の実測

---

## 前提：なぜ3言語を比較するのか

言語・アプサバごとに、ボトルネックの**発生メカニズム**と**解決手段**が大きく異なります。

| 言語 / アプサバ | 実行モデル | 典型的なボトルネック | パフォーマンス調整ポイント |
| --- | --- | --- | --- |
| **Ruby (Puma)** | マルチプロセス × マルチスレッド | **GVL（Global VM Lock）** の競合<br/>CPU処理でスレッド増加が効かない | Process/Thread比の最適化、YJITの有効化 |
| **TypeScript (Node.js)** | シングルスレッド<br/>イベントループ駆動 | **Event Loop のブロック**<br/>重い計算で全リクエストが遅延 | worker_threads へのオフロード、非同期化 |
| **Go (net/http)** | M:N スケジューラ (Goroutine) | **Goroutine リーク / GC スパイク**<br/>無制限生成でメモリ圧迫 | Goroutine Pool、`sync.Pool`活用、GC調整 |

それぞれの言語で同じ「CPU計算 + I/O待機」の処理を実装し、限界負荷下での挙動を計測することで、言語特性に根ざしたチューニング戦略を習得できます。

---

## 構成

このラボは以下の4つのシナリオで構成されています：

### **Scenario 1: アプサバモデル特性の限界突破**
- 1リクエスト内で「100ms CPU計算」と「100ms I/O待ち」が混在
- **各言語での検証:** GVL競合 → Process増加時のメモリコスト、Event Loop Block → worker_threads化、Goroutine Leak → Pool制御

### **Scenario 2: DB/データアクセス層の限界**
- 同一レコード更新に集中したリクエスト（ポイント減算など）
- **検証テーマ:** Connection Pool枯渇、ロック競合、楽観的ロックへの移行効果

### **Scenario 3: メモリリーク & GC スパイク**
- グローバルキャッシュへの無限追加、Goroutine Leak
- **各言語のプロファイラで特定:**
  - Ruby: `memory_profiler` / `stackprof`
  - Node.js: `clinic.js`
  - Go: `pprof`

### **Scenario 4: ネットワーク / シリアライズオーバーヘッド**
- 数千件のJSON データをレスポンス
- **改善手段:** 圧縮、フィールド絞り込み、ストリーミング、Protocol Buffers

---

## 学習の流れ

各シナリオごとに以下のサイクルを回します：

1. **k6で限界負荷をかける** → エラー率増加・レイテンシ急増を観察
2. **プロファイラで原因特定** → CPU/メモリ/I/O のどこが詰まっているか計測
3. **仮説設定と修正** → Puma設定変更、非同期化、キャッシュ導入など
4. **再計測** → k6で ビフォーアフター比較 → 改善効果を定量化

---

## Chaos Tuning Lab 環境の特徴

### CPU・メモリ制限
```yaml
services:
  app:
    cpus: '1.0'          # 1コアに制限（マルチコア環境の効果を実測）
    mem_limit: '512m'    # メモリ制限（GC/メモリリークが見える）
```

理由：ローカルのハイスペック環境ではボトルネックが見えにくいため、意図的にリソースを絞り、本番に近い制約条件を再現

### 統合モニタリング
- **Prometheus + Grafana** → アプリケーションメトリクス可視化
- **言語固有プロファイラ** → Go: pprof / Node.js: clinic.js / Ruby: stackprof

---

## ドキュメント構成

```
docs/
├── 00_overview.md           ← ここ（全体像）
├── 01_scenarios/
│   ├── 01_appserver_model/  （Scenario 1）
│   ├── 02_db_access/        （Scenario 2）
│   ├── 03_memory_gc/        （Scenario 3）
│   └── 04_network_serialize/ （Scenario 4）
├── 02_setup.md              （環境構築手順）
├── 03_profiler_guide.md     （言語別プロファイラ使い方）
└── 04_k6_guide.md           （k6テスト執筆ガイド）
```

---

## 次のステップ

1. 各シナリオの詳細は `docs/01_scenarios/` を参照
2. 環境構築は `docs/02_setup.md` から開始
3. 各言語の実装テンプレートは `apps/<lang>/scenarios/` に配置
