-- Schema des Pizza-Shops.
-- Integritätsregeln liegen bewusst (auch) in der Datenbank: selbst wenn die Anwendung
-- einen Fehler hat, kann z.B. kein negativer Bestand oder Preis gespeichert werden.

CREATE TABLE products (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(80)  NOT NULL UNIQUE,
  description  VARCHAR(500) NOT NULL DEFAULT '',
  category     TEXT         NOT NULL CHECK (category IN ('pizza', 'drink', 'dessert')),
  price_cents  INTEGER      NOT NULL CHECK (price_cents > 0 AND price_cents <= 100000),
  stock        INTEGER      NOT NULL DEFAULT 0 CHECK (stock >= 0 AND stock <= 100000),
  active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX products_active_category_idx ON products (active, category);

CREATE TABLE orders (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nur der SHA-256-Hash des Tracking-Tokens wird gespeichert (DB-Leak => keine gültigen Tokens).
  tracking_token_hash  CHAR(64)    NOT NULL,
  customer_name        VARCHAR(80) NOT NULL,
  street               VARCHAR(120) NOT NULL,
  zip                  CHAR(5)     NOT NULL,
  city                 VARCHAR(80) NOT NULL,
  phone                VARCHAR(20) NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received', 'baking', 'delivering', 'delivered', 'cancelled')),
  total_cents          INTEGER     NOT NULL CHECK (total_cents > 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);

CREATE TABLE order_items (
  order_id          UUID    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products (id),
  quantity          INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX order_items_product_idx ON order_items (product_id);

CREATE TABLE admin_users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(40) NOT NULL UNIQUE,
  password_hash  TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

CREATE TABLE admin_sessions (
  -- SHA-256 des Session-Tokens; das Token selbst existiert nur im Cookie des Browsers.
  token_hash  CHAR(64)    PRIMARY KEY,
  admin_id    INTEGER     NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);
