require 'sinatra'
require 'json'
require 'logger'

# ============================================================
# Chaos Tuning Lab - Ruby (Sinatra) Implementation
# ============================================================

logger = Logger.new(STDOUT)
logger.level = Logger::INFO

set :port, 3000
set :bind, '0.0.0.0'
set :logging, true

# グローバルキャッシュ（メモリリーク実験用）
$cache = []

# ============================================================
# Scenario 1: CPU計算 + I/O混在処理
# ============================================================

=begin
GET /cpu-io-mixed

1. CPU計算（100ms）：複雑な計算
2. I/O待ち（100ms）：sleep
3. レスポンス返却

目的: Ruby GVL の影響を観察
  - Thread: 16, Process: 1 → GVL競合でボトルネック
  - Thread: 4, Process: 4 → マルチコア活用でスケール

計測対象:
  - RPS
  - P99 Latency
  - CPU使用率（stackprof）
=end

get '/cpu-io-mixed' do
  start_time = Time.now

  begin
    # (1) CPU計算（100ms相当）
    cpu_start = Time.now
    result = 0
    while (Time.now - cpu_start) < 0.1
      result += Math.sqrt(rand(10000))
    end

    # (2) I/O待ち（100ms相当）
    sleep(0.1)

    # (3) レスポンス
    total_time = Time.now - start_time

    content_type :json
    {
      status: 'ok',
      total_time_s: total_time.round(3),
      cpu_blocked_ms: ((Time.now - cpu_start) * 1000).round,
      io_wait_ms: 100
    }.to_json
  rescue => e
    logger.error(e)
    status 500
    { error: e.message }.to_json
  end
end

# ============================================================
# Scenario 3: メモリリーク観察
# ============================================================

=begin
GET /leak

グローバル配列に無限に追加してメモリリークを再現
=end

get '/leak' do
  # 10KB のデータを毎回追加（メモリリーク）
  $cache << SecureRandom.random_bytes(10 * 1024)

  content_type :json
  {
    status: 'ok',
    cache_size: $cache.length,
    memory_usage_mb: `ps -o rss= -p #{Process.pid}`.strip.to_i / 1024
  }.to_json
end

# ============================================================
# Scenario 4: JSON シリアライズオーバーヘッド
# ============================================================

=begin
GET /serialize-heavy

JSON シリアライズのオーバーヘッドを観察
=end

get '/serialize-heavy' do
  size = (params[:size] || 5000).to_i

  # 大量のオブジェクト生成
  large_data = Array.new(size) do |i|
    {
      id: i,
      name: "report_#{i}",
      value: rand(1000),
      timestamp: Time.now.iso8601,
      nested: {
        a: 1, b: 2, c: 3, d: 4, e: 5,
        f: 6, g: 7, h: 8, i: 9, j: 10
      }
    }
  end

  # JSON シリアライズ（CPU 消費ポイント）
  start_serialize = Time.now
  result = {
    status: 'ok',
    count: large_data.length,
    data: large_data,
    serialize_time_ms: ((Time.now - start_serialize) * 1000).round
  }

  content_type :json
  result.to_json
end

# ============================================================
# ヘルスチェック
# ============================================================

get '/health' do
  content_type :json
  {
    status: 'healthy',
    uptime: Integer(Time.now - $start_time),
    ruby_version: RUBY_VERSION,
    memory_mb: `ps -o rss= -p #{Process.pid}`.strip.to_i / 1024
  }.to_json
end

# ============================================================
# サーバー起動
# ============================================================

$start_time = Time.now

logger.info "Ruby (Sinatra) app loaded"
logger.info "CPU cores: #{`nproc`.strip}"
