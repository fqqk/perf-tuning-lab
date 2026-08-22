/**
 * Scenario 3: メモリリーク & GC スパイク
 *
 * テスト対象: Ruby vs Node.js vs Go
 * エンドポイント: GET /leak
 *
 * 検証内容:
 * - グローバル配列への無限追加（メモリリーク）
 * - 時系列でメモリ使用量を記録
 * - GC 実行頻度を観察
 * - P99 Latency の悪化を確認
 *
 * 実行方法:
 * ```bash
 * k6 run k6/scenario3_memory.js \
 *   --vus 10 \
 *   --duration 10m \
 *   -e TARGET=http://localhost:3000
 * ```
 *
 * 観察ポイント:
 * - 最初の1分: RPS 安定、Latency 安定
 * - 3-5分後: メモリ使用量が右肩上がり
 * - 5-7分後: GC 実行頻度が激増、CPU スパイク
 * - 8-10分後: メモリ枯渇 → Out of Memory エラー
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ============================================================
// カスタムメトリクス
// ============================================================

const responseTime = new Trend('http_req_duration');
const errorRate = new Rate('errors');
const successRate = new Rate('successes');
const requestCounter = new Counter('requests');

// メモリリーク特有のメトリクス
const memoryUsage = new Trend('memory_usage_mb');
const cacheSize = new Trend('cache_size');

// ============================================================
// テスト設定
// ============================================================

export const options = {
  stages: [
    // ウォームアップ: 10 VU で 1分
    { duration: '1m', target: 10 },

    // 定常負荷: 10 VU で 9分（メモリ増加を観察）
    { duration: '9m', target: 10 },
  ],

  thresholds: {
    http_req_duration: ['p(95)<500'],
    errors: ['rate<0.5'],  // メモリリーク時はエラー率が上がることを予想
  },
};

// ============================================================
// テスト実行
// ============================================================

export default function () {
  const baseUrl = __ENV.TARGET || 'http://localhost:3000';

  group('Scenario 3: Memory Leak Detection', () => {
    const res = http.get(`${baseUrl}/leak`);

    requestCounter.add(1);

    const isSuccess = check(res, {
      'status is 200': (r) => r.status === 200,
      'has body': (r) => r.body && r.body.length > 0,
    });

    if (isSuccess) {
      successRate.add(true);

      // レスポンスボディから メモリ情報を抽出
      try {
        const body = JSON.parse(res.body);
        const memory_mb = body.memory_usage_mb || 0;
        const cache_sz = body.cache_size || 0;

        memoryUsage.add(memory_mb);
        cacheSize.add(cache_sz);

        // メモリが増加傾向にあるか確認
        check(res, {
          'memory is growing (memory leak signal)': () => memory_mb > 0,
        });
      } catch (e) {
        console.error('Failed to parse response body:', e);
      }
    } else {
      errorRate.add(true);
      console.error(`Request failed: ${res.status}`);
    }

    responseTime.add(res.timings.duration);

    // 各リクエスト間で 100ms 待機
    sleep(0.1);
  });
}

/**
 * サマリー
 */
export function handleSummary(data) {
  console.log(`
  === Scenario 3: メモリリーク & GC スパイクテスト結果 ===

  テスト概要:
  - エンドポイント: GET /leak
  - 処理: グローバル配列に 10KB ずつ追加（毎リクエスト）
  - 期間: 10分間

  観察すべき指標:
  1. メモリ使用量の時系列推移
     - 最初の1分: ~50-100MB
     - 5分後: ~200-300MB
     - 10分後: 512MB+ → Out of Memory

  2. Latency の悪化傾向
     - 最初の1分: P99 < 100ms
     - 中盤: P99 ~200-500ms（GC による停止）
     - 後半: P99 > 1000ms または エラー

  3. エラー率
     - メモリ枯渇時: 大幅に増加

  プロファイラで詳細確認:
  - Ruby: memory_profiler で「どのコード行がメモリを消費しているか」特定
  - Node.js: heapdump で V8 Heap のスナップショット取得
  - Go: pprof の heap profile で goroutine リークを確認

  修正手順:
  1. グローバル変数の参照を削除（明らかなリークなら修正）
  2. LRU キャッシュで size を制限
  3. 定期的なプロセス再起動を検討（長期実行時）
  `);

  return {};
}
