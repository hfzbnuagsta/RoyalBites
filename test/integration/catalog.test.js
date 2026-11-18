// Test katalog 30 menu: seed idempoten, tidak ada nama ganda, riwayat pesanan aman, dan penjaga nama ganda di admin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CATEGORIES } from '../../src/config/constants.js';
import { inspectCatalog, seedProducts, validateSeedProducts } from '../../src/services/seedService.js';
import { clearData, countRows, createAdmin, orderPayload, prepareDatabase, startTestServer } from '../helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED = JSON.parse(await fs.readFile(path.join(ROOT, 'db', 'seeds', 'products.json'), 'utf8'));

let ctx;
before(async () => {
  ctx = await startTestServer();
  await prepareDatabase(ctx.config);
});
after(() => ctx.stop());
beforeEach(() => clearData(ctx.pool));

const activeNames = async () => (await ctx.pool.query('SELECT name FROM products WHERE deleted_at IS NULL ORDER BY id'))[0].map((row) => row.name);

describe('berkas seed menu', () => {
  test('tepat 30 menu, nama unik (tidak peka huruf besar/kecil), kategori sah, harga & deskripsi wajar', () => {
    assert.equal(SEED.length, 30);
    assert.equal(new Set(SEED.map((product) => product.name.trim().toLowerCase())).size, 30);
    assert.doesNotThrow(() => validateSeedProducts(SEED));
    const perCategory = Object.groupBy(SEED, (product) => product.category);
    assert.deepEqual(Object.fromEntries(Object.entries(perCategory).map(([key, list]) => [key, list.length])), { makanan: 9, minuman: 9, jajanan: 9, paket: 3 });
    for (const product of SEED) {
      assert.ok(product.description.length >= 20, `${product.name}: deskripsi terlalu pendek`);
      assert.ok(product.price >= 1000 && product.price <= 100000, `${product.name}: harga tidak wajar`);
    }
  });

  test('15 menu lama tetap ada dengan nama, harga, dan foto aslinya', () => {
    const original = {
      'Nasi Kentut': 20000, 'Mie Lendir': 15000, 'Nasi Goreng Rempah': 18000, 'Ayam Bakar Nusantara': 22000, 'Seblak Kuah Pedas': 15000,
      'Es Dawet Jembut Kecabut': 10000, 'Es Teh Nusantara': 5000, 'Es Kopi Gula Aren': 12000, 'Wedang Jahe': 8000, 'Es Cendol Durian': 15000,
      'Kue Kontol Kejepit': 2500, 'Kue Peler Bedebu': 10000, 'Ketela Bajingan': 12000, 'Klepon Gula Aren': 8000, 'Pisang Goreng Keju': 10000,
    };
    for (const [name, price] of Object.entries(original)) {
      const found = SEED.find((product) => product.name === name);
      assert.ok(found, `${name} hilang`);
      assert.equal(found.price, price, `${name}: harga berubah`);
    }
    assert.equal(SEED.filter((product) => product.image).length, 6, 'foto asli tidak dikarang untuk menu baru');
  });

  test('semua foto yang dirujuk benar-benar ada; setiap kategori punya gambar pengganti lokal', async () => {
    for (const product of SEED.filter((item) => item.image)) await fs.access(path.join(ROOT, 'public', product.image));
    for (const category of CATEGORIES) await fs.access(path.join(ROOT, 'public', 'images', 'placeholders', `${category.value}.svg`));
    await fs.access(path.join(ROOT, 'public', 'images', 'placeholder.svg'));
    for (const product of SEED.filter((item) => !item.image)) assert.equal(product.image, null, 'tidak ada URL gambar karangan');
  });

  test('validateSeedProducts menolak data cacat', () => {
    const good = { name: 'Menu Uji', category: 'makanan', price: 1000, image: null, description: 'x' };
    assert.throws(() => validateSeedProducts([good, { ...good, name: 'menu uji' }]), /nama ganda/);
    assert.throws(() => validateSeedProducts([{ ...good, category: 'lain' }]), /kategori/);
    assert.throws(() => validateSeedProducts([{ ...good, price: 0 }]), /harga/);
    assert.throws(() => validateSeedProducts([{ ...good, image: 'http://evil.example/x.png' }]), /gambar/);
    assert.throws(() => validateSeedProducts([]), /kosong/);
  });
});

describe('seed ke database: idempoten', () => {
  test('database kosong -> tepat 30 menu aktif; diulang berkali-kali (juga bersamaan) tetap 30 tanpa nama ganda', async () => {
    const first = await seedProducts(ctx.pool, SEED);
    assert.equal(first.inserted.length, 30);
    assert.equal(await countRows(ctx.pool, 'products'), 30);

    for (let i = 0; i < 3; i += 1) {
      const again = await seedProducts(ctx.pool, SEED);
      assert.equal(again.inserted.length, 0);
      assert.equal(again.existing.length, 30);
    }
    await Promise.all(Array.from({ length: 6 }, () => seedProducts(ctx.pool, SEED)));
    const catalog = await inspectCatalog(ctx.pool);
    assert.equal(catalog.active, 30);
    assert.deepEqual(catalog.duplicates, []);
    assert.deepEqual(catalog.byCategory.map((row) => [row.category, row.total]), [['jajanan', 9], ['makanan', 9], ['minuman', 9], ['paket', 3]]);
    const names = await activeNames();
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 30);
  });

  test('seed bersamaan dari database kosong: tidak ada duplikat meski balapan', async () => {
    await Promise.all(Array.from({ length: 5 }, () => seedProducts(ctx.pool, SEED)));
    assert.equal((await inspectCatalog(ctx.pool)).active, 30);
  });

  test('menu lama (15) sudah ada -> hanya 15 yang ditambahkan, yang lama tidak diubah', async () => {
    await seedProducts(ctx.pool, SEED.slice(0, 15));
    await ctx.pool.execute("UPDATE products SET price = 99000, stock = 7, track_stock = 1, image = '/uploads/foto-pemilik.jpg' WHERE name = 'Nasi Kentut'");
    const result = await seedProducts(ctx.pool, SEED);
    assert.equal(result.inserted.length, 15);
    assert.equal((await inspectCatalog(ctx.pool)).active, 30);
    const [[kept]] = await ctx.pool.query("SELECT price, stock, track_stock, image FROM products WHERE name = 'Nasi Kentut'");
    assert.deepEqual({ ...kept }, { price: 99000, stock: 7, track_stock: 1, image: '/uploads/foto-pemilik.jpg' }, 'hasil edit pemilik tidak ditimpa');
  });

  test('menu yang dihapus pemilik tidak dimunculkan lagi, kecuali diminta (--restore-deleted)', async () => {
    await seedProducts(ctx.pool, SEED);
    await ctx.pool.execute("UPDATE products SET deleted_at = UTC_TIMESTAMP(), is_available = 0 WHERE name = 'Wedang Jahe'");
    const skipped = await seedProducts(ctx.pool, SEED);
    assert.deepEqual(skipped.skippedDeleted, ['Wedang Jahe']);
    assert.equal((await inspectCatalog(ctx.pool)).active, 29);
    assert.equal(await countRows(ctx.pool, 'products'), 30, 'tidak ada baris baru');

    const restored = await seedProducts(ctx.pool, SEED, { restoreDeleted: true });
    assert.deepEqual(restored.restored, ['Wedang Jahe']);
    assert.equal((await inspectCatalog(ctx.pool)).active, 30);
    assert.equal(await countRows(ctx.pool, 'products'), 30);
  });

  test('riwayat pesanan aman: seed ulang tidak menyentuh pesanan, item, maupun snapshot harga', async () => {
    await seedProducts(ctx.pool, SEED);
    const [[product]] = await ctx.pool.query("SELECT id, price FROM products WHERE name = 'Soto Ayam Kampung'");
    const client = ctx.client();
    const order = await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 2, price: product.price }]));
    assert.equal(order.status, 201);
    await ctx.pool.execute("UPDATE products SET price = 21000 WHERE id = ?", [product.id]); // pemilik menaikkan harga
    await seedProducts(ctx.pool, SEED);
    await seedProducts(ctx.pool, SEED);

    assert.equal(await countRows(ctx.pool, 'orders'), 1);
    const [[item]] = await ctx.pool.query('SELECT product_id, unit_price_snapshot, quantity FROM order_items');
    assert.deepEqual({ ...item }, { product_id: product.id, unit_price_snapshot: product.price, quantity: 2 });
    assert.equal((await ctx.pool.query('SELECT price FROM products WHERE id = ?', [product.id]))[0][0].price, 21000);
  });

  test('nama dicocokkan tanpa peka huruf besar/kecil dan spasi tepi', async () => {
    await ctx.pool.execute("INSERT INTO products (name, description, price, category) VALUES ('NASI KENTUT', 'dibuat manual', 21000, 'makanan')");
    const result = await seedProducts(ctx.pool, SEED);
    assert.ok(result.existing.includes('Nasi Kentut'));
    assert.equal(result.inserted.length, 29);
  });
});

describe('katalog publik 30 menu', () => {
  test('GET /api/products mengembalikan 30 menu lengkap dengan field yang dibutuhkan kartu menu', async () => {
    await seedProducts(ctx.pool, SEED);
    const { status, data } = await ctx.client().get('/api/products');
    assert.equal(status, 200);
    assert.equal(data.products.length, 30);
    for (const product of data.products) {
      assert.ok(Number.isInteger(product.id));
      assert.ok(product.name && product.description && Number.isInteger(product.price));
      assert.ok(['makanan', 'minuman', 'jajanan', 'paket'].includes(product.category));
      assert.ok(['available', 'sold_out', 'unavailable'].includes(product.availability));
      assert.ok(product.image === null || /^\/images\/products\/.+\.jpe?g$/.test(product.image));
    }
    const config = (await ctx.client().get('/api/config')).data;
    assert.deepEqual(config.categories.map((category) => category.value), ['makanan', 'minuman', 'jajanan', 'paket']);
  });

  test('indikator stok: menu habis & menu nonaktif tampil dengan status yang benar', async () => {
    await seedProducts(ctx.pool, SEED);
    await ctx.pool.execute("UPDATE products SET track_stock = 1, stock = 0 WHERE name = 'Rawon Daging Sapi'");
    await ctx.pool.execute("UPDATE products SET is_available = 0 WHERE name = 'Es Jeruk Peras'");
    const { data } = await ctx.client().get('/api/products');
    const byName = Object.fromEntries(data.products.map((product) => [product.name, product]));
    assert.equal(byName['Rawon Daging Sapi'].availability, 'sold_out');
    assert.equal(byName['Es Jeruk Peras'].availability, 'unavailable');
    assert.equal(byName['Soto Ayam Kampung'].availability, 'available');
  });
});

describe('penjaga nama menu ganda (admin)', () => {
  const productBody = (name) => ({ name, description: 'Deskripsi uji', price: 10000, category: 'makanan' });

  test('tidak bisa membuat menu bernama sama (tidak peka huruf besar/kecil); tidak bisa mengganti nama menjadi nama yang sudah ada', async () => {
    await seedProducts(ctx.pool, SEED);
    await createAdmin(ctx);
    const owner = ctx.client();
    await owner.login();

    const same = await owner.post('/api/admin/products', productBody('nasi kentut'));
    assert.equal(same.status, 409);
    assert.equal(same.data.error.code, 'DUPLICATE_NAME');
    assert.equal((await owner.post('/api/admin/products', productBody('  NASI KENTUT  '))).status, 409);
    assert.equal(await countRows(ctx.pool, 'products'), 30);

    const created = await owner.post('/api/admin/products', productBody('Menu Baru Unik'));
    assert.equal(created.status, 201);
    const rename = await owner.patch(`/api/admin/products/${created.data.product.id}`, { name: 'Mie Lendir' });
    assert.equal(rename.status, 409);
    // mengubah harga menu tanpa mengubah nama tetap boleh
    assert.equal((await owner.patch(`/api/admin/products/${created.data.product.id}`, { price: 11000 })).status, 200);
    // mengganti nama menjadi dirinya sendiri (huruf berbeda) tidak dianggap bentrok
    assert.equal((await owner.patch(`/api/admin/products/${created.data.product.id}`, { name: 'MENU BARU UNIK' })).status, 200);
  });

  test('nama menu yang sudah dihapus boleh dipakai lagi', async () => {
    await createAdmin(ctx);
    const owner = ctx.client();
    await owner.login();
    const first = await owner.post('/api/admin/products', productBody('Menu Sementara'));
    assert.equal((await owner.delete(`/api/admin/products/${first.data.product.id}`)).status, 200);
    assert.equal((await owner.post('/api/admin/products', productBody('Menu Sementara'))).status, 201);
  });

  test('database sendiri menolak nama aktif ganda (indeks unik migrasi 004), tetapi mengizinkan nama dari menu yang dihapus', async () => {
    await ctx.pool.execute("INSERT INTO products (name, description, price, category) VALUES ('Menu X', '', 1000, 'makanan')");
    await assert.rejects(
      ctx.pool.execute("INSERT INTO products (name, description, price, category) VALUES ('menu x', '', 1000, 'makanan')"),
      (error) => error.code === 'ER_DUP_ENTRY' && /uq_products_active_name/.test(error.sqlMessage),
    );
    await ctx.pool.execute("UPDATE products SET deleted_at = UTC_TIMESTAMP() WHERE name = 'Menu X'");
    await ctx.pool.execute("INSERT INTO products (name, description, price, category) VALUES ('Menu X', '', 1000, 'makanan')");
    assert.equal(await countRows(ctx.pool, 'products'), 2);
  });

  test('dua admin menyimpan nama yang sama bersamaan: hanya satu yang berhasil', async () => {
    await createAdmin(ctx);
    const owner = ctx.client();
    await owner.login();
    const responses = await Promise.all(Array.from({ length: 6 }, () => owner.post('/api/admin/products', productBody('Menu Balapan'))));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.ok(responses.every((response) => [201, 409].includes(response.status)));
    assert.equal(await countRows(ctx.pool, 'products'), 1);
  });
});
