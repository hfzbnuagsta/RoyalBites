-- Royal Bites — migrasi 002: stok opsional per produk.
--
-- Banyak UMKM membuat makanan sesuai pesanan sehingga tidak menghitung stok.
--   track_stock = 0  -> produk selalu bisa dipesan selama "tersedia" (stok tidak dihitung)
--   track_stock = 1  -> stok dihitung: dikurangi tiap pesanan, dikembalikan saat pesanan dibatalkan
--
-- order_items.stock_deducted mencatat apakah stok benar-benar dikurangi untuk baris itu,
-- sehingga pembatalan hanya mengembalikan stok yang memang pernah dikurangi.

ALTER TABLE products
  ADD COLUMN track_stock TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = stok dihitung; 0 = tanpa batas (dibuat sesuai pesanan)' AFTER stock;

ALTER TABLE order_items
  ADD COLUMN stock_deducted TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = stok dikurangi saat pesanan dibuat' AFTER line_total;

-- Data yang sudah ada sebelum migrasi ini memakai aturan lama (stok selalu dihitung).
UPDATE products    SET track_stock = 1;
UPDATE order_items SET stock_deducted = 1;
