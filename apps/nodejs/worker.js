/**
 * Worker Thread: CPU 計算のオフロード
 *
 * メインスレッド（Event Loop）をブロックしないため、
 * CPU バウンド処理を別スレッドで実行
 */

// parentPortは、Worker Thread とメインスレッド間の通信を行うためのオブジェクトです。
const { parentPort } = require('worker_threads');

parentPort.on('message', (message) => {
  if (message.type === 'cpu-compute') {
    // CPU 計算を実行（メインスレッドをブロックしない）
    const startTime = Date.now();
    let result = 0;

    while (Date.now() - startTime < message.durationMs) {
      result += Math.sqrt(Math.random() * 10000);
    }

    // 結果をメインスレッドに返す
    parentPort.postMessage({
      type: 'cpu-compute-result',
      result: result,
      actualDurationMs: Date.now() - startTime
    });
  }
});
