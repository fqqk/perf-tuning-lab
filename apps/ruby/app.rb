require 'sinatra'
require 'json'
require 'logger'
require 'sequel'

# ============================================================
# Chaos Tuning Lab - Ruby (Sinatra) Implementation
# ============================================================

logger = Logger.new(STDOUT)
logger.level = Logger::INFO

set :port, 3000
set :bind, '0.0.0.0'
set :logging, true

# ============================================================
# PostgreSQL Connection Pool: Scenario 2 用
# ============================================================

$db = Sequel.connect(
  "postgres://#{ENV['DB_USER'] || 'chaos_user'}:#{ENV['DB_PASSWORD'] || 'chaos_password'}@#{ENV['DB_HOST'] || 'chaos-postgres'}:#{ENV['DB_PORT'] || 5432}/#{ENV['DB_NAME'] || 'chaos_lab'}",
  max_connections: 20,
  connect_timeout: 2
)

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
# Scenario 2: DB層のボトルネック（Connection Pool / Lock 競合）
# ============================================================

=begin
GET /db-write?user_id=1&amount=100

同一レコードへの並行 UPDATE を実行
- Lock 競合：複数のリクエストが同じ user_id をロック待ち
- Connection Pool 枯渇：接続数不足でタイムアウト

期待値：
- VU 10 で全て user_id=1 を更新 → P95 Latency が大幅悪化（複数 Lock 待ち）
- Connection Pool 限度到達 → タイムアウトエラー増加
=end

get '/db-write' do
  start_time = Time.now

  begin
    user_id = (params[:user_id] || 1).to_i
    amount = (params[:amount] || 100).to_i

    $db.transaction(isolation: :committed) do
      # この行をロック（他のトランザクションは待機）
      user = $db['SELECT id, balance FROM users WHERE id = ? FOR UPDATE', user_id].first

      if user.nil?
        return [404, { 'Content-Type' => 'application/json' }, { error: 'User not found' }.to_json]
      end

      current_balance = user[:balance]

      # ロック保持時間を意図的に延ばす（Lock 競合を観察するため）
      sleep(0.1)

      # 更新実行
      $db['UPDATE users SET balance = ? WHERE id = ?', current_balance - amount, user_id].update

      content_type :json
      {
        status: 'ok',
        user_id: user_id,
        previous_balance: current_balance,
        new_balance: current_balance - amount,
        total_time_ms: ((Time.now - start_time) * 1000).round
      }.to_json
    end
  rescue Sequel::DatabaseDisconnectError => e
    logger.error("DB connection error: #{e.message}")
    status 500
    content_type :json
    { error: 'Connection timeout', code: 'CONNECTION_TIMEOUT' }.to_json
  rescue Sequel::DatabaseError => e
    wrapped = e.wrapped_exception
    code = wrapped.respond_to?(:error_number) ? wrapped.error_number : nil
    logger.error("DB error: #{e.message}")
    status 500
    content_type :json
    { error: e.message, code: code }.to_json
  rescue => e
    logger.error("Error: #{e.message}")
    status 500
    content_type :json
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
