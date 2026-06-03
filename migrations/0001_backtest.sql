CREATE TABLE IF NOT EXISTS backtest_markets (
  market_id TEXT PRIMARY KEY,
  interval TEXT NOT NULL CHECK (interval IN ('1h', '15m', '5m')),
  slug TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  winner TEXT,
  source_day TEXT NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backtest_markets_day_interval
  ON backtest_markets (source_day, interval);

CREATE TABLE IF NOT EXISTS backtest_matches (
  dedupe_hash TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  quote_type TEXT NOT NULL CHECK (quote_type IN ('ask', 'bid')),
  executed_at TEXT NOT NULL,
  elapsed_seconds INTEGER NOT NULL,
  price_micros INTEGER NOT NULL,
  shares_micros INTEGER NOT NULL,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id) REFERENCES backtest_markets (market_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_backtest_matches_market_execution
  ON backtest_matches (market_id, executed_at);

CREATE TABLE IF NOT EXISTS backtest_daily_matrices (
  day TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('1h', '15m', '5m')),
  cutoff_minutes INTEGER NOT NULL,
  perspective TEXT NOT NULL CHECK (perspective IN ('yes', 'no')),
  compression TEXT NOT NULL DEFAULT 'gzip',
  matrix_blob BLOB NOT NULL,
  market_count INTEGER NOT NULL DEFAULT 0,
  match_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, interval, cutoff_minutes, perspective)
);

CREATE INDEX IF NOT EXISTS idx_backtest_daily_matrices_lookup
  ON backtest_daily_matrices (day, interval, cutoff_minutes);

CREATE TABLE IF NOT EXISTS backtest_ingestion_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  start_day TEXT NOT NULL,
  end_day TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  market_count INTEGER NOT NULL DEFAULT 0,
  match_count INTEGER NOT NULL DEFAULT 0,
  matrix_count INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT
);
