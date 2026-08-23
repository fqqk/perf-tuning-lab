import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter, Rate, Gauge } from 'k6/metrics';

// ============================================================
// Scenario 2: DB層のボトルネック（Connection Pool / Lock 競合）
// ============================================================

// 実行方法:
// k6 run k6/scenario2_database.js -e TARGET=http://localhost:3000

const TARGET = __ENV.TARGET || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '30s', target: 5 },      // ウォームアップ: 5 VU
    { duration: '60s', target: 30 },     // ピーク: 30 VU（ロック競合顕著）
    { duration: '30s', target: 0 },      // クールダウン
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],   // P95 < 1000ms（ロック待機を想定）
    http_req_failed: ['rate<0.1'],       // エラー率 < 10%
  },
};

// カスタムメトリクス
const dbWriteLatency = new Trend('db_write_latency_ms');
const dbWriteRate = new Rate('db_write_rate');

export default function () {
  // 同じ user_id=1 に対して、複数 VU が並行して UPDATE
  // → Lock 競合を観察

  const url = `${TARGET}/db-write?user_id=1&amount=10`;
  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: '3s',
  };

  const res = http.get(url, params);

  // レスポンスチェック
  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 1000ms': (r) => r.timings.duration < 1000,
    'response has status field': (r) => r.json().status !== undefined,
  });

  // メトリクス記録
  dbWriteLatency.add(res.timings.duration);
  dbWriteRate.add(success);

  // リクエスト間隔を調整（100ms sleep）
  sleep(0.1);
}

export function teardown(data) {
  console.log('Scenario 2: DB層のボトルネック計測完了');
}
