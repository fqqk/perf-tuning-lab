package main

import (
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	_ "net/http/pprof"
	"runtime"
	"runtime/debug"
	"sync"
	"time"
)

// ============================================================
// Chaos Tuning Lab - Go Implementation
// ============================================================

var (
	// グローバルキャッシュ（メモリリーク実験用）
	cache      [][]byte
	cacheMutex sync.Mutex

	startTime = time.Now()
)

func main() {
	// pprof サーバー起動（ポート6060）
	go func() {
		log.Println(http.ListenAndServe("localhost:6060", nil))
	}()

	// HTTP ハンドラー登録
	http.HandleFunc("/cpu-io-mixed", handleCpuIoMixed)
	http.HandleFunc("/leak", handleLeak)
	http.HandleFunc("/serialize-heavy", handleSerializeHeavy)
	http.HandleFunc("/health", handleHealth)

	// サーバー起動
	port := 3000
	log.Printf("Go app starting on port %d", port)
	log.Printf("CPU cores: %d", runtime.NumCPU())
	logMemory()

	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), nil); err != nil {
		log.Fatal(err)
	}
}

// ============================================================
// Scenario 1: CPU計算 + I/O混在処理
// ============================================================

/*
GET /cpu-io-mixed

1. CPU計算（100ms）：複雑な計算
2. I/O待ち（100ms）：time.Sleep
3. レスポンス返却

目的: Go のスケジューラが複数Goroutineを効率的に扱うことを観察
  - 複数リクエストでも CPU を効率的に活用
  - I/O 待機中に他の Goroutine を実行
  - 高並行でもスループット向上
*/
func handleCpuIoMixed(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()

	// (1) CPU計算（100ms相当）
	cpuStart := time.Now()
	result := 0.0
	for time.Since(cpuStart) < 100*time.Millisecond {
		result += cpuIntensiveWork()
	}

	// (2) I/O待ち（100ms相当）
	time.Sleep(100 * time.Millisecond)

	// (3) レスポンス
	totalTime := time.Since(startTime)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "ok",
		"total_time_ms":    totalTime.Milliseconds(),
		"cpu_blocked_ms":   time.Since(cpuStart).Milliseconds(),
		"io_wait_ms":       100,
		"current_goroutine": runtime.NumGoroutine(),
	})
}

// CPU集約的な処理
func cpuIntensiveWork() float64 {
	result := 0.0
	for i := 0; i < 10000; i++ {
		result += math.Sqrt(float64(i))
	}
	return result
}

// ============================================================
// Scenario 3: メモリリーク観察（Goroutine Leak）
// ============================================================

/*
GET /leak

グローバル配列に無限に追加してメモリリークを再現
または、Goroutine を無限に生成してメモリリークを実証
*/
func handleLeak(w http.ResponseWriter, r *http.Request) {
	cacheMutex.Lock()
	// 10KB のデータを毎回追加（メモリリーク）
	cache = append(cache, make([]byte, 10*1024))
	size := len(cache)
	cacheMutex.Unlock()

	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":        "ok",
		"cache_size":    size,
		"memory_heap_mb": m.HeapAlloc / 1024 / 1024,
		"goroutines":    runtime.NumGoroutine(),
	})
}

// ============================================================
// Scenario 4: JSON シリアライズオーバーヘッド
// ============================================================

/*
GET /serialize-heavy

JSON シリアライズのオーバーヘッドを観察
*/
type Report struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	Value     float64   `json:"value"`
	Timestamp time.Time `json:"timestamp"`
	Nested    struct {
		A, B, C, D, E, F, G, H, I, J int `json:"a,b,c,d,e,f,g,h,i,j"`
	} `json:"nested"`
}

func handleSerializeHeavy(w http.ResponseWriter, r *http.Request) {
	size := 5000
	if s := r.URL.Query().Get("size"); s != "" {
		fmt.Sscanf(s, "%d", &size)
	}

	// 大量のオブジェクト生成
	reports := make([]Report, size)
	for i := 0; i < size; i++ {
		reports[i] = Report{
			ID:        i,
			Name:      fmt.Sprintf("report_%d", i),
			Value:     float64(i % 1000),
			Timestamp: time.Now(),
		}
		reports[i].Nested.A = 1
		reports[i].Nested.B = 2
		reports[i].Nested.C = 3
		reports[i].Nested.D = 4
		reports[i].Nested.E = 5
		reports[i].Nested.F = 6
		reports[i].Nested.G = 7
		reports[i].Nested.H = 8
		reports[i].Nested.I = 9
		reports[i].Nested.J = 10
	}

	// JSON シリアライズ（CPU 消費ポイント）
	startSerialize := time.Now()

	w.Header().Set("Content-Type", "application/json")
	response := map[string]interface{}{
		"status":            "ok",
		"count":             len(reports),
		"data":              reports,
		"serialize_time_ms": time.Since(startSerialize).Milliseconds(),
	}
	json.NewEncoder(w).Encode(response)
}

// ============================================================
// ヘルスチェック
// ============================================================

func handleHealth(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":       "healthy",
		"uptime_s":     int(time.Since(startTime).Seconds()),
		"goroutines":   runtime.NumGoroutine(),
		"memory_heap_mb": m.HeapAlloc / 1024 / 1024,
		"memory_sys_mb":  m.Sys / 1024 / 1024,
		"gc_runs":      m.NumGC,
	})
}

// ============================================================
// ユーティリティ
// ============================================================

func logMemory() {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	log.Printf("Memory: Alloc=%vMB, TotalAlloc=%vMB, Sys=%vMB, NumGC=%v",
		m.Alloc/1024/1024, m.TotalAlloc/1024/1024, m.Sys/1024/1024, m.NumGC)
}

// pprof 用のヒント
func init() {
	// GC をより頻繁に実行して、メモリ状況を可視化
	debug.SetGCPercent(50)
}
