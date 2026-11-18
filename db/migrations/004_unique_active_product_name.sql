-- Royal Bites — migrasi 004: nama menu aktif tidak boleh ganda.
--
-- Menu yang sudah dihapus (soft delete) boleh memakai nama yang sama dengan menu baru, karena
-- barisnya hanya disimpan demi riwayat pesanan. Karena itu keunikan hanya berlaku untuk menu AKTIF:
-- kolom turunan active_name bernilai nama menu jika belum dihapus, dan NULL jika sudah dihapus
-- (NULL tidak dianggap sama dalam indeks UNIQUE). Perbandingan tidak peka huruf besar/kecil.
--
-- Migrasi ini tidak mengubah/menghapus data. Jika database Anda SUDAH berisi nama menu aktif yang
-- ganda, indeks unik TIDAK dibuat (supaya migrasi tidak gagal) dan hasilnya menampilkan peringatan;
-- aplikasi tetap menolak nama ganda lewat pemeriksaan di kode. Rapikan duplikatnya di dashboard
-- (ubah nama/hapus salah satu), lalu jalankan: ALTER TABLE products ADD UNIQUE KEY uq_products_active_name (active_name);

ALTER TABLE products
  ADD COLUMN active_name VARCHAR(120)
    GENERATED ALWAYS AS (IF(deleted_at IS NULL, name, NULL)) STORED;

SET @duplicate_names := (
  SELECT COUNT(*) FROM (
    SELECT 1 FROM products WHERE deleted_at IS NULL GROUP BY name HAVING COUNT(*) > 1
  ) AS duplicated
);

SET @ddl := IF(
  @duplicate_names = 0,
  'ALTER TABLE products ADD UNIQUE KEY uq_products_active_name (active_name)',
  'SELECT ''PERINGATAN: ada nama menu aktif yang ganda, indeks unik tidak dibuat. Lihat catatan di migrasi 004.'' AS peringatan'
);

PREPARE migration_stmt FROM @ddl;
EXECUTE migration_stmt;
DEALLOCATE PREPARE migration_stmt;
