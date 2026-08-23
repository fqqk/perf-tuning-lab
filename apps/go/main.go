package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	_ "net/http/pprof"
	"os"
	"runtime"
	"runtime/debug"
	"sync"
	"time"

	_ "github.com/lib/pq"
)

// ============================================================
// Chaos Tuning Lab - Go Implementation
// ============================================================

var (
	// グローバルキャッシュ（メモリリーク実験用）
	cache      [][]byte
	cacheMutex sync.Mutex

	startTime = time.Now()

	// PostgreSQL Connection Pool: Scenario 2 用
	db *sql.DB
)

func main() {
	// pprof サーバー起動（ポート6060）
	go func() {
		log.Println(http.ListenAndServe("localhost:6060", nil))
	}()

	// PostgreSQL 接続初期化
	dbHost := os.Getenv("DB_HOST")
	if dbHost == "" {
		dbHost = "chaos-postgres"
	}
	dbPort := os.Getenv("DB_PORT")
	if dbPort == "" {
		dbPort = "5432"
	}
	dbUser := os.Getenv("DB_USER")
	if dbUser == "" {
		dbUser = "chaos_user"
	}
	dbPassword := os.Getenv("DB_PASSWORD")
	if dbPassword == "" {
		dbPassword = "chaos_password"
	}
	dbName := os.Getenv("DB_NAME")
	if dbName == "" {
		dbName = "chaos_lab"
	}

	psqlInfo := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable connect_timeout=5",
		dbHost, dbPort, dbUser, dbPassword, dbName)
	var err error
	db, err = sql.Open("postgres", psqlInfo)
	if err != nil {
		log.Printf("Error: Failed to open PostgreSQL connection: %v\n", err)
		db = nil
	} else {
		db.SetMaxOpenConns(10)
		db.SetMaxIdleConns(2)
		db.SetConnMaxLifetime(time.Minute)

		// Ping to verify connection
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := db.PingContext(ctx); err != nil {
			log.Printf("Error: DB ping failed: %v\n", err)
			db.Close()
			db = nil
		}
		cancel()

		if db != nil {
			log.Println("PostgreSQL connected successfully")
		}
	}

	// HTTP ハンドラー登録
	http.HandleFunc("/cpu-io-mixed", handleCpuIoMixed)
	http.HandleFunc("/db-write", handleDbWrite)
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
// Scenario 2: DB層のボトルネック（Connection Pool / Lock 競合）
// ============================================================

/*
GET /db-write?user_id=1&amount=100

同一レコードへの並行 UPDATE を実行
- Lock 競合：複数のリクエストが同じ user_id をロック待ち
- Connection Pool 枯渇：接続数不足でタイムアウト

期待値：
- VU 10 で全て user_id=1 を更新 → P95 Latency が大幅悪化（複数 Lock 待ち）
- Connection Pool 限度到達 → タイムアウトエラー増加
*/
func handleDbWrite(w http.ResponseWriter, r *http.Request) {
	if db == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "Database not initialized",
		})
		return
	}

	startTime := time.Now()

	userId := 1
	if u := r.URL.Query().Get("user_id"); u != "" {
		fmt.Sscanf(u, "%d", &userId)
	}

	amount := 100
	if a := r.URL.Query().Get("amount"); a != "" {
		fmt.Sscanf(a, "%d", &amount)
	}

	tx, err := db.BeginTx(r.Context(), nil)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": err.Error(),
		})
		return
	}
	defer tx.Rollback()

	// この行をロック（他のトランザクションは待機）
	var id, balance int
	err = tx.QueryRowContext(r.Context(),
		"SELECT id, balance FROM users WHERE id = $1 FOR UPDATE",
		userId).Scan(&id, &balance)
	if err != nil {
		if err == sql.ErrNoRows {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"error": "User not found",
			})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": err.Error(),
		})
		return
	}

	// ロック保持時間を意図的に延ばす（Lock 競合を観察するため）
	time.Sleep(100 * time.Millisecond)

	// 更新実行
	_, err = tx.ExecContext(r.Context(),
		"UPDATE users SET balance = $1 WHERE id = $2",
		balance-amount, userId)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": err.Error(),
		})
		return
	}

	// コミット
	err = tx.Commit()
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": err.Error(),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":            "ok",
		"user_id":           userId,
		"previous_balance":  balance,
		"new_balance":       balance - amount,
		"total_time_ms":     time.Since(startTime).Milliseconds(),
		"current_goroutine": runtime.NumGoroutine(),
	})
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
