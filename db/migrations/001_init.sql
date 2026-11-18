-- Royal Bites — skema awal database (MySQL 8.0, InnoDB, utf8mb4).
-- Semua waktu disimpan dalam UTC. Semua uang disimpan sebagai bilangan bulat Rupiah.

-- ---------------------------------------------------------------
-- Produk
-- ---------------------------------------------------------------
CREATE TABLE products (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120)  NOT NULL,
  description   VARCHAR(500)  NOT NULL DEFAULT '',
  price         INT UNSIGNED  NOT NULL,
  image         VARCHAR(255)  NULL COMMENT 'Path gambar, mis. /uploads/abc.jpg atau /images/products/x.jpeg',
  category      VARCHAR(40)   NOT NULL,
  stock         INT UNSIGNED  NOT NULL DEFAULT 0,
  is_available  TINYINT(1)    NOT NULL DEFAULT 1,
  deleted_at    DATETIME      NULL COMMENT 'Soft delete: produk lama tetap ada demi riwayat pesanan',
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_products_category (category),
  KEY idx_products_deleted (deleted_at),
  CONSTRAINT chk_products_price CHECK (price > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------
-- Admin & sesi login
-- ---------------------------------------------------------------
CREATE TABLE admin_users (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(50)  NOT NULL,
  password_hash  VARCHAR(100) NOT NULL COMMENT 'bcrypt — password asli tidak pernah disimpan',
  role           ENUM('owner','staff') NOT NULL DEFAULT 'staff',
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at  DATETIME     NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_sessions (
  id             CHAR(64)     NOT NULL COMMENT 'SHA-256 dari token cookie (token asli tidak disimpan)',
  admin_user_id  INT UNSIGNED NOT NULL,
  csrf_token     CHAR(64)     NOT NULL,
  ip_address     VARCHAR(45)  NULL,
  user_agent     VARCHAR(255) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_admin_sessions_user (admin_user_id),
  KEY idx_admin_sessions_expires (expires_at),
  CONSTRAINT fk_admin_sessions_user FOREIGN KEY (admin_user_id) REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------
-- Pesanan
-- ---------------------------------------------------------------
CREATE TABLE orders (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_number        VARCHAR(24)  NOT NULL COMMENT 'Nomor pesanan untuk pelanggan, mis. RB-261009-K7P2M',
  idempotency_key     CHAR(36)     NOT NULL COMMENT 'UUID dari browser agar klik/retry berulang tidak membuat pesanan ganda',
  request_hash        CHAR(64)     NOT NULL COMMENT 'Sidik jari isi permintaan, untuk mendeteksi pemakaian ulang key dengan isi berbeda',
  customer_name       VARCHAR(100) NOT NULL,
  customer_phone      VARCHAR(20)  NOT NULL COMMENT 'Format 62xxxxxxxxxx',
  delivery_address    VARCHAR(300) NULL,
  fulfillment_method  ENUM('pickup','delivery') NOT NULL,
  customer_notes      VARCHAR(500) NULL,
  subtotal            INT UNSIGNED NOT NULL,
  delivery_fee        INT UNSIGNED NOT NULL DEFAULT 0,
  discount            INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Belum ada fitur promo; selalu 0',
  total               INT UNSIGNED NOT NULL,
  payment_method      ENUM('cod','bank_transfer') NOT NULL,
  payment_status      ENUM('unpaid','paid','refunded') NOT NULL DEFAULT 'unpaid',
  order_status        ENUM('pending','confirmed','preparing','ready','completed','cancelled') NOT NULL DEFAULT 'pending',
  cancel_reason       VARCHAR(255) NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orders_order_number (order_number),
  UNIQUE KEY uq_orders_idempotency_key (idempotency_key),
  KEY idx_orders_status_created (order_status, created_at),
  KEY idx_orders_created (created_at),
  KEY idx_orders_phone (customer_phone),
  CONSTRAINT chk_orders_total CHECK (total = subtotal + delivery_fee - discount)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_items (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id               BIGINT UNSIGNED NOT NULL,
  product_id             INT UNSIGNED    NOT NULL,
  product_name_snapshot  VARCHAR(120)    NOT NULL COMMENT 'Nama saat dipesan (tidak berubah walau produk diedit)',
  unit_price_snapshot    INT UNSIGNED    NOT NULL COMMENT 'Harga saat dipesan',
  quantity               INT UNSIGNED    NOT NULL,
  line_total             INT UNSIGNED    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_items_order_product (order_id, product_id),
  KEY idx_order_items_product (product_id),
  CONSTRAINT fk_order_items_order   FOREIGN KEY (order_id)   REFERENCES orders (id)   ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT chk_order_items_qty CHECK (quantity > 0),
  CONSTRAINT chk_order_items_line CHECK (line_total = unit_price_snapshot * quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Riwayat perubahan pesanan (dibuat, ganti status, ganti status pembayaran).
CREATE TABLE order_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id       BIGINT UNSIGNED NOT NULL,
  event_type     ENUM('created','status','payment') NOT NULL,
  from_value     VARCHAR(30)  NULL,
  to_value       VARCHAR(30)  NOT NULL,
  note           VARCHAR(255) NULL,
  admin_user_id  INT UNSIGNED NULL COMMENT 'NULL jika dibuat oleh pelanggan/sistem',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_order_events_order (order_id, created_at),
  CONSTRAINT fk_order_events_order FOREIGN KEY (order_id)      REFERENCES orders (id)      ON DELETE CASCADE,
  CONSTRAINT fk_order_events_admin FOREIGN KEY (admin_user_id) REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------
-- Pengaturan bisnis & pesan dari formulir kontak
-- ---------------------------------------------------------------
CREATE TABLE settings (
  setting_key    VARCHAR(64) NOT NULL,
  setting_value  TEXT        NOT NULL,
  updated_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contact_messages (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100)  NOT NULL,
  email       VARCHAR(150)  NULL,
  phone       VARCHAR(20)   NULL,
  message     VARCHAR(1000) NOT NULL,
  is_read     TINYINT(1)    NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contact_messages_read (is_read, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
