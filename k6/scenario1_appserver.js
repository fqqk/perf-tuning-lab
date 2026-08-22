/**
 * Scenario 1: アプサバモデル特性の限界突破
 *
 * テスト対象: Ruby (Puma) vs Node.js vs Go
 * エンドポイント: GET /cpu-io-mixed
 *
 * 検証内容:
 * - 1リクエスト = CPU計算(100ms) + I/O待機(100ms)
 * - 複数リクエストを並行実行（負荷段階的に増加）
 * - 各言語のボトルネックを計測
 *
 * 実行方法:
 * ```bash
 * # Node.js をテスト
 * k6 run k6/scenario1_appserver.js \
 *   --vus 10 \
 *   --duration 60s \
 *   --summary-export results.json \
 *   -e TARGET=http://localhost:3000
 *
 * # Ruby をテスト
 * k6 run k6/scenario1_appserver.js -e TARGET=http://localhost:3001
 *
 * # Go をテスト
 * k6 run k6/scenario1_appserver.js -e TARGET=http://localhost:3002
 * ```
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ============================================================
// カスタムメトリクス
// ============================================================

// レスポンスタイム
const responseTime = new Trend('http_req_duration');
const p99Latency = new Trend('p99_latency');
const p95Latency = new Trend('p95_latency');

// エラー率
const errorRate = new Rate('errors');
const successRate = new Rate('successes');

// リクエスト数
const requestCounter = new Counter('requests');

// ============================================================
// テスト設定
// ============================================================

export const options = {
  // VU（Virtual Users）と期間を定義
  stages: [
    // ウォームアップ: 5 VU で 30秒
    { duration: '30s', target: 5 },

    // 段階的に負荷を増加: 5 VU → 20 VU
    { duration: '30s', target: 10 },
    { duration: '30s', target: 20 },
    { duration: '30s', target: 50 },

    // ピーク負荷: 50 VU で 60秒
    { duration: '60s', target: 50 },

    // クールダウン: 徐々に負荷を下げる
    { duration: '30s', target: 10 },
    { duration: '20s', target: 0 },
  ],

  // しきい値（テスト合格判定）
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    errors: ['rate<0.1'],  // エラー率 10% 以下
  },
};

// ============================================================
// テスト実行
// ============================================================

export default function () {
  // テスト対象のベースURL
  const baseUrl = __ENV.TARGET || 'http://localhost:3000';

  // グループ化してメトリクスを見やすく
  group('Scenario 1: CPU-IO Mixed', () => {
    // リクエスト実行
    const res = http.get(`${baseUrl}/cpu-io-mixed`);

    // メトリクス記録
    requestCounter.add(1);

    // レスポンスの検証
    const isSuccess = check(res, {
      'status is 200': (r) => r.status === 200,
      'latency < 500ms': (r) => r.timings.duration < 500,
      'latency < 1000ms': (r) => r.timings.duration < 1000,
      'has body': (r) => r.body && r.body.length > 0,
    });

    if (isSuccess) {
      successRate.add(true);
    } else {
      errorRate.add(true);
      console.error(`Request failed: ${res.status} - ${res.body}`);
    }

    // レスポンスタイムを記録
    responseTime.add(res.timings.duration);
    p95Latency.add(res.timings.duration);
    p99Latency.add(res.timings.duration);

    // リクエスト間に少し待機
    sleep(1);
  });
}

/**
 * テスト終了時の結果サマリー
 */
export function handleSummary(data) {
  console.log('=== Scenario 1: アプサバモデル特性テスト結果 ===');
  console.log(`
  テスト概要:
  - CPU計算（100ms）+ I/O待機（100ms）= 1リクエスト ~200ms

  計測対象:
  - RPS（Requests Per Second）
  - P99 Latency（99パーセンタイル）
  - エラー率
  - CPU使用率（別途 top/Activity Monitor で確認）

  結果の見方:
  - P99 Latency が 300ms 以下 → ボトルネックなし（I/O中心）
  - P99 Latency が 500ms 以上 → CPU またはコネクション競合あり
  - エラー率 > 1% → サーバーが限界に達している

  次のステップ:
  1. プロファイラで詳細計測
     - Ruby: stackprof
     - Node.js: clinic.js
     - Go: pprof

  2. チューニング実施
     - Ruby: Process 数増加 / YJIT有効化
     - Node.js: worker_threads 導入
     - Go: Goroutine Pool 制御

  3. 再計測でビフォーアフター比較
  `);

  return {};
}
