# Scenario 1: アプサバモデル特性の限界突破

## 概要

**目標:** 3言語（Ruby / Node.js / Go）のアプリケーションサーバー実行モデルの違いを、限界負荷下で実測し、言語別のチューニング戦略を習得する

**検証テーマ:** 1リクエスト内で「100ms の CPU計算」と「100ms の I/O待ち」が混在する処理を、高並行負荷（k6で100〜300 RPS）で実行したとき、各言語がどのようなボトルネックを示すか

---

## 各言語の実行モデルと予想される課題

### Ruby (Puma): マルチプロセス × マルチスレッド

**実行モデル:**
- 各ワーカープロセス内で複数スレッドが動作
- **GVL（Global VM Lock）:** CPU集約的な処理ではスレッド間で競合、単一コアしか利用できない

**Scenario 1での予想される挙動:**
```
設定: puma -w 1 -t 16  （Process 1, Thread 16）
└─ CPU計算（100ms）でGVL奪い合い
   → 複数スレッドでも1コアしか使えず、スレッド数増加が効かない
   → I/O待ち時はGVL解放される（正常に待機できる）
```

**チューニングレバー:**
1. **Process 数を増やす**（GVL回避）
   - 設定例: `puma -w 4 -t 4` → Process 4 x Thread 4
   - 効果: CPU計算を複数プロセスで分散 → 複数コア活用
   - 代価: メモリ消費量が増加（Process x メモリサイズ）

2. **YJIT 有効化**（Ruby 3.1+）
   - 設定例: `RUBY_YJIT_ENABLE=1 puma ...`
   - 効果: CPU バウンド処理の速度向上（30〜40% 程度期待）

3. **背景ワーカーへのオフロード**
   - CPU計算を別プロセス（Sidekiq など）に移譲
   - 効果: Web ワーカーが I/O に専念可能

**計測項目:**
- RPS（Requests Per Second）
- P99 Latency
- CPU使用率（`top -p <puma_pid>`）
- メモリ使用量（Process ごと）

---

### TypeScript (Node.js): シングルスレッド + イベントループ

**実行モデル:**
- メインスレッドは1つ（イベントループ駆動）
- I/O操作は non-blocking、計算結果や I/O 完了時にコールバック実行

**Scenario 1での予想される挙動:**
```
CPU計算（100ms）
└─ イベントループをブロック
   → 他のリクエストが待たされる
   → I/O 待機中も処理できない（callback 実行まで待機）
```

**チューニングレバー:**

1. **worker_threads へのオフロード**
   ```js
   // CPU計算を worker_threads で実行
   const { Worker } = require('worker_threads');
   const worker = new Worker('./cpu-heavy.js');
   worker.on('message', (result) => { /* callback */ });
   ```
   - 効果: メインスレッド（イベントループ）が他のリクエストを処理可能
   - 代価: スレッド生成・メモリオーバーヘッド（スレッドプール化で軽減）

2. **Cluster モジュール**
   ```js
   const cluster = require('cluster');
   const os = require('os');
   
   if (cluster.isMaster) {
     for (let i = 0; i < os.cpus().length; i++) {
       cluster.fork();
     }
   } else {
     app.listen(3000);
   }
   ```
   - 効果: CPU数分のプロセスでマルチコア利用
   - 代価: プロセス間通信のオーバーヘッド

3. **非同期処理の最適化**（ストリーミング化）
   - `res.on('data')`、`async/await` による適切なコントロール
   - 効果: イベントループの効率向上

**計測項目:**
- Event Loop Lag（イベントループが処理を開始するまでの遅延）
  - `clinic.js` で可視化可能
- RPS, P99 Latency
- CPU使用率

---

### Go (net/http): M:N スケジューラ + Goroutine

**実行モデル:**
- 複数の Goroutine（軽量スレッド）が OS スレッド上で動作
- **M:N スケジューラ:** 数百〜数千の Goroutine が少数の OS スレッド上で効率的に実行

**Scenario 1での予想される挙動:**
```
func handleRequest(w http.ResponseWriter, r *http.Request) {
  // CPU計算（100ms）→ goroutineスケジューラが他のgoroutineを実行
  // I/O待ち → 非ブロッキング、スケジューラが他のgoroutineを実行
  // 結果: 高並行でも CPU・I/O を効率的に活用
}
```

**予想される課題:**
- **Goroutine リーク:** リクエストごとに無限に `go func()` を生成するとメモリ圧迫
- **GC スパイク:** オブジェクト生成が多いと Garbage Collection が頻繁に発動

**チューニングレバー:**

1. **Goroutine Pool（ワーカープール）**
   ```go
   type Pool struct {
     jobs chan Task
     results chan Result
   }
   
   func (p *Pool) Submit(task Task) {
     p.jobs <- task  // プール内の限定数のworkerが処理
   }
   ```
   - 効果: Goroutine 数を制限（デフォルト：CPU コア数 × 2 など）
   - 理由: リソース制御、GC 圧力軽減

2. **オブジェクト再利用**（`sync.Pool`）
   ```go
   var bufferPool = sync.Pool{
     New: func() interface{} { return new(bytes.Buffer) },
   }
   
   buf := bufferPool.Get().(*bytes.Buffer)
   defer bufferPool.Put(buf)
   ```
   - 効果: GC 圧力軽減（アロケーション削減）

3. **GOMAXPROCS 調整**（通常は不要）
   - デフォルト：`runtime.NumCPU()`
   - 細かい調整は大抵不要（Go スケジューラが自動最適化）

**計測項目:**
- Goroutine 数（`runtime.NumGoroutine()`）
- GC 実行頻度・停止時間（`go tool pprof`）
- RPS, P99 Latency
- CPU使用率、メモリ使用量

---

## 実験デザイン

### フェーズ1: ベースライン計測

各言語で以下の処理を実装：
```
GET /cpu-io-mixed
  ├─ CPU計算（100ms）: 複雑な計算、JSON encode等
  ├─ I/O待ち（100ms）: sleep() またはDB query
  └─ レスポンス: { "status": "ok" }
```

### フェーズ2: 限界負荷テスト

k6スクリプト：
```js
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '10s', target: 50 },    // 50 RPS まで段階的
    { duration: '30s', target: 100 },   // 100 RPS
    { duration: '30s', target: 200 },   // 200 RPS
    { duration: '10s', target: 0 },     // ガードダウン
  ],
};

export default function () {
  let res = http.get('http://localhost:3000/cpu-io-mixed');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'latency < 500ms': (r) => r.timings.duration < 500,
  });
}
```

### フェーズ3: プロファイリング + チューニング

各言語のプロファイラで計測：
- **Ruby:** `stackprof` でスタックサンプリング、`memory_profiler`
- **Node.js:** `clinic.js doctor` でイベントループ遅延可視化
- **Go:** `go tool pprof` で CPU/メモリプロファイル

### フェーズ4: チューニング後の再計測

ビフォーアフターを比較：
| 指標 | Ruby (1P-16T) | Ruby (4P-4T) | Node.js | Node.js + worker | Go (Default) | Go (Pool) |
|------|---------------|--------------|---------|------------------|------|---------|
| RPS @ 100-200req/s | XX | YY | ZZ | ... | ... | ... |
| P99 Latency | | | | | | |
| CPU使用率 | | | | | | |
| メモリ | | | | | | |

---

## ドキュメント構成

```
docs/01_scenarios/01_appserver_model/
├── README.md                      ← ここ（概要と実験デザイン）
├── problem_statement.md           （問題設定：200行のコード例）
├── ruby_puma.md                   （Ruby実装、GVL検証、チューニング）
├── nodejs_eventloop.md            （Node.js実装、Event Loop検証）
├── go_goroutine.md                （Go実装、Goroutineプール化）
└── result_comparison.md           （3言語の計測結果比較表）
```

---

## 学習のポイント

1. **推測ではなく、プロファイラで計測する**
   - 「GVLが詰まってそう」ではなく、`stackprof` で確認
   - 「Event Loop Lag がありそう」ではなく、`clinic.js` で可視化

2. **言語の実行モデルを知ると、チューニング戦略が自動的に見える**
   - Ruby の GVL を理解 → Process 増加が解決策とわかる
   - Node.js の Single Thread を理解 → worker_threads が有効とわかる
   - Go の M:N スケジューラを理解 → Goroutine Pool が必要とわかる

3. **トレードオフを実測する**
   - Process 増加 → メモリコスト増加
   - worker_threads → スレッドプール管理の複雑さ
   - 定量データで判断する習慣
