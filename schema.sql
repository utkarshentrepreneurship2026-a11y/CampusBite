CREATE TABLE IF NOT EXISTS customers (
  id BIGSERIAL PRIMARY KEY,
  customer_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  year TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Student',
  password_hash TEXT NOT NULL,
  wallet_balance NUMERIC(12,2) NOT NULL DEFAULT 1250,
  cashback NUMERIC(12,2) NOT NULL DEFAULT 75,
  autopay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  autopay_threshold NUMERIC(12,2) NOT NULL DEFAULT 200,
  autopay_amount NUMERIC(12,2) NOT NULL DEFAULT 500,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS staff_users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  shop TEXT NOT NULL,
  staff_code TEXT UNIQUE,
  account_type TEXT NOT NULL DEFAULT 'Teacher',
  pin_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  shop TEXT NOT NULL,
  items JSONB NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  slot TEXT NOT NULL,
  status SMALLINT NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prep_started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_customer_created_idx ON orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_shop_created_idx ON orders(shop, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_shop_status_idx ON orders(shop, status);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  icon TEXT NOT NULL,
  title TEXT NOT NULL,
  sub TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_tx_customer_created_idx ON wallet_transactions(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  shop TEXT NOT NULL,
  name TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  available BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS price NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS stock INTEGER;


ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'Student';
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS staff_code TEXT UNIQUE;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'Teacher';

CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
