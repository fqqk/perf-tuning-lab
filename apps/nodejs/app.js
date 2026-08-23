const express = require('express');
const compression = require('compression');
const pino = require('pino');
const { Worker } = require('worker_threads');
const { Pool } = require('pg');
const path = require('path');
const os = require('os');

const app = express();
const logger = pino();

// Middleware
app.use(compression());

// ============================================================
// PostgreSQL Connection Pool: Scenario 2 用
// ============================================================

const pool = new Pool({
  host: process.env.DB_HOST || 'chaos-postgres',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'chaos_user',
  password: process.env.DB_PASSWORD || 'chaos_password',
  database: process.env.DB_NAME || 'chaos_lab',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

// ============================================================
// Worker Pool: CPU 計算用
// ============================================================

const WORKER_COUNT = os.cpus().length;
const workerPool = [];
let currentWorkerIndex = 0;

// ワーカープール初期化
for (let i = 0; i < WORKER_COUNT; i++) {
  const worker = new Worker(path.join(__dirname, 'worker.js'));
  workerPool.push(worker);
}

/**
 * ワーカープールから CPU 計算を実行（ラウンドロビン）
 */
function runCpuComputeInWorker(durationMs) {
  return new Promise((resolve, reject) => {
    const worker = workerPool[currentWorkerIndex];
    currentWorkerIndex = (currentWorkerIndex + 1) % WORKER_COUNT;

    const timeout = setTimeout(() => {
      reject(new Error('Worker timeout'));
    }, durationMs + 1000);

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

    // ワーカーに CPU 計算タスクを送信
    worker.postMessage({
      type: 'cpu-compute',
      durationMs: durationMs
    });
  });
}

// ============================================================
// Scenario 1: CPU計算 + I/O混在処理
// ============================================================

/**
 * GET /cpu-io-mixed
 *
 * チューニング版: CPU計算をワーカースレッドへオフロード
 *
 * 1. CPU計算（100ms）：worker_threads で実行（Event Loop ブロックなし）
 * 2. I/O待ち（100ms）：並行で実行（CPU 計算中に他のリクエスト処理可能）
 * 3. レスポンス返却
 */
app.get('/cpu-io-mixed', async (req, res) => {
  const startTime = Date.now();

  try {
    // (1) CPU計算と I/O待ちを並行実行
    // ← worker_threads で CPU 計算は別スレッドへ
    // ← Event Loop は I/O 待ち中も他のリクエスト処理可能
    const [cpuResult] = await Promise.all([
      runCpuComputeInWorker(100),  // worker_threads: CPU 計算（イベントループをブロックしない）
      new Promise(resolve => setTimeout(resolve, 100))  // I/O 待ち
    ]);

    // (2) レスポンス
    res.json({
      status: 'ok',
      totalTime: Date.now() - startTime,
      cpu_blocked_ms: 100,
      io_wait_ms: 100,
      optimization: 'worker_threads'
    });
  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /leak
 *
 * メモリリーク観察用エンドポイント
 * グローバル配列に無限に追加
 */
const cache = [];

app.get('/leak', (req, res) => {
  // 10KB のデータを毎回追加（メモリリーク）
  cache.push(Buffer.alloc(10 * 1024));

  res.json({
    status: 'ok',
    cache_size: cache.length,
    memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  });
});

/**
 * GET /serialize-heavy
 *
 * JSON シリアライズオーバーヘッド観察用
 * 大量のデータをレスポンスとして返す
 */
app.get('/serialize-heavy', (req, res) => {
  const size = parseInt(req.query.size) || 5000;

  // 大量のオブジェクト生成
  const largeData = Array(size).fill(null).map((_, i) => ({
    id: i,
    name: `report_${i}`,
    value: Math.random() * 1000,
    timestamp: new Date().toISOString(),
    nested: {
      a: 1, b: 2, c: 3, d: 4, e: 5,
      f: 6, g: 7, h: 8, i: 9, j: 10
    }
  }));

  // JSON シリアライズ（このタイミングで CPU 消費）
  const startSerialize = Date.now();
  res.json({
    status: 'ok',
    count: largeData.length,
    data: largeData,
    serialize_time_ms: Date.now() - startSerialize
  });
});

// ============================================================
// Scenario 2: DB層のボトルネック（Connection Pool / Lock 競合）
// ============================================================

/**
 * GET /db-write?user_id=1&amount=100
 *
 * 同一レコードへの並行 UPDATE を実行
 * - Lock 競合：複数のリクエストが同じ user_id をロック待ち
 * - Connection Pool 枯渇：接続数不足でタイムアウト
 *
 * 期待値：
 * - VU 10 で全て user_id=1 を更新 → P95 Latency が大幅悪化（複数 Lock 待ち）
 * - Connection Pool 限度到達 → タイムアウトエラー増加
 */
app.get('/db-write', async (req, res) => {
  const startTime = Date.now();
  const userId = parseInt(req.query.user_id) || 1;
  const amount = parseInt(req.query.amount) || 100;

  let client;
  try {
    client = await pool.connect();

    // トランザクション開始
    await client.query('BEGIN');

    // この行をロック（他のトランザクションは待機）
    const selectResult = await client.query(
      'SELECT id, balance FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );

    if (selectResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const currentBalance = selectResult.rows[0].balance;

    // ロック保持時間を意図的に延ばす（Lock 競合を観察するため）
    await new Promise(resolve => setTimeout(resolve, 100));

    // 更新実行
    await client.query(
      'UPDATE users SET balance = $1 WHERE id = $2',
      [currentBalance - amount, userId]
    );

    // コミット（ロック解放）
    await client.query('COMMIT');

    res.json({
      status: 'ok',
      user_id: userId,
      previous_balance: currentBalance,
      new_balance: currentBalance - amount,
      total_time_ms: Date.now() - startTime
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('Rollback error:', rollbackErr);
      }
    }

    logger.error('DB error:', err);
    res.status(500).json({
      error: err.message,
      code: err.code
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

/**
 * ヘルスチェック
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// ============================================================
// サーバー起動
// ============================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Node.js app listening on port ${PORT}`);
  logger.info(`CPU cores: ${require('os').cpus().length}`);
  logger.info(`Initial memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
});
