// Mengisi 30 menu awal Royal Bites dari db/seeds/products.json:  npm run seed:products
//
// IDEMPOTEN: aman dijalankan berulang kali.
//  - Menu dicocokkan berdasarkan NAMA. Menu yang sudah ada tidak diubah (edit pemilik aman),
//    menu yang belum ada ditambahkan. Hasil akhir tidak pernah menggandakan menu.
//  - Menu yang sudah dihapus pemilik tidak dimunculkan lagi, kecuali dijalankan dengan:
//        npm run seed:products -- --restore-deleted
//  - Tidak ada data yang dihapus; tabel pesanan tidak disentuh.
//  - Stok tidak dihitung (track_stock = 0) karena jumlah stok sebenarnya belum diketahui.
//    Pemilik bisa mengaktifkan hitung stok per produk di dashboard admin.
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { PROJECT_ROOT, assertRunnable, loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { inspectCatalog, seedProducts, validateSeedProducts } from '../src/services/seedService.js';

dotenv.config({ quiet: true });

const restoreDeleted = process.argv.includes('--restore-deleted');
const config = loadConfig();
const pool = createPool(config.db);

try {
  assertRunnable(config);
  const seedFile = path.join(PROJECT_ROOT, 'db', 'seeds', 'products.json');
  const products = JSON.parse(await fs.readFile(seedFile, 'utf8'));
  validateSeedProducts(products);
  for (const product of products) {
    if (product.image) await fs.access(path.join(config.publicDir, product.image)); // file gambarnya harus ada
  }

  const result = await seedProducts(pool, products, { restoreDeleted });
  console.log(`Menu baru ditambahkan : ${result.inserted.length}`);
  console.log(`Sudah ada (dilewati)  : ${result.existing.length}`);
  if (result.restored.length > 0) console.log(`Ditampilkan lagi      : ${result.restored.length} (${result.restored.join(', ')})`);
  if (result.skippedDeleted.length > 0) {
    console.log(
      `Dilewati karena pernah dihapus pemilik: ${result.skippedDeleted.join(', ')}\n` +
        '  (jalankan dengan --restore-deleted jika ingin menampilkannya lagi)',
    );
  }

  const catalog = await inspectCatalog(pool);
  console.log(`\nMenu aktif sekarang   : ${catalog.active} (target katalog awal: ${products.length})`);
  console.log(`Per kategori          : ${catalog.byCategory.map((row) => `${row.category}=${row.total}`).join(', ')}`);
  if (catalog.duplicates.length > 0) {
    console.log(`PERINGATAN: ada nama menu aktif ganda: ${catalog.duplicates.map((row) => `${row.name} (${row.total}x)`).join(', ')}`);
    process.exitCode = 1;
  }
  const withoutPhoto = products.filter((p) => !p.image).length;
  if (withoutPhoto > 0) {
    console.log(`\nCatatan: ${withoutPhoto} menu belum punya foto sendiri dan memakai gambar pengganti per kategori.`);
    console.log('Unggah foto asli di dashboard admin -> Produk -> Ubah (lihat README bagian "Katalog 30 menu").');
  }
} catch (error) {
  console.error(`Seed gagal: ${error.sqlMessage || error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
