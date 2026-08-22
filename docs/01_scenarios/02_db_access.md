# Scenario 2: DB/データアクセス層の限界

## 概要

**目標:** Database Connection Pool、Lock機構、トランザクション分離レベルがパフォーマンスに与える影響を実測し、DB層のボトルネック特定と改善を習得する

**検証テーマ:** 同一レコードへの**集中した更新**（例: ユーザーのポイント減算）を高並行で実行したとき、Connection Pool枯渇、Lock競合、Deadlock がどのように顕在化するか

---

## 実験設定

### 問題状況

```
User テーブル:
  - id (PK)
  - points (INT) ← 複数リクエストから同時更新

リクエスト: POST /deduct-points?user_id=1&amount=10
  ├─ (1) DB接続取得
  ├─ (2) SELECT points ... FOR UPDATE  （悲観的ロック）
  ├─ (3) points - 10 を計算
  ├─ (4) UPDATE points = ...
  ├─ (5) COMMIT
  └─ (6) DB接続返却
```

k6 で `user_id=1` に対して 100 RPS 以上の更新リクエストを集中させる

---

## 検証テーマ1: Connection Pool 枯渇

### 課題シナリオ

```
AppServer設定: Thread数 = 16
Database接続プール: max_connections = 4
```

**予想される挙動:**
- 最初の4リクエスト → DB接続取得 → 処理
- 5番目のリクエスト → 接続待ちキューに入る
- 大量のリクエストがタイムアウト → エラー率スパイク

**計測項目:**
- Active connection 数（`SELECT COUNT(*) FROM information_schema.processlist`）
- Queue 待ち時間
- Connection Timeout エラー率
- P99/P999 Latency

### チューニングレバー

1. **Pool size 増加**
   ```yaml
   database:
     pool: 20  # 4 → 20 に増加
   ```
   - 効果: 接続待ち削減
   - 代価: DBサーバー側のメモリ・スレッド数消費増加、DB側のチューニング必要

2. **接続タイムアウト値調整**
   ```ruby
   # Ruby on Rails
   database.yml:
     checkout_timeout: 5  # 秒
   ```
   - 効果: キューで待つ時間を制限（長すぎるとエラー、短すぎると成功率低下）

3. **接続の長時間保持を避ける**
   - トランザクション内での重い計算を削減
   - 外部API呼び出しは別スレッド/プロセスへオフロード

---

## 検証テーマ2: Lock 競合と Deadlock

### 課題シナリオA: 悲観的ロック（Pessimistic Lock）

```sql
BEGIN;
SELECT * FROM users WHERE id = 1 FOR UPDATE;  ← 排他ロック取得
-- 計算処理（50ms）
UPDATE users SET points = points - 10 WHERE id = 1;
COMMIT;
```

**予想される挙動:**
- 複数リクエストが同じレコードの `FOR UPDATE` を獲得しようと競合
- ロック待機時間が増加
- P99 Latency スパイク（ロック待ち時間 + 処理時間）

**計測項目:**
- ロック待機時間
- Deadlock 発生回数（`SHOW ENGINE INNODB STATUS`）
- スループット（成功した更新リクエスト数）

### 課題シナリオB: 悲観的ロック + 複合更新（Deadlock リスク）

```ruby
# Thread A
transaction do
  user = User.lock.find(1)          # User ロック
  account = Account.lock.find(1)    # Account ロック待ち
end

# Thread B
transaction do
  account = Account.lock.find(1)    # Account ロック
  user = User.lock.find(1)          # User ロック待ち
  # → Deadlock!
end
```

---

## 検証テーマ3: Lock 機構の選択肢

### A. 悲観的ロック（Pessimistic Lock）

```sql
SELECT * FROM users WHERE id = 1 FOR UPDATE;
```

**メリット:**
- 実装が単純（SQLの `FOR UPDATE` 一行）
- 競合時の挙動が明確

**デメリット:**
- ロック競合でスループット低下
- 高並行での Deadlock リスク

### B. 楽観的ロック（Optimistic Lock）

```ruby
class User < ApplicationRecord
  # version カラムを持つ
  #   UPDATE users SET points = points - 10, version = version + 1 
  #         WHERE id = 1 AND version = 5;
  
  optimistic_locking enabled: true
  
  def deduct_points(amount)
    update!(points: points - amount)
    # 競合: ActiveRecord::StaleObjectError 発生 → リトライ
  end
end
```

**メリット:**
- Lock 待機なし（ノンブロッキング）
- 高並行環境で通常スループット向上

**デメリット:**
- 競合時にリトライ必要（リトライロジックの実装）
- 競合が多いと効率低下

### C. Redis/Cache 層での排他制御

```ruby
# Redis Lua スクリプト
# DECR は アトミック操作
def deduct_points_redis(user_id, amount)
  key = "user:#{user_id}:points"
  result = Redis.decr(key, amount)  # Atomic
  
  raise "Insufficient points" if result < 0
end
```

**メリット:**
- DB よりも応答速度が速い
- スループット向上（DB の Lock 競合なし）

**デメリット:**
- キャッシュ層の管理（一貫性、永続化）
- 複雑な業務ロジックには向かない

---

## 実験フロー

### フェーズ1: ベースライン（デフォルト設定）

```
Pool size: 5 (デフォルト)
Lock機構: 悲観的ロック (FOR UPDATE)
k6負荷: 100 RPS, 2分間
```

**計測:**
- RPS
- P99 Latency
- Connection Timeout エラー
- Deadlock 発生回数

### フェーズ2: Connection Pool 最適化

```
Pool size: 5 → 20 に増加
```

**効果測定:** Timeout エラーが減少したか？Latency改善？

### フェーズ3: Lock 機構の比較

同じ並行負荷で、以下を順番にテスト：

| Lock機構 | 実装例 | 期待される効果 |
|----------|------|-------------|
| 悲観的ロック | `SELECT ... FOR UPDATE` | ベースライン |
| 楽観的ロック | version カラム + リトライ | 低競合なら高速化、高競合なら悪化 |
| Redis | DECR (Atomic) | 最速（DB往復なし）だが実装複雑 |

### フェーズ4: 複合シナリオ（Deadlock テスト）

複数の `user_id` に対して同時更新を行い、Lock 機構別の Deadlock 発生率を比較

---

## 計測・プロファイリング

### MySQL/PostgreSQL 側

```sql
-- アクティブな接続確認
SELECT COUNT(*) FROM information_schema.processlist;

-- ロック待機状況
SHOW ENGINE INNODB STATUS;  -- MySQL

-- スロークエリログ
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.1;
```

### アプリケーション側

**Ruby on Rails:**
```ruby
# ActiveRecord ログで接続・ロック情報確認
ActiveRecord::Base.logger = Logger.new(STDOUT)
```

**Node.js:**
```js
// sequelize の logging
const sequelize = new Sequelize(database, user, password, {
  logging: console.log,
});
```

**Go:**
```go
// database/sql ドライバログ
sql.Open("mysql", dsn + "?maxOpenConns=20&maxIdleConns=5")
```

---

## 期待される学習成果

1. **Connection Pool の重要性を実感**
   - 設定値の「なぜ」が理解できる
   - 本番環境でのサイジング知識

2. **Lock 競合の可視化**
   - 悲観的ロックのボトルネックを計測で確認
   - 楽観的ロックとの比較で、トレードオフ理解

3. **高並行での Deadlock リスク認知**
   - 複合更新時のロック順序の重要性
   - Deadlock の自動検出 → リトライ処理

4. **チューニングレバーの優先順位**
   - Connection Pool 最適化（簡単、効果大）
   - Lock 機構選択（実装の複雑さと効果のバランス）
   - Redis/Cache 層活用（最後の手段、ただし高効率）
