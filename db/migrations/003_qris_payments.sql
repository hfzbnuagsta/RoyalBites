-- Royal Bites — migrasi 003: pembayaran QRIS lewat payment gateway + pelacakan pesanan.
--
-- Migrasi ini HANYA MENAMBAH / MEMPERLUAS. Tidak ada kolom atau data yang dihapus:
--   * ENUM payment_method & payment_status diperluas (nilai lama tetap valid).
--   * Kolom baru pada orders bernilai NULL untuk pesanan lama (aman).
--   * Tabel baru: payments (satu baris per percobaan pembayaran di gateway)
--                 payment_notifications (log notifikasi/webhook dari gateway, untuk audit & anti-duplikat).
--
-- Status pembayaran DIPISAH dari status pesanan:
--   unpaid    = belum dibayar (metode lama: tunai/transfer manual)
--   pending   = menunggu pembayaran QRIS
--   paid      = pembayaran terverifikasi (QRIS: dikonfirmasi gateway)
--   failed / expired / cancelled = percobaan pembayaran gagal / kedaluwarsa / dibatalkan
--   refunded  = dikembalikan

ALTER TABLE orders
  MODIFY COLUMN payment_method ENUM('cod','bank_transfer','qris') NOT NULL,
  MODIFY COLUMN payment_status ENUM('unpaid','pending','paid','failed','expired','cancelled','refunded')
    NOT NULL DEFAULT 'unpaid',
  ADD COLUMN public_token CHAR(43) NULL
    COMMENT 'Token acak (base64url 256 bit) untuk halaman lacak pesanan. NULL untuk pesanan lama.' AFTER idempotency_key,
  ADD COLUMN paid_at DATETIME NULL
    COMMENT 'Waktu pembayaran terverifikasi (UTC)' AFTER payment_status,
  ADD COLUMN payment_expires_at DATETIME NULL
    COMMENT 'Batas waktu bayar QRIS (UTC). Lewat batas dan belum lunas => pesanan dibatalkan otomatis' AFTER paid_at,
  ADD UNIQUE KEY uq_orders_public_token (public_token),
  ADD KEY idx_orders_payment (payment_status, payment_expires_at),
  ADD KEY idx_orders_paid_at (paid_at);

-- Satu baris = satu percobaan pembayaran (satu transaksi di gateway).
CREATE TABLE payments (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id                 BIGINT UNSIGNED NOT NULL,
  provider                 VARCHAR(20)  NOT NULL COMMENT 'midtrans | mock',
  method                   VARCHAR(20)  NOT NULL DEFAULT 'qris',
  provider_order_id        VARCHAR(64)  NOT NULL COMMENT 'order_id yang dikirim ke gateway (unik per percobaan), mis. RB-261009-K7P2M-1',
  provider_transaction_id  VARCHAR(64)  NULL COMMENT 'Referensi transaksi dari gateway (transaction_id)',
  amount                   INT UNSIGNED NOT NULL COMMENT 'Rupiah bulat; harus sama dengan total pesanan',
  status                   ENUM('pending','paid','failed','expired','cancelled','refunded') NOT NULL DEFAULT 'pending',
  -- Kolom turunan: bernilai 1 hanya saat status "pending". Indeks UNIQUE di bawah membuat database
  -- sendiri menolak dua pembayaran "pending" untuk satu pesanan (NULL tidak dianggap sama).
  pending_flag             TINYINT GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED,
  provider_status          VARCHAR(30)  NULL COMMENT 'transaction_status terakhir dari gateway',
  fraud_status             VARCHAR(30)  NULL,
  qr_url                   VARCHAR(500) NULL COMMENT 'URL gambar QR dari gateway (bukan QR buatan sendiri)',
  qr_string                TEXT         NULL,
  expires_at               DATETIME     NULL,
  paid_at                  DATETIME     NULL,
  last_checked_at          DATETIME     NULL COMMENT 'Terakhir kali status dicek langsung ke gateway',
  failure_reason           VARCHAR(255) NULL,
  review_note              VARCHAR(255) NULL COMMENT 'Catatan perlu tindak lanjut admin (nominal tidak cocok, pembayaran ganda, dll.)',
  created_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_provider_order (provider_order_id),
  UNIQUE KEY uq_payments_provider_txn (provider_transaction_id),
  UNIQUE KEY uq_payments_one_pending (order_id, pending_flag),
  KEY idx_payments_status_expires (status, expires_at),
  KEY idx_payments_order (order_id),
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT chk_payments_amount CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Log setiap notifikasi (webhook) yang tanda tangannya VALID. Notifikasi dengan tanda tangan salah
-- ditolak dan tidak disimpan (hanya dicatat di log server).
CREATE TABLE payment_notifications (
  id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id               BIGINT UNSIGNED NULL,
  provider                 VARCHAR(20)  NOT NULL,
  provider_order_id        VARCHAR(64)  NOT NULL,
  provider_transaction_id  VARCHAR(64)  NULL,
  transaction_status       VARCHAR(30)  NOT NULL,
  status_code              VARCHAR(10)  NULL,
  gross_amount             VARCHAR(24)  NULL,
  dedupe_key               CHAR(64)     NOT NULL COMMENT 'SHA-256 isi notifikasi: kiriman ulang yang identik tidak diproses dua kali',
  outcome                  VARCHAR(40)  NOT NULL COMMENT 'applied | duplicate_status | out_of_order | amount_mismatch | unknown_payment | unsupported_status',
  payload                  JSON         NULL COMMENT 'Isi notifikasi (tanpa signature_key)',
  received_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_notifications_dedupe (dedupe_key),
  KEY idx_payment_notifications_payment (payment_id, received_at),
  KEY idx_payment_notifications_order (provider_order_id),
  CONSTRAINT fk_payment_notifications_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
