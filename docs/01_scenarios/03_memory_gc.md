# Scenario 3: メモリリーク & GC スパイク

## 概要

**目標:** 各言語の Garbage Collection（GC）メカニズムを理解し、メモリリークと GC フリーズの検出・対策を習得する

**検証テーマ:** グローバルキャッシュへの無限追加、Goroutine リーク、Event Emitter リークなど、典型的なメモリリークパターンを意図的に発生させ、言語別プロファイラで診断

---

## メモリリークのパターン

### パターン1: グローバル配列への無限追加（Ruby/Node.js/Go 共通）

```js
// Node.js の例
const cache = [];

app.get('/api/data/:id', (req, res) => {
  const data = { id: req.params.id, timestamp: Date.now(), payload: generateLargeData() };
  cache.push(data);  // ← キャッシュから削除されない（メモリリーク！）
  res.json({ status: 'ok' });
});
```

**予想される挙動:**
- 最初の数分：RPS 安定、P99 Latency 安定
- 10分経過：メモリ使用量が徐々に増加
- 20分経過：GC 実行頻度が激増、CPU 使用率スパイク
- 30分経過：メモリ枯渇 → Out of Memory エラー → プロセス終了

**実装パターン（意図的なリーク）:**

Ruby:
```ruby
$cache = []

get '/api/data/:id' do
  data = { id: params[:id], payload: SecureRandom.random_bytes(1024 * 100) }
  $cache << data  # グローバル変数に蓄積
  json { status: 'ok' }
end
```

Go:
```go
var cache []interface{}

func handleRequest(w http.ResponseWriter, r *http.Request) {
  data := make([]byte, 100*1024)  // 100KB アロケート
  cache = append(cache, data)     // グローバルに蓄積
  json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

---

### パターン2: Goroutine リーク（Go 特有）

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
  go func() {
    // 接続を開く
    conn, _ := net.Dial("tcp", "example.com:80")
    defer conn.Close()
    
    for {
      // ← このループが永遠に回り続け、Goroutine が終了しない
      conn.Read(buf)
    }
  }()
  w.Write([]byte("ok"))
}
// リクエストごとに1つの Goroutine が蓄積される
// 1000リクエスト → 1000個の永遠に実行中の Goroutine
```

**予想される挙動:**
- Goroutine 数が右肩上がりに増加
- メモリ使用量が線形に増加（1 Goroutine ≈ 2KB メモリ）
- やがてメモリ枯渇 → runtime: out of memory

---

### パターン3: Event Emitter リーク（Node.js 特有）

```js
// Node.js の例
const EventEmitter = require('events');

app.get('/subscribe/:channel', (req, res) => {
  const emitter = new EventEmitter();
  
  emitter.on('message', (msg) => {
    console.log(msg);
  });
  
  // ← `emitter` への参照を保持し続ける
  res.json({ status: 'subscribed' });
});
```

**予想される挙動:**
- EventEmitter インスタンスが削除されない
- Listener が蓄積される
- V8 Heap に残留 → GC 対象外

---

### パターン4: キャッシュの無限大きさ（よくある実装ミス）

```js
// Node.js の例（問題あり）
const cache = new Map();

app.get('/cache/:key', (req, res) => {
  if (!cache.has(req.params.key)) {
    cache.set(req.params.key, expensiveComputation());
  }
  res.json(cache.get(req.params.key));
});
```

**チューニング版:**
```js
// LRU キャッシュで size を制限
const Cache = require('lru-cache');
const cache = new Cache({ max: 1000 });  // ← 最大1000エントリに制限

app.get('/cache/:key', (req, res) => {
  if (!cache.has(req.params.key)) {
    cache.set(req.params.key, expensiveComputation());
  }
  res.json(cache.get(req.params.key));
});
```

---

## 言語別プロファイラ

### Ruby: stackprof + memory_profiler

**stackprof（CPU/Wall time サンプリング）:**
```bash
# Gemfile
gem 'stackprof'

# app.rb
StackProf.run(mode: :wall, out: 'tmp/stackprof.dump', interval: 1000) do
  # アプリケーション実行
end

# 結果確認
stackprof --text tmp/stackprof.dump | head -30
```

**memory_profiler（メモリアロケーション追跡）:**
```bash
# Gemfile
gem 'memory_profiler'

# app.rb
report = MemoryProfiler.report do
  # 検査対象コード
  10.times { cache << SecureRandom.random_bytes(1024) }
end

report.pretty_print
# 出力:
#  Total allocated: 10.24 KB (2 objects)
#  String: 10.24 KB (2 objects)
```

---

### Node.js: clinic.js + heapdump

**clinic.js（GC・Event Loop・CPU可視化）:**
```bash
npm install -g clinic

# プロファイリング実行
clinic doctor -- node app.js

# 結果は browser で表示
# clinic doctor では GC pause、メモリリーク傾向が可視化される
```

**heapdump（V8 Heap スナップショット）:**
```bash
npm install heapdump

// app.js
const heapdump = require('heapdump');

// エンドポイント: /heapdump でスナップショット取得
app.get('/heapdump', (req, res) => {
  heapdump.writeSnapshot(`./heap-${Date.now()}.heapsnapshot`);
  res.send('Heap snapshot saved');
});

// Chrome DevTools で *.heapsnapshot を開いてメモリリーク箇所を特定
```

---

### Go: pprof（CPU・メモリ・Goroutine プロファイル）

**Goroutine プロファイル:**
```go
import (
  "net/http"
  _ "net/http/pprof"  // pprof エンドポイントを有効化
)

func main() {
  go func() {
    log.Println(http.ListenAndServe("localhost:6060", nil))
  }()
  
  // アプリケーション処理...
}
```

```bash
# Goroutine 数を時系列で確認
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/goroutine

# メモリプロファイル（Heap）
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/heap

# CPUプロファイル（30秒間）
go tool pprof -http=:8080 http://localhost:6060/debug/pprof/profile?seconds=30
```

---

## 実験フロー

### フェーズ1: リークコード実装 + k6 負荷

```
条件:
  - k6: 10 RPS 継続 × 10分
  - メモリ制限: 512 MB
  - ログ記録: メモリ使用量、GC 発生回数、RPS、P99 Latency
```

**各言語での実装:**

Ruby (Puma):
```ruby
get '/leak' do
  $cache ||= []
  $cache << SecureRandom.random_bytes(10_000)  # 10KB 蓄積
  json { status: 'ok' }
end
```

Node.js:
```js
const cache = [];

app.get('/leak', (req, res) => {
  cache.push(Buffer.alloc(10 * 1024));  // 10KB 蓄積
  res.json({ status: 'ok' });
});
```

Go:
```go
var cache [][]byte

func handleLeak(w http.ResponseWriter, r *http.Request) {
  cache = append(cache, make([]byte, 10*1024))  // 10KB 蓄積
  w.Header().Set("Content-Type", "application/json")
  json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

### フェーズ2: プロファイリング

**観察点:**
1. **メモリ使用量の時系列推移** → メモリリークの傾向
2. **GC 実行頻度** → GC が頻繁になったか
3. **Goroutine 数**（Go のみ） → 増加傾向
4. **P99 Latency** → GC による毎回の遅延増加

### フェーズ3: 修正 + 再計測

**修正パターン:**

Ruby:
```ruby
# キャッシュをLRU化
require 'lru_redux'
$cache = LruRedux::Cache.new(100)  # 最大100エントリ

get '/leak' do
  $cache[SecureRandom.hex(10)] = SecureRandom.random_bytes(10_000)
  json { status: 'ok' }
end
```

Node.js:
```js
const LRU = require('lru-cache');
const cache = new LRU({ max: 100 });

app.get('/leak', (req, res) => {
  cache.set(Date.now(), Buffer.alloc(10 * 1024));
  res.json({ status: 'ok' });
});
```

Go:
```go
func handleLeakFixed(w http.ResponseWriter, r *http.Request) {
  // グローバルに蓄積せず、レスポンスして終了
  data := make([]byte, 10*1024)
  w.Header().Set("Content-Type", "application/json")
  json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

### フェーズ4: ビフォーアフター比較

| 言語 | 指標 | リーク版 | 修正版 |
|------|------|--------|------|
| Ruby | メモリ（最終） | 512MB+ → OOM | 50MB (安定) |
| | P99 Latency | 10ms → 500ms+ | 5ms (安定) |
| Node.js | GC実行頻度 | 毎秒1回以上 | 10秒に1回 |
| | Heap 使用量 | 400MB+ → OOM | 80MB (安定) |
| Go | Goroutine数 | 1000+ | 5-10 (安定) |
| | メモリ | 300MB+ → OOM | 30MB (安定) |

---

## 学習のポイント

1. **プロファイラの習慣化**
   - 「メモリリークかもしれない」と感じたら、即座にプロファイラで計測
   - 推測ではなく、データで判断する

2. **GC の仕組みを理解**
   - Ruby: マーク・スイープ GC、メジャー/マイナー GC
   - Node.js: V8 GC（Scavenge, Mark-Sweep-Compact）
   - Go: 並行 GC、GC 停止時間の可視化

3. **長寿命プロセスの管理**
   - メモリ枯渇を予見し、事前に対応（キャッシュサイズ制限、定期的なプロセス再起動など）

4. **言語別の落とし穴**
   - Ruby: グローバル変数への無自覚な蓄積
   - Node.js: Event Emitter / Listener のクリーンアップ漏れ
   - Go: Goroutine リーク、チャネルをクローズしない
