const express = require('express');
const compression = require('compression');
const pino = require('pino');
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

const app = express();
const logger = pino();

// Middleware
app.use(compression());

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
