// Mengisi menu awal secara IDEMPOTEN (aman dijalankan berulang kali).
//
// Aturan:
//  - Kunci pencocokan = NAMA menu (tidak peka huruf besar/kecil, ikut aturan collation database).
//  - Menu yang sudah ada (aktif) TIDAK diubah sama sekali, jadi edit pemilik (harga, foto, stok) aman.
//  - Menu yang pernah dihapus pemilik tidak dimunculkan lagi, kecuali restoreDeleted = true.
//  - Tidak pernah menghapus data dan tidak menyentuh tabel pesanan.
//  - Stok tidak dihitung (track_stock = 0) karena jumlah stok sebenarnya belum diketahui.
import { CATEGORY_VALUES, IMAGE_PATH_PATTERN } from '../config/constants.js';

/** Memeriksa bentuk data seed. Melempar Error berisi daftar masalah jika ada yang salah. */
export function validateSeedProducts(products) {
  const problems = [];
  const seen = new Set();
  if (!Array.isArray(products) || products.length === 0) problems.push('Daftar seed kosong atau bukan array.');
  for (const [index, product] of (Array.isArray(products) ? products : []).entries()) {
    const label = `#${index + 1} ${JSON.stringify(product?.name)}`;
    if (typeof product?.name !== 'string' || product.name.trim().length < 2 || product.name.length > 120) {
      problems.push(`${label}: nama tidak valid.`);
      continue;
    }
    const key = product.name.trim().toLowerCase();
    if (seen.has(key)) problems.push(`${label}: nama ganda di file seed.`);
    seen.add(key);
    if (!Number.isInteger(product.price) || product.price < 1) problems.push(`${label}: harga harus bilangan bulat > 0.`);
    if (!CATEGORY_VALUES.includes(product.category)) problems.push(`${label}: kategori "${product.category}" tidak dikenal.`);
    if (product.image !== null && product.image !== undefined && !IMAGE_PATH_PATTERN.test(product.image)) {
      problems.push(`${label}: path gambar tidak valid.`);
    }
    if (typeof product.description === 'string' && product.description.length > 500) {
      problems.push(`${label}: deskripsi lebih dari 500 karakter.`);
    }
  }
  if (problems.length > 0) throw new Error(`Data seed tidak valid:\n- ${problems.join('\n- ')}`);
}

/**
 * @returns {Promise<{inserted: string[], existing: string[], skippedDeleted: string[], restored: string[]}>}
 */
export async function seedProducts(db, products, { restoreDeleted = false } = {}) {
  validateSeedProducts(products);
  const result = { inserted: [], existing: [], skippedDeleted: [], restored: [] };

  for (const product of products) {
    const name = product.name.trim();
    const [rows] = await db.execute(
      'SELECT id, deleted_at FROM products WHERE name = ? ORDER BY deleted_at IS NOT NULL, id LIMIT 1',
      [name],
    );
    const match = rows[0];

    if (match && match.deleted_at === null) {
      result.existing.push(name);
      continue;
    }
    if (match) {
      if (!restoreDeleted) {
        result.skippedDeleted.push(name);
        continue;
      }
      await db.execute('UPDATE products SET deleted_at = NULL, is_available = 1 WHERE id = ? AND deleted_at IS NOT NULL', [match.id]);
      result.restored.push(name);
      continue;
    }

    try {
      await db.execute(
        `INSERT INTO products (name, description, price, image, category, stock, track_stock, is_available)
         VALUES (?, ?, ?, ?, ?, 0, 0, 1)`,
        [name, product.description ?? '', product.price, product.image ?? null, product.category],
      );
      result.inserted.push(name);
    } catch (error) {
      // Dua proses seed berjalan bersamaan: yang kalah balapan cukup menganggap menu itu sudah ada.
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      result.existing.push(name);
    }
  }
  return result;
}

/** Ringkasan kondisi katalog: jumlah menu aktif dan nama yang ganda (jika indeks unik belum terpasang). */
export async function inspectCatalog(db) {
  const [[{ active }]] = await db.query('SELECT COUNT(*) AS active FROM products WHERE deleted_at IS NULL');
  const [duplicates] = await db.query(
    `SELECT MIN(name) AS name, COUNT(*) AS total FROM products
      WHERE deleted_at IS NULL GROUP BY name HAVING COUNT(*) > 1`,
  );
  const [byCategory] = await db.query(
    'SELECT category, COUNT(*) AS total FROM products WHERE deleted_at IS NULL GROUP BY category ORDER BY category',
  );
  return { active, duplicates, byCategory };
}
