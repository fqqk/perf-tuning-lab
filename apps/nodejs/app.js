const express = require('express');
const compression = require('compression');
const pino = require('pino');

const app = express();
const logger = pino();

// Middleware
app.use(compression());

// ============================================================
// Scenario 1: CPU計算 + I/O混在処理
// ============================================================

/**
 * GET /cpu-io-mixed
 *
 * 1. CPU計算（100ms）：複雑な計算、JSON encode
 * 2. I/O待ち（100ms）：sleep（通常はDB query）
 * 3. レスポンス返却
 *
 * 目的: イベントループのブロックを観察
 */
app.get('/cpu-io-mixed', async (req, res) => {
  const startTime = Date.now();

  try {
    // (1) CPU計算（100ms相当）
    const cpuStart = Date.now();
    let result = 0;
    while (Date.now() - cpuStart < 100) {
      // 複雑な計算を繰り返す（イベントループを占有）
      result += Math.sqrt(Math.random() * 10000);
    }

    // (2) I/O待ち（100ms相当）
    await new Promise(resolve => setTimeout(resolve, 100));

    // (3) レスポンス
    res.json({
      status: 'ok',
      totalTime: Date.now() - startTime,
      cpu_blocked_ms: cpuStart - startTime + 100,
      io_wait_ms: 100
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
