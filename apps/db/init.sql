-- Chaos Tuning Lab: Scenario 2 テーブル定義
-- Connection Pool / Lock 競合を観察

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  balance INTEGER NOT NULL DEFAULT 1000,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- テストデータ挿入
-- 複数の user_id へのロック競合を観察するため、複数ユーザー作成
INSERT INTO users (id, name, balance) VALUES
  (1, 'alice', 1000),
  (2, 'bob', 1000),
  (3, 'charlie', 1000),
  (4, 'david', 1000),
  (5, 'eve', 1000);

-- インデックス作成（PK以外は明示的に）
CREATE INDEX idx_users_name ON users(name);

-- トリガー: updated_at 自動更新
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_update_timestamp
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();
