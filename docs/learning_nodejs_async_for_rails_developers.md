# Node.js 非同期プログラミング入門 - Rails 開発者向け

*Rails 経験者が Node.js の非同期処理を理解するためのガイド*

---

## 📚 目次

1. [Event Loop の理解](#1-event-loop-の理解)
2. [Promise の基礎](#2-promise-の基礎)
3. [async/await](#3-asyncawait)
4. [Promise.all の実装パターン](#4-promiseall-の実装パターン)
5. [Worker Pool と並行処理](#5-worker-pool-と並行処理)
6. [落とし穴と対策](#6-落とし穴と対策)
7. [実務ベストプラクティス](#7-実務ベストプラクティス)

---

## 1. Event Loop の理解

### Rails のメンタルモデル（Puma）

Rails は **マルチスレッド** モデルです：

```
Puma (4スレッド)
├─ Thread 1: Request A を処理中
├─ Thread 2: Request B を処理中
├─ Thread 3: Request C を処理中
└─ Thread 4: 待機中

各スレッドは「同時に」実行される（CPU マルチコア利用）
```

### Node.js のメンタルモデル（Event Loop）

Node.js は **シングルスレッド非同期** モデルです：

```
Node.js App（1つのメインスレッド）
├─ Event Loop
│  ├─ Request A の「ステップ1」実行
│  ├─ Request B の「ステップ1」実行
│  ├─ Request C の「ステップ1」実行
│  └─ ...
└─ Worker Pool（CPU計算用）
   ├─ Worker 1: CPU計算中
   ├─ Worker 2: CPU計算中
   └─ Worker 3: 待機中
```

### Event Loop の流れ

```javascript
console.log('1');  // 同期実行

setTimeout(() => {
  console.log('2');  // 1000ms後に実行
}, 1000);

console.log('3');  // 同期実行

// 出力順: 1 → 3 → 2
```

**なぜこの順序？**

```
実行時刻 0ms:
  ├─ console.log('1') 実行 → 出力: 1
  ├─ setTimeout() → Event Loop に「1000ms後に実行」として登録
  ├─ console.log('3') 実行 → 出力: 3
  └─ Event Loop が空になった

実行時刻 1000ms:
  └─ Event Loop が setTimeout のコールバック実行
      → 出力: 2
```

### Call Stack と Callback Queue

Node.js の内部構造：

```
┌─────────────────────────┐
│  Call Stack             │
│  (実行中の関数)         │
└─────────────────────────┘
        ↑ 同期コード
        │ console.log など

┌─────────────────────────┐
│  Callback Queue         │
│  (待機中のタスク)       │
├─────────────────────────┤
│ ├─ setTimeout callback  │
│ ├─ Promise.then        │
│ ├─ HTTP 完了           │
│ └─ ファイル読み込み完了 │
└─────────────────────────┘

Event Loop：
  「Call Stack が空になったら
   Callback Queue からタスク取得して実行」
```

---

## 2. Promise の基礎

### Promise とは？（約束）

**Rails での例え：**

```ruby
# Thread.new で処理を「登録」
result = Thread.new do
  sleep(1)
  42
end

# 結果を「待つ」
value = result.value  # 1秒後に 42 が返る
puts value
```

**Node.js での同じ処理：**

```javascript
const result = new Promise((resolve, reject) => {
  setTimeout(() => {
    resolve(42);  // 1秒後に 42 を返す
  }, 1000);
});

result.then((value) => {
  console.log(value);  // 1秒後に 42 が出力
});
```

### Promise の3つの状態

```
Pending（待機中）
  ↓
Fulfilled（成功） → then() で処理
  or
Rejected（失敗） → catch() で処理
```

### 実装例

```javascript
const promise = new Promise((resolve, reject) => {
  setTimeout(() => {
    if (Math.random() > 0.5) {
      resolve(42);       // ✅ 成功
    } else {
      reject(new Error('失敗'));  // ❌ 失敗
    }
  }, 1000);
});

promise
  .then((value) => {
    console.log('成功:', value);
  })
  .catch((err) => {
    console.log('失敗:', err.message);
  });
```

---

## 3. async/await

### async/await は Promise の糖衣構文

**Promise のみ（読みづらい）：**

```javascript
function getUser(id) {
  return db.query('SELECT * FROM users WHERE id = ?', [id])
    .then(user => {
      return db.query('SELECT * FROM posts WHERE user_id = ?', [user.id])
        .then(posts => {
          return { user, posts };
        });
    })
    .catch(err => console.error(err));
}

getUser(1).then(result => {
  console.log(result);
});
```

**async/await（読みやすい）：**

```javascript
async function getUser(id) {
  try {
    const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    const posts = await db.query('SELECT * FROM posts WHERE user_id = ?', [user.id]);
    return { user, posts };
  } catch (err) {
    console.error(err);
  }
}

const result = await getUser(1);
console.log(result);
```

**内部的には全く同じ。** Promise の `.then()` と `.catch()` を `await` と `try/catch` で書き直してるだけです。

### async の重要な性質

`async` をつけた関数は **必ず Promise を返します**：

```javascript
async function myFunction() {
  return 42;
}

myFunction().then(value => {
  console.log(value);  // → 42
});

// 以下と同じ：
function myFunction() {
  return Promise.resolve(42);
}
```

### await の重要な性質

`await` は **その Promise が完了するまで待つ**：

```javascript
async function process() {
  console.log('開始');
  
  // ここで 1000ms 待機
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('完了');
}

process();
// 出力:
// 開始
// (1000ms 待機)
// 完了
```

---

## 4. Promise.all の実装パターン

### Promise.all とは？

**複数の Promise を「同時に」実行し、すべての結果を待つ**

### ❌ シリアル実行（遅い）

```javascript
async function getUserData(id) {
  const user = await db.query('SELECT * FROM users');              // 100ms
  const posts = await db.query('SELECT * FROM posts');             // 100ms
  const followers = await db.query('SELECT COUNT(*) FROM follows'); // 100ms
  
  // 合計時間: 100 + 100 + 100 = 300ms
  return { user, posts, followers };
}
```

**処理フロー：**

```
時間軸 →
[=== user (100ms) ===]
                     [=== posts (100ms) ===]
                                           [=== followers (100ms) ===]
                                                                      完了
```

### ✅ 並行実行（速い）- Promise.all 使用

```javascript
async function getUserData(id) {
  const [user, posts, followers] = await Promise.all([
    db.query('SELECT * FROM users'),              // 100ms
    db.query('SELECT * FROM posts'),              // 100ms
    db.query('SELECT COUNT(*) FROM follows')      // 100ms
  ]);
  
  // 合計時間: max(100, 100, 100) = 100ms（並行実行）
  return { user, posts, followers };
}
```

**処理フロー：**

```
時間軸 →
[=== user (100ms) ===]
[=== posts (100ms) ===]
[=== followers (100ms) ===]
完了（100ms）

→ 150ms の短縮！
```

### 実務パターン1: ユーザープロフィール取得

```javascript
app.get('/user/:id', async (req, res) => {
  // これらの3つは「依存関係がない」 → 並行実行が正しい
  
  const [user, posts, followers] = await Promise.all([
    db.query('SELECT * FROM users WHERE id = ?', [req.params.id]),
    db.query('SELECT * FROM posts WHERE user_id = ?', [req.params.id]),
    db.query('SELECT COUNT(*) FROM follows WHERE user_id = ?', [req.params.id])
  ]);

  res.json({ user, posts, followers });
});

// シリアル: 300ms
// Promise.all: 100ms（3倍高速化！）
```

### 実務パターン2: 複数の API 呼び出し

```javascript
async function getProductDetails(productId) {
  const [product, reviews, inventory, recommendations] = await Promise.all([
    fetch(`/api/products/${productId}`).then(r => r.json()),      // 200ms
    fetch(`/api/reviews/${productId}`).then(r => r.json()),       // 300ms
    fetch(`/api/inventory/${productId}`).then(r => r.json()),     // 150ms
    fetch(`/api/recommendations/${productId}`).then(r => r.json()) // 250ms
  ]);

  return { product, reviews, inventory, recommendations };
}

// シリアル: 200 + 300 + 150 + 250 = 900ms
// Promise.all: max(200, 300, 150, 250) = 300ms
// → 70% 高速化
```

### 実務パターン3: 並行 + 順序処理の混合

```javascript
app.post('/checkout', async (req, res) => {
  // [フェーズ1] 並行処理（独立）
  const [user, cart] = await Promise.all([
    db.query('SELECT * FROM users WHERE id = ?', [req.user.id]),
    db.query('SELECT * FROM carts WHERE id = ?', [req.body.cartId])
  ]);  // 100ms

  // [フェーズ2] 順序処理（user, cart に依存）
  const inventory = await checkInventory(cart.items);  // 100ms

  // [フェーズ3] 並行処理（payment と shipping は独立）
  const [payment, shipping] = await Promise.all([
    processPayment(user, cart.total),
    calculateShipping(cart.items, user.address)
  ]);  // 200ms

  // [フェーズ4] 順序処理（payment と shipping に依存）
  const order = await db.query('INSERT INTO orders ...', [payment.id, shipping.id]);  // 50ms

  res.json({ orderId: order.id });
});

// 合計: 100 + 100 + 200 + 50 = 450ms
```

---

## 5. Worker Pool と並行処理

### Scenario 1 での使用例

Chaos Tuning Lab の `Scenario 1: アプサバモデル特性の限界突破` では、CPU 計算と I/O 処理を並行実行：

```javascript
app.get('/cpu-io-mixed', async (req, res) => {
  const [cpuResult] = await Promise.all([
    runCpuComputeInWorker(100),  // Worker Thread: CPU計算（別スレッド）
    new Promise(resolve => setTimeout(resolve, 100))  // Main Thread: I/O待機
  ]);

  res.json({
    status: 'ok',
    totalTime: Date.now() - startTime,
    optimization: 'worker_threads'
  });
});
```

**フロー：**

```
メインスレッド      ワーカースレッド
    ↓                   ↓
postMessage ────→ CPU計算実行
    ↓
I/O待機中...  ← CPU計算も並行実行
    ↓                   ↓
コールバック ←── 計算完了
    ↓
レスポンス返却

総処理時間: max(100ms, 100ms) = 100ms（シリアルなら200ms）
```

### Worker Pool の実装

```javascript
// Worker Pool の初期化
const WORKER_COUNT = os.cpus().length;  // CPU コア数
const workerPool = [];

for (let i = 0; i < WORKER_COUNT; i++) {
  const worker = new Worker(path.join(__dirname, 'worker.js'));
  workerPool.push(worker);
}

// ラウンドロビン方式でタスク送信
let currentWorkerIndex = 0;

async function runCpuComputeInWorker(durationMs) {
  return new Promise((resolve, reject) => {
    const worker = workerPool[currentWorkerIndex];
    currentWorkerIndex = (currentWorkerIndex + 1) % WORKER_COUNT;

    // タイムアウト保護
    const timeout = setTimeout(() => {
      reject(new Error('Worker timeout'));
    }, durationMs + 1000);

    // メッセージハンドラ
    const messageHandler = (message) => {
      if (message.type === 'cpu-compute-result') {
        clearTimeout(timeout);
        worker.off('message', messageHandler);
        worker.off('error', errorHandler);
        resolve(message.result);
      }
    };

    const errorHandler = (err) => {
      clearTimeout(timeout);
      worker.off('message', messageHandler);
      worker.off('error', errorHandler);
      reject(err);
    };

    worker.on('message', messageHandler);
    worker.on('error', errorHandler);

    // ワーカーにタスク送信
    worker.postMessage({
      type: 'cpu-compute',
      durationMs: durationMs
    });
  });
}
```

### Rails との設計思想の差

| 項目 | Rails | Node.js |
|------|-------|---------|
| **スレッド戦略** | 1リクエスト = 1スレッド | 1リクエスト = Event Loop |
| **CPU計算** | そのスレッドで実行（ブロック） | Worker Pool へオフロード |
| **メリット** | 実装シンプル | メモリ効率が高い |
| **デメリット** | スレッド数多い → メモリ消費大 | 非同期プログラミング複雑 |

---

## 6. 落とし穴と対策

### 落とし穴1: Promise.all で1つが失敗

```javascript
const [user, profile, settings] = await Promise.all([
  db.query('SELECT * FROM users'),           // ✅ 成功
  fetchProfileAPI(),                         // ❌ 失敗
  readConfigFile()                           // ✅ 成功（でも利用不可）
]);

// → エラーが throw される
// → settings は結果が返ってくるのに利用できない
```

**対策: Promise.allSettled（すべての結果を取得）**

```javascript
const results = await Promise.allSettled([
  db.query('SELECT * FROM users'),
  fetchProfileAPI(),
  readConfigFile()
]);

// results = [
//   { status: 'fulfilled', value: user },
//   { status: 'rejected', reason: Error(...) },
//   { status: 'fulfilled', value: settings }
// ]

const user = results[0].value;
const profileError = results[1].reason;
const settings = results[2].value;
```

### 落とし穴2: タイムアウト保護がない

```javascript
// もし fetchProfileAPI がハング（応答なし）
// → ずっと待ち続ける ❌

const [user, profile, settings] = await Promise.all([
  db.query('SELECT * FROM users'),
  fetchProfileAPI(),  // ハング…
  readConfigFile()
]);
```

**対策: タイムアウト付き**

```javascript
const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), ms)
    )
  ]);

const [user, profile, settings] = await Promise.all([
  withTimeout(db.query('SELECT * FROM users'), 1000),
  withTimeout(fetchProfileAPI(), 1000),
  withTimeout(readConfigFile(), 1000)
]);
```

### 落とし穴3: 1つが遅いと全体が遅い

```javascript
await Promise.all([
  quickOperation(),     // 50ms
  mediumOperation(),    // 200ms
  slowOperation()       // 500ms  ← 遅い
]);

// 合計時間: 500ms（最も遅い処理に引きずられる）
```

**対策: 依存関係を分析**

- 独立している処理 → Promise.all で並行
- 順序が必須の処理 → await で順序制御

---

## 7. 実務ベストプラクティス

### Rule 1: 依存関係がなければ Promise.all

```javascript
// ❌ 悪い例（シリアル）
const user = await getUser(id);
const posts = await getPosts(id);
const followers = await getFollowers(id);

// ✅ 良い例（並行）
const [user, posts, followers] = await Promise.all([
  getUser(id),
  getPosts(id),
  getFollowers(id)
]);
```

### Rule 2: 依存関係があれば await で順序制御

```javascript
// ✅ 正しい
async function checkout() {
  const user = await getUser(id);             // 最初に取得
  const cart = await getCart(user.id);        // user に依存
  const payment = await process(cart);        // cart に依存
  return payment;
}
```

### Rule 3: 複数フェーズの場合は明示的に分ける

```javascript
// ✅ 読みやすく、段階的に実行

async function complexFlow() {
  // フェーズ1: 基本情報取得（並行）
  const [user, config] = await Promise.all([
    getUser(),
    getConfig()
  ]);

  // フェーズ2: 中間処理（user, config に依存）
  const result = await process(user, config);

  // フェーズ3: 最終処理（result に依存）
  const final = await finalize(result);

  return final;
}
```

### Rule 4: 中断不可な処理は Promise.all

Scenario 1 での CPU + I/O の例：

```javascript
// CPU 計算と I/O 待機は「独立」
// → Promise.all で並行実行が正しい

const [cpuResult] = await Promise.all([
  runCpuComputeInWorker(100),  // CPU計算（別スレッド）
  new Promise(resolve => setTimeout(resolve, 100))  // I/O待機
]);
```

### Rule 5: エラーハンドリングを明確に

```javascript
// ✅ 個別にエラー処理
async function safeFlow() {
  try {
    const [user, posts] = await Promise.all([
      getUser().catch(err => {
        console.log('ユーザー取得失敗:', err);
        return null;
      }),
      getPosts().catch(err => {
        console.log('投稿取得失敗:', err);
        return [];
      })
    ]);

    return { user, posts };
  } catch (err) {
    console.error('予期しないエラー:', err);
    throw err;
  }
}
```

---

## 📊 決定木：どの方法を使う？

```
複数の処理をしたい
  ↓
依存関係がある？
  ├─ YES → await で順序制御
  │   例: user = await getUser(); cart = await getCart(user.id);
  │
  └─ NO → Promise.all で並行実行
      例: [user, posts] = await Promise.all([getUser(), getPosts()]);

1つの失敗で全て失敗したい？
  ├─ YES → Promise.all
  │
  └─ NO → Promise.allSettled
      例: 複数の API から「取得可能な分だけ取得」
```

---

## 参考資料

- [MDN - Promise](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise)
- [MDN - async/await](https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Asynchronous/Promises)
- [Node.js - Event Loop](https://nodejs.org/en/docs/guides/event-loop-timers-and-nexttick/)
- [Node.js - Worker Threads](https://nodejs.org/api/worker_threads.html)

---

## 学習ノート

### このドキュメント作成時の学習ポイント

- **Event Loop の本質**: Rails の「マルチスレッド = 複数スレッドの同時実行」とは異なり、Node.js は「シングルスレッド + 非同期タスク管理」
- **Promise.all の落とし穴**: 1つが遅いと全体が遅い、1つが失敗すると全体が失敗。ただしシリアル実行より高速
- **async/await の本質**: Promise の糖衣構文に過ぎない。内部的には Promise チェーンと同じ
- **Worker Pool の役割**: CPU 計算を別スレッドへオフロードし、Event Loop をブロックしない設計
- **Rails との根本的な違い**: Rails は「リソースが豊富なら、スレッド数を増やす」戦略。Node.js は「シングルスレッドで効率化する」戦略

