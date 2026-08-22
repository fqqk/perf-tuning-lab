# Chaos Tuning Lab - Puma Configuration

# サーバー設定
bind "tcp://0.0.0.0:3000"
port 3000

# ワーカー設定（Process数）
# ベースライン: 1 Process
# チューニング v1: 4 Process → GVL を複数プロセスで分散
# チューニング v2: 8 Process → GVL をさらに分散（実験的）
workers 8

# スレッド設定
# ベースライン: デフォルト（0-5）
# チューニング: min 4, max 16 → 高並行に対応
threads 4, 16

# 環境
environment ENV.fetch("RAILS_ENV") { "development" }

