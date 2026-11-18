// Akses data produk. Semua query memakai parameter (?) — tidak ada penggabungan string dari input.
import { conflict, notFound } from '../utils/errors.js';
import { escapeLike } from '../utils/validation.js';

const PRODUCT_COLUMNS =
  'id, name, description, price, image, category, stock, track_stock, is_available, deleted_at, created_at, updated_at';

function toProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    image: row.image,
    category: row.category,
    stock: row.stock,
    track_stock: Boolean(row.track_stock),
    is_available: Boolean(row.is_available),
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Status tampilan untuk pelanggan: tersedia / habis / tidak tersedia. */
function availabilityOf(product) {
  if (!product.is_available) return 'unavailable';
  if (product.track_stock && product.stock <= 0) return 'sold_out';
  return 'available';
}

/** Daftar menu untuk pengunjung (produk yang dihapus tidak ditampilkan). */
export async function listPublicProducts(db) {
  const [rows] = await db.query(
    `SELECT ${PRODUCT_COLUMNS} FROM products WHERE deleted_at IS NULL ORDER BY category, id`,
  );
  return rows.map((row) => {
    const product = toProduct(row);
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      price: product.price,
      image: product.image,
      category: product.category,
      // Jumlah stok hanya dikirim jika stok dihitung; selain itu null (tanpa batas).
      stock: product.track_stock ? product.stock : null,
      availability: availabilityOf(product),
    };
  });
}

/** Daftar produk untuk dashboard admin. */
export async function listAdminProducts(db, { includeDeleted = false, search = '', category = '' } = {}) {
  const conditions = [];
  const params = [];
  if (!includeDeleted) conditions.push('deleted_at IS NULL');
  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (search) {
    conditions.push("name LIKE ? ESCAPE '\\\\'");
    params.push(`%${escapeLike(search)}%`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [rows] = await db.query(`SELECT ${PRODUCT_COLUMNS} FROM products ${where} ORDER BY deleted_at IS NOT NULL, category, id`, params);
  return rows.map(toProduct);
}

export async function getProductById(db, id, { includeDeleted = false } = {}) {
  const [rows] = await db.execute(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`, [id]);
  if (rows.length === 0 || (!includeDeleted && rows[0].deleted_at)) throw notFound('Produk tidak ditemukan.');
  return toProduct(rows[0]);
}

const duplicateNameError = (name) =>
  conflict('DUPLICATE_NAME', `Sudah ada menu aktif bernama "${name}". Gunakan nama lain.`, {
    fields: { name: 'Nama menu sudah dipakai menu lain.' },
  });

/** Nama menu aktif harus unik (tidak peka huruf besar/kecil). exceptId = produk yang sedang diedit. */
async function assertNameAvailable(db, name, exceptId = null) {
  const [rows] = await db.execute(
    'SELECT id FROM products WHERE name = ? AND deleted_at IS NULL AND id <> ? LIMIT 1',
    [name, exceptId ?? 0],
  );
  if (rows.length > 0) throw duplicateNameError(name);
}

/** Indeks unik database (migrasi 004) adalah penjaga terakhir jika dua admin menyimpan nama sama bersamaan. */
function translateDuplicate(error, name) {
  if (error.code === 'ER_DUP_ENTRY' && String(error.sqlMessage).includes('uq_products_active_name')) {
    throw duplicateNameError(name);
  }
  throw error;
}

export async function createProduct(db, data) {
  await assertNameAvailable(db, data.name);
  let insertId;
  try {
    const [result] = await db.execute(
      `INSERT INTO products (name, description, price, image, category, stock, track_stock, is_available)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.description,
        data.price,
        data.image,
        data.category,
        data.stock,
        data.track_stock ? 1 : 0,
        data.is_available ? 1 : 0,
      ],
    );
    insertId = result.insertId;
  } catch (error) {
    translateDuplicate(error, data.name);
  }
  return getProductById(db, insertId);
}

// Kolom yang boleh diubah lewat API (daftar putih), mencegah mass-assignment.
const UPDATABLE_COLUMNS = ['name', 'description', 'price', 'image', 'category', 'stock', 'track_stock', 'is_available'];
const BOOLEAN_COLUMNS = new Set(['track_stock', 'is_available']);

export async function updateProduct(db, id, patch) {
  await getProductById(db, id); // 404 jika tidak ada / sudah dihapus
  if (Object.hasOwn(patch, 'name')) await assertNameAvailable(db, patch.name, id);
  const assignments = [];
  const params = [];
  for (const column of UPDATABLE_COLUMNS) {
    if (Object.hasOwn(patch, column)) {
      assignments.push(`${column} = ?`);
      params.push(BOOLEAN_COLUMNS.has(column) ? (patch[column] ? 1 : 0) : patch[column]);
    }
  }
  if (assignments.length > 0) {
    try {
      await db.execute(`UPDATE products SET ${assignments.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
    } catch (error) {
      translateDuplicate(error, patch.name);
    }
  }
  return getProductById(db, id);
}

/**
 * Hapus produk = soft delete. Baris tetap ada karena riwayat pesanan merujuk ke produk ini,
 * tetapi produk hilang dari menu dan tidak bisa dipesan lagi.
 */
export async function softDeleteProduct(db, id) {
  await getProductById(db, id);
  await db.execute('UPDATE products SET deleted_at = UTC_TIMESTAMP(), is_available = 0 WHERE id = ? AND deleted_at IS NULL', [id]);
}
