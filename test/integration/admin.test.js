// Test integrasi dashboard admin: autentikasi, CSRF, peran, produk, upload, pesanan, pengaturan, laporan.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  ADMIN_PASSWORD,
  clearData,
  countRows,
  createAdmin,
  insertProduct,
  orderPayload,
  prepareDatabase,
  startTestServer,
  stockOf,
} from '../helpers.js';

let ctx;
before(async () => {
  ctx = await startTestServer();
  await prepareDatabase(ctx.config);
});
after(() => ctx.stop());
beforeEach(() => clearData(ctx.pool));

/** Klien yang sudah login sebagai owner (atau role lain). */
async function loggedIn({ username = 'owner', role = 'owner' } = {}) {
  await createAdmin(ctx, { username, role });
  const client = ctx.client();
  const response = await client.login(username);
  assert.equal(response.status, 200);
  return client;
}

async function placeOrder(items, overrides = {}) {
  const publicClient = ctx.client();
  const { status, data } = await publicClient.post('/api/orders', orderPayload(items, overrides));
  assert.equal(status, 201, JSON.stringify(data));
  const [[row]] = await ctx.pool.query('SELECT id FROM orders WHERE order_number = ?', [data.order.order_number]);
  return { ...data.order, id: row.id };
}

// 1x1 piksel PNG valid
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
function imageForm(buffer, name = 'foto.png', type = 'image/png') {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), name);
  return form;
}

describe('autentikasi admin', () => {
  test('semua endpoint admin menolak pengunjung tanpa login (401)', async () => {
    const anon = ctx.client();
    const endpoints = [
      ['GET', '/api/admin/session'],
      ['GET', '/api/admin/summary'],
      ['GET', '/api/admin/products'],
      ['GET', '/api/admin/products/1'],
      ['POST', '/api/admin/products'],
      ['PATCH', '/api/admin/products/1'],
      ['DELETE', '/api/admin/products/1'],
      ['POST', '/api/admin/uploads'],
      ['GET', '/api/admin/orders'],
      ['GET', '/api/admin/orders/1'],
      ['PATCH', '/api/admin/orders/1/status'],
      ['PATCH', '/api/admin/orders/1/payment'],
      ['GET', '/api/admin/settings'],
      ['PUT', '/api/admin/settings'],
      ['GET', '/api/admin/messages'],
      ['PATCH', '/api/admin/messages/1'],
      ['POST', '/api/admin/password'],
      ['POST', '/api/admin/logout'],
    ];
    for (const [method, url] of endpoints) {
      const response = await anon.request(method, url, method === 'GET' ? {} : { json: {} });
      assert.equal(response.status, 401, `${method} ${url} seharusnya 401, dapat ${response.status}`);
      assert.equal(response.data.error.code, 'UNAUTHORIZED');
    }
  });

  test('login benar: cookie HttpOnly + SameSite=Strict, tanpa password/hash di respons', async () => {
    await createAdmin(ctx);
    const response = await ctx.client().post('/api/admin/login', { username: 'owner', password: ADMIN_PASSWORD });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.data.user).sort(), ['id', 'role', 'username']);
    assert.match(response.data.csrf_token, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(response.data).includes('password'));
    const cookie = response.setCookie.find((c) => c.startsWith('rb_admin='));
    assert.ok(cookie, 'cookie sesi harus ada');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });

  test('password disimpan sebagai hash bcrypt dan token sesi disimpan sebagai hash', async () => {
    await createAdmin(ctx);
    const client = ctx.client();
    await client.login();
    const [[user]] = await ctx.pool.query('SELECT password_hash FROM admin_users');
    assert.match(user.password_hash, /^\$2[aby]\$\d\d\$/);
    assert.ok(!user.password_hash.includes(ADMIN_PASSWORD));
    const [[session]] = await ctx.pool.query('SELECT id FROM admin_sessions');
    assert.match(session.id, /^[a-f0-9]{64}$/);
    assert.notEqual(session.id, client.cookies.get('rb_admin'), 'database tidak boleh menyimpan token mentah');
  });

  test('password salah dan username tak dikenal menghasilkan pesan yang sama persis', async () => {
    await createAdmin(ctx);
    const wrongPassword = await ctx.client().post('/api/admin/login', { username: 'owner', password: 'salah-salah-salah' });
    const unknownUser = await ctx.client().post('/api/admin/login', { username: 'tidak-ada', password: 'salah-salah-salah' });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(wrongPassword.data, unknownUser.data);
    assert.equal(wrongPassword.setCookie.length, 0);
  });

  test('payload login berbahaya tidak membuat error server', async () => {
    await createAdmin(ctx);
    for (const body of [{ username: "' OR '1'='1", password: "' OR '1'='1" }, { username: { $ne: null }, password: { $ne: null } }, { username: ['a'], password: 123 }, {}]) {
      const response = await ctx.client().post('/api/admin/login', body);
      assert.ok([400, 401].includes(response.status), `status ${response.status}`);
    }
  });

  test('akun nonaktif tidak bisa login dan sesinya langsung tidak berlaku', async () => {
    await createAdmin(ctx);
    const client = ctx.client();
    assert.equal((await client.login()).status, 200);
    await ctx.pool.query('UPDATE admin_users SET is_active = 0');
    assert.equal((await client.get('/api/admin/session')).status, 401);
    assert.equal((await ctx.client().login()).status, 401);
  });

  test('logout menghapus sesi di server (cookie lama tidak bisa dipakai lagi)', async () => {
    const client = await loggedIn();
    const stolenCookie = client.cookies.get('rb_admin');
    assert.equal((await client.post('/api/admin/logout', {})).status, 200);
    const replay = ctx.client();
    replay.cookies.set('rb_admin', stolenCookie);
    assert.equal((await replay.get('/api/admin/session')).status, 401);
    assert.equal(await countRows(ctx.pool, 'admin_sessions'), 0);
  });

  test('sesi kedaluwarsa dan sesi idle ditolak', async () => {
    const client = await loggedIn();
    await ctx.pool.query('UPDATE admin_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE)');
    assert.equal((await client.get('/api/admin/session')).status, 401);

    const client2 = await loggedIn({ username: 'owner2' });
    await ctx.pool.query('UPDATE admin_sessions SET last_seen_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3 HOUR)');
    assert.equal((await client2.get('/api/admin/session')).status, 401);
  });

  test('cookie dengan format aneh/dipalsukan ditolak', async () => {
    for (const value of ['abc', 'a'.repeat(64), "' OR 1=1 --", '../../etc/passwd']) {
      const client = ctx.client();
      client.cookies.set('rb_admin', value);
      assert.equal((await client.get('/api/admin/session')).status, 401);
    }
  });

  test('ganti password: password lama salah / lemah ditolak; berhasil mengeluarkan perangkat lain', async () => {
    await createAdmin(ctx);
    const laptop = ctx.client();
    const phone = ctx.client();
    await laptop.login();
    await phone.login();

    const wrong = await laptop.post('/api/admin/password', { current_password: 'bukan-ini-passwordnya', new_password: 'PasswordBaruYangKuat-1' });
    assert.equal(wrong.status, 400);
    const weak = await laptop.post('/api/admin/password', { current_password: ADMIN_PASSWORD, new_password: 'pendek' });
    assert.equal(weak.status, 400);

    const changed = await laptop.post('/api/admin/password', { current_password: ADMIN_PASSWORD, new_password: 'PasswordBaruYangKuat-1' });
    assert.equal(changed.status, 200);
    assert.equal((await laptop.get('/api/admin/session')).status, 200);
    assert.equal((await phone.get('/api/admin/session')).status, 401);
    assert.equal((await ctx.client().login('owner', ADMIN_PASSWORD)).status, 401);
    assert.equal((await ctx.client().login('owner', 'PasswordBaruYangKuat-1')).status, 200);
  });
});

describe('perlindungan CSRF dan asal request', () => {
  test('request pengubah data tanpa token CSRF ditolak 403', async () => {
    const client = await loggedIn();
    const response = await client.post('/api/admin/products', { name: 'X', price: 1000, category: 'makanan' }, { csrf: false });
    assert.equal(response.status, 403);
    assert.equal(await countRows(ctx.pool, 'products'), 0);
  });

  test('token CSRF salah ditolak; token milik sesi lain ditolak', async () => {
    const a = await loggedIn({ username: 'owner-a' });
    const b = await loggedIn({ username: 'owner-b' });
    const body = { name: 'Produk', price: 1000, category: 'makanan' };
    assert.equal((await a.post('/api/admin/products', body, { headers: { 'x-csrf-token': 'salah' }, csrf: false })).status, 403);
    assert.equal((await a.post('/api/admin/products', body, { headers: { 'x-csrf-token': b.csrfToken }, csrf: false })).status, 403);
    assert.equal((await a.post('/api/admin/products', body)).status, 201);
  });

  test('request dari situs lain (Origin / Sec-Fetch-Site) ditolak walau cookie & token benar', async () => {
    const client = await loggedIn();
    const body = { name: 'Produk', price: 1000, category: 'makanan' };
    const evilOrigin = await client.post('/api/admin/products', body, { headers: { origin: 'https://evil.example' } });
    assert.equal(evilOrigin.status, 403);
    const crossSite = await client.post('/api/admin/products', body, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const sameOrigin = await client.post('/api/admin/products', body, { headers: { origin: ctx.baseUrl } });
    assert.equal(sameOrigin.status, 201);
  });
});

describe('peran (role) pemilik vs staf', () => {
  test('staf tidak boleh menghapus produk atau mengubah pengaturan, tetapi boleh mengelola pesanan', async () => {
    const owner = await loggedIn({ username: 'pemilik' });
    const staff = await loggedIn({ username: 'kasir', role: 'staff' });
    const product = await insertProduct(ctx.pool, { price: 5000 });

    assert.equal((await staff.delete(`/api/admin/products/${product.id}`)).status, 403);
    assert.equal((await staff.put('/api/admin/settings', { business_name: 'Diubah Staf' })).status, 403);
    assert.equal((await staff.get('/api/admin/settings')).status, 200);

    const order = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    assert.equal((await staff.patch(`/api/admin/orders/${order.id}/status`, { status: 'confirmed' })).status, 200);

    assert.equal((await owner.put('/api/admin/settings', { business_name: 'Royal Bites Pusat' })).status, 200);
    assert.equal((await owner.delete(`/api/admin/products/${product.id}`)).status, 200);
  });
});

describe('produk (admin)', () => {
  test('tambah, lihat, ubah sebagian, dan hapus (soft delete) produk', async () => {
    const owner = await loggedIn();
    const created = await owner.post('/api/admin/products', {
      name: '  Nasi Goreng Spesial  ',
      description: 'Enak',
      price: 18000,
      category: 'makanan',
      stock: 7,
      track_stock: true,
    });
    assert.equal(created.status, 201);
    const id = created.data.product.id;
    assert.equal(created.data.product.name, 'Nasi Goreng Spesial'); // di-trim
    assert.equal(created.data.product.track_stock, true);
    assert.equal(created.data.product.is_available, true);

    const updated = await owner.patch(`/api/admin/products/${id}`, { price: 20000, is_available: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.product.price, 20000);
    assert.equal(updated.data.product.name, 'Nasi Goreng Spesial');

    // tidak tampil sebagai tersedia di menu publik
    const publicList = await ctx.client().get('/api/products');
    assert.equal(publicList.data.products[0].availability, 'unavailable');

    assert.equal((await owner.delete(`/api/admin/products/${id}`)).status, 200);
    assert.equal((await ctx.client().get('/api/products')).data.products.length, 0);
    assert.equal((await owner.get(`/api/admin/products/${id}`)).status, 404);
    assert.equal((await owner.patch(`/api/admin/products/${id}`, { price: 1 })).status, 404);
    assert.equal(await countRows(ctx.pool, 'products'), 1, 'baris tetap ada demi riwayat pesanan');
  });

  test('riwayat pesanan tetap utuh setelah produknya dihapus', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { name: 'Es Teh', price: 5000 });
    const order = await placeOrder([{ product_id: product.id, quantity: 2, price: 5000 }]);
    await owner.delete(`/api/admin/products/${product.id}`);
    const detail = await owner.get(`/api/admin/orders/${order.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.order.items[0].name, 'Es Teh');
    assert.equal(detail.data.order.total, 10000);
  });

  test('validasi produk di server', async () => {
    const owner = await loggedIn();
    const valid = { name: 'Produk', price: 1000, category: 'makanan' };
    const invalid = [
      { ...valid, name: '' },
      { ...valid, name: 'x'.repeat(121) },
      { ...valid, price: 0 },
      { ...valid, price: -5 },
      { ...valid, price: '1000' },
      { ...valid, price: 1.5 },
      { ...valid, price: 99_999_999_999 },
      { ...valid, category: 'elektronik' },
      { ...valid, stock: -1 },
      { ...valid, is_available: 'ya' },
      { ...valid, image: 'https://evil.example/x.jpg' },
      { ...valid, image: '/uploads/../../etc/passwd' },
      { ...valid, image: '/uploads/x.svg' },
      { ...valid, image: 'javascript:alert(1)' },
      { ...valid, description: 'x'.repeat(501) },
    ];
    for (const body of invalid) {
      const response = await owner.post('/api/admin/products', body);
      assert.equal(response.status, 400, `harus ditolak: ${JSON.stringify(body).slice(0, 90)}`);
    }
    assert.equal(await countRows(ctx.pool, 'products'), 0);
    assert.equal((await owner.patch('/api/admin/products/1', {})).status, 400);
    assert.equal((await owner.patch('/api/admin/products/abc', { price: 1 })).status, 400);
  });

  test('mass-assignment: kolom yang tidak boleh diubah diabaikan', async () => {
    const owner = await loggedIn();
    const { data } = await owner.post('/api/admin/products', { name: 'Produk', price: 1000, category: 'makanan', id: 777, deleted_at: '2020-01-01', created_at: '2000-01-01' });
    assert.notEqual(data.product.id, 777);
    assert.equal(data.product.deleted_at, null);
  });

  test('pencarian produk dengan karakter SQL/wildcard tidak error dan tidak berfungsi sebagai wildcard', async () => {
    const owner = await loggedIn();
    await insertProduct(ctx.pool, { name: 'Es Teh' });
    await insertProduct(ctx.pool, { name: 'Diskon 50% Spesial' });
    const injection = await owner.get(`/api/admin/products?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(injection.status, 200);
    assert.equal(injection.data.products.length, 0);
    const percent = await owner.get(`/api/admin/products?q=${encodeURIComponent('%')}`);
    assert.deepEqual(percent.data.products.map((p) => p.name), ['Diskon 50% Spesial']);
  });
});

describe('upload gambar', () => {
  test('PNG valid diterima, disimpan dengan nama acak, dan dapat diakses', async () => {
    const owner = await loggedIn();
    const response = await owner.request('POST', '/api/admin/uploads', { body: imageForm(PNG_1X1, 'nama-asli-ngawur.exe.png') });
    assert.equal(response.status, 201);
    assert.match(response.data.path, /^\/uploads\/[a-f0-9]{32}\.png$/);
    const served = await fetch(`${ctx.baseUrl}${response.data.path}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    const files = await fs.readdir(ctx.config.uploads.dir);
    assert.equal(files.length, 1);
    assert.ok(!files.some((f) => f.includes('exe')), 'nama asli tidak boleh dipakai');
  });

  test('path hasil upload bisa dipakai sebagai gambar produk', async () => {
    const owner = await loggedIn();
    const { data } = await owner.request('POST', '/api/admin/uploads', { body: imageForm(PNG_1X1) });
    const product = await owner.post('/api/admin/products', { name: 'Produk Foto', price: 1000, category: 'jajanan', image: data.path });
    assert.equal(product.status, 201);
    assert.equal(product.data.product.image, data.path);
  });

  test('HTML/SVG/teks yang menyamar sebagai gambar ditolak 415 (walau Content-Type & ekstensi gambar)', async () => {
    const owner = await loggedIn();
    const filesBefore = (await fs.readdir(ctx.config.uploads.dir).catch(() => [])).length;
    for (const [content, name, type] of [
      ['<html><script>alert(1)</script></html>', 'x.jpg', 'image/jpeg'],
      ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'x.png', 'image/png'],
      ['GIF89a bukan jpeg', 'x.jpeg', 'image/jpeg'],
      ['MZ\x90\x00 program', 'x.png', 'image/png'],
    ]) {
      const response = await owner.request('POST', '/api/admin/uploads', { body: imageForm(Buffer.from(content, 'latin1'), name, type) });
      assert.equal(response.status, 415, `harus ditolak: ${name} ${content.slice(0, 15)}`);
    }
    const after = await fs.readdir(ctx.config.uploads.dir).catch(() => []);
    assert.equal(after.length, filesBefore, 'tidak boleh ada file baru yang tersimpan');
  });

  test('file terlalu besar ditolak 413; tanpa file 400; tanpa CSRF 403', async () => {
    const owner = await loggedIn();
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(ctx.config.uploads.maxBytes + 10)]);
    assert.equal((await owner.request('POST', '/api/admin/uploads', { body: imageForm(big) })).status, 413);
    assert.equal((await owner.request('POST', '/api/admin/uploads', { body: new FormData() })).status, 400);
    assert.equal((await owner.request('POST', '/api/admin/uploads', { body: imageForm(PNG_1X1), csrf: false })).status, 403);
  });

  test('path traversal lewat URL /uploads tidak bisa membaca file di luar folder', async () => {
    for (const probe of ['/uploads/../.env', '/uploads/%2e%2e/.env', '/uploads/..%2f..%2fpackage.json', '/uploads/%2e%2e%2fpackage.json']) {
      const response = await fetch(`${ctx.baseUrl}${probe}`);
      const body = await response.text();
      assert.ok(!body.includes('DB_PASSWORD') && !body.includes('"name": "royal-bites"'), `bocor lewat ${probe}`);
    }
  });
});

describe('manajemen pesanan', () => {
  test('daftar pesanan: filter status, pencarian, paginasi; detail memuat riwayat', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000 });
    const a = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }], { customer_name: 'Andi Wijaya', customer_phone: '081111111111' });
    await placeOrder([{ product_id: product.id, quantity: 2, price: 5000 }], { customer_name: 'Budi Santoso', customer_phone: '082222222222' });
    await owner.patch(`/api/admin/orders/${a.id}/status`, { status: 'confirmed' });

    const all = await owner.get('/api/admin/orders');
    assert.equal(all.data.total, 2);
    assert.equal(all.data.items[0].customer_name, 'Budi Santoso'); // terbaru di atas

    assert.equal((await owner.get('/api/admin/orders?status=confirmed')).data.total, 1);
    assert.equal((await owner.get('/api/admin/orders?q=andi')).data.items[0].order_number, a.order_number);
    assert.equal((await owner.get(`/api/admin/orders?q=${a.order_number.toLowerCase()}`)).data.total, 1);
    assert.equal((await owner.get('/api/admin/orders?q=0811-1111')).data.total, 1, 'nomor format 08xx harus ketemu');
    assert.equal((await owner.get('/api/admin/orders?q=6282222')).data.total, 1, 'awalan 62 juga ketemu');
    assert.equal((await owner.get(`/api/admin/orders?q=${encodeURIComponent("' OR 1=1 --")}`)).data.total, 0);
    assert.equal((await owner.get(`/api/admin/orders?q=${encodeURIComponent('%')}`)).data.total, 0);
    assert.equal((await owner.get('/api/admin/orders?page_size=1&page=2')).data.items.length, 1);
    assert.equal((await owner.get('/api/admin/orders?status=hacked')).status, 400);
    assert.equal((await owner.get('/api/admin/orders?from=2026-13-45&to=2026-01-01')).status, 400);

    const detail = await owner.get(`/api/admin/orders/${a.id}`);
    assert.deepEqual(detail.data.order.events.map((e) => [e.event_type, e.from_value, e.to_value, e.admin_username]), [
      ['created', null, 'pending', null],
      ['status', 'pending', 'confirmed', 'owner'],
    ]);
    assert.equal((await owner.get('/api/admin/orders/999999')).status, 404);
  });

  test('filter tanggal memakai zona waktu bisnis (WIB)', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000 });
    const order = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    // 2026-10-09 23:30 WIB = 16:30 UTC masih tanggal 9; 2026-10-09 17:00 UTC = tanggal 10 WIB
    await ctx.pool.query("UPDATE orders SET created_at = '2026-10-09 16:30:00' WHERE id = ?", [order.id]);
    assert.equal((await owner.get('/api/admin/orders?from=2026-10-09&to=2026-10-09')).data.total, 1);
    assert.equal((await owner.get('/api/admin/orders?from=2026-10-10&to=2026-10-10')).data.total, 0);
    await ctx.pool.query("UPDATE orders SET created_at = '2026-10-09 17:00:00' WHERE id = ?", [order.id]);
    assert.equal((await owner.get('/api/admin/orders?from=2026-10-09&to=2026-10-09')).data.total, 0);
    assert.equal((await owner.get('/api/admin/orders?from=2026-10-10&to=2026-10-10')).data.total, 1);
  });

  test('status hanya boleh maju atau dibatalkan; status akhir terkunci', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000 });
    const order = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    const url = `/api/admin/orders/${order.id}/status`;

    assert.equal((await owner.patch(url, { status: 'hacked' })).status, 400);
    assert.equal((await owner.patch(url, { status: 'pending' })).status, 409); // sama
    assert.equal((await owner.patch(url, { status: 'preparing' })).status, 200); // boleh melompat maju
    assert.equal((await owner.patch(url, { status: 'confirmed' })).status, 409); // tidak boleh mundur
    assert.equal((await owner.patch(url, { status: 'completed' })).status, 200);
    const afterComplete = await owner.patch(url, { status: 'cancelled' });
    assert.equal(afterComplete.status, 409);
    assert.equal(afterComplete.data.error.code, 'INVALID_TRANSITION');
  });

  test('pembatalan mengembalikan stok tracked SEKALI saja (bahkan jika dua admin membatalkan bersamaan)', async () => {
    const ownerA = await loggedIn({ username: 'owner-a' });
    const ownerB = await loggedIn({ username: 'owner-b' });
    const tracked = await insertProduct(ctx.pool, { price: 5000, stock: 10, track_stock: 1 });
    const untracked = await insertProduct(ctx.pool, { price: 3000, stock: 0, track_stock: 0 });
    const order = await placeOrder([
      { product_id: tracked.id, quantity: 4, price: 5000 },
      { product_id: untracked.id, quantity: 2, price: 3000 },
    ]);
    assert.equal(await stockOf(ctx.pool, tracked.id), 6);

    const url = `/api/admin/orders/${order.id}/status`;
    const results = await Promise.all([ownerA.patch(url, { status: 'cancelled', note: 'Pelanggan batal' }), ownerB.patch(url, { status: 'cancelled' })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await stockOf(ctx.pool, tracked.id), 10, 'stok kembali tepat sekali');
    assert.equal(await stockOf(ctx.pool, untracked.id), 0, 'produk tanpa stok tidak boleh bertambah stoknya');

    const again = await ownerA.patch(url, { status: 'cancelled' });
    assert.equal(again.status, 409);
    assert.equal(await stockOf(ctx.pool, tracked.id), 10);
  });

  test('stok yang dikembalikan hanya yang memang pernah dikurangi walau pengaturan produk berubah', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000, stock: 10, track_stock: 0 });
    const order = await placeOrder([{ product_id: product.id, quantity: 3, price: 5000 }]); // tidak mengurangi stok
    await ctx.pool.query('UPDATE products SET track_stock = 1 WHERE id = ?', [product.id]); // pemilik mulai menghitung stok
    await owner.patch(`/api/admin/orders/${order.id}/status`, { status: 'cancelled' });
    assert.equal(await stockOf(ctx.pool, product.id), 10, 'tidak boleh menjadi 13');
  });

  test('status pembayaran: unpaid -> paid -> refunded; pesanan batal tidak bisa lunas', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000 });
    const order = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    const url = `/api/admin/orders/${order.id}/payment`;

    assert.equal((await owner.patch(url, { payment_status: 'refunded' })).status, 409); // belum dibayar
    const paid = await owner.patch(url, { payment_status: 'paid', note: 'Transfer masuk' });
    assert.equal(paid.status, 200);
    assert.equal(paid.data.order.payment_status, 'paid');
    assert.equal((await owner.patch(url, { payment_status: 'refunded' })).status, 200);
    assert.equal((await owner.patch(url, { payment_status: 'paid' })).status, 409); // refunded = akhir

    const other = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    await owner.patch(`/api/admin/orders/${other.id}/status`, { status: 'cancelled' });
    assert.equal((await owner.patch(`/api/admin/orders/${other.id}/payment`, { payment_status: 'paid' })).status, 409);
  });

  test('mengubah status pesanan tidak otomatis menandai lunas', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000 });
    const order = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    const done = await owner.patch(`/api/admin/orders/${order.id}/status`, { status: 'completed' });
    assert.equal(done.data.order.payment_status, 'unpaid');
  });
});

describe('ringkasan dashboard', () => {
  test('angka omzet, terverifikasi, belum dibayar, dan batal dipisahkan dengan benar', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { name: 'Mie Lendir', price: 10000 });
    const other = await insertProduct(ctx.pool, { name: 'Es Teh', price: 5000 });
    const a = await placeOrder([{ product_id: product.id, quantity: 2, price: 10000 }]); // 20.000 pending, belum bayar
    const b = await placeOrder([{ product_id: product.id, quantity: 3, price: 10000 }, { product_id: other.id, quantity: 0 + 0 + 0 + 0, price: 5000 }].slice(0, 1)); // 30.000
    const c = await placeOrder([{ product_id: other.id, quantity: 2, price: 5000 }]); // 10.000
    await owner.patch(`/api/admin/orders/${b.id}/status`, { status: 'completed' });
    await owner.patch(`/api/admin/orders/${b.id}/payment`, { payment_status: 'paid' });
    await owner.patch(`/api/admin/orders/${c.id}/status`, { status: 'cancelled' });

    const { status, data } = await owner.get('/api/admin/summary');
    assert.equal(status, 200);
    assert.equal(data.totals.total_orders, 3);
    assert.equal(data.totals.active_orders, 2);
    assert.equal(data.totals.cancelled_orders, 1);
    assert.equal(data.totals.completed_orders, 1);
    assert.equal(data.totals.order_value, 50000, 'omzet pesanan = non-batal');
    assert.equal(data.totals.verified_paid, 30000, 'hanya yang ditandai lunas');
    assert.equal(data.totals.unpaid_value, 20000);
    assert.equal(data.totals.cancelled_value, 10000);
    assert.equal(data.queue.pending, 1);
    assert.equal(data.queue.confirmed + data.queue.preparing + data.queue.ready, 0);
    assert.deepEqual(data.top_products.map((p) => [p.name, p.quantity_sold, p.sales_value]), [['Mie Lendir', 5, 50000]]);
    assert.equal(data.daily.length, 1);
    assert.equal(data.daily[0].orders, 2);
    assert.equal(a.total, 20000);
  });

  test('filter tanggal di luar rentang menghasilkan nol; tanggal tidak valid ditolak', async () => {
    const owner = await loggedIn();
    const product = await insertProduct(ctx.pool, { price: 5000 });
    await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    const empty = await owner.get('/api/admin/summary?from=2020-01-01&to=2020-01-31');
    assert.equal(empty.data.totals.total_orders, 0);
    assert.equal(empty.data.totals.order_value, 0);
    assert.equal((await owner.get('/api/admin/summary?from=2020-01-01')).status, 400);
    assert.equal((await owner.get('/api/admin/summary?from=abc&to=def')).status, 400);
    assert.equal((await owner.get('/api/admin/summary?from=2026-02-31&to=2026-03-01')).status, 400);
    assert.equal((await owner.get('/api/admin/summary?from=2026-10-10&to=2026-10-01')).status, 400);
  });
});

describe('pengaturan bisnis', () => {
  test('pemilik mengubah pengaturan dan halaman publik langsung mengikuti', async () => {
    const owner = await loggedIn();
    const response = await owner.put('/api/admin/settings', {
      business_name: 'Royal Bites Bekasi',
      whatsapp_number: '0812-3456-7890',
      address: 'Jl. Contoh No. 1',
      delivery_enabled: true,
      delivery_fee: 8000,
      delivery_area: 'Radius 5 km',
      min_order_amount: 15000,
      payment_transfer_enabled: true,
      payment_transfer_instructions: 'Bank Contoh 123456 a.n. Royal Bites',
      social_instagram: 'https://instagram.com/royalbites',
    });
    assert.equal(response.status, 200);
    const config = (await ctx.client().get('/api/config')).data;
    assert.equal(config.business.name, 'Royal Bites Bekasi');
    assert.equal(config.business.whatsapp_number, '6281234567890');
    assert.equal(config.ordering.delivery_fee, 8000);
    assert.deepEqual(config.ordering.fulfillment_methods.map((m) => m.value), ['pickup', 'delivery']);
    assert.deepEqual(config.ordering.payment_methods.map((m) => m.value), ['cod', 'bank_transfer']);
    assert.equal(config.business.social.instagram, 'https://instagram.com/royalbites');
  });

  test('validasi: nomor salah, URL berbahaya, angka negatif, key tak dikenal ditolak', async () => {
    const owner = await loggedIn();
    for (const body of [
      { whatsapp_number: '123' },
      { social_instagram: 'javascript:alert(1)' },
      { social_facebook: 'ftp://example.com' },
      { delivery_fee: -1 },
      { min_order_amount: 'banyak' },
      { business_name: '' },
      { accepting_orders: 'iya' },
      { logo_image: 'https://evil.example/logo.png' },
      { admin_password: 'x' },
      {},
    ]) {
      const response = await owner.put('/api/admin/settings', body);
      assert.equal(response.status, 400, `harus ditolak: ${JSON.stringify(body)}`);
    }
  });

  test('aturan konsistensi: transfer wajib punya petunjuk; minimal satu metode bayar aktif', async () => {
    const owner = await loggedIn();
    assert.equal((await owner.put('/api/admin/settings', { payment_transfer_enabled: true })).status, 400);
    assert.equal((await owner.put('/api/admin/settings', { payment_cod_enabled: false })).status, 400);
  });

  test('informasi publik tidak memuat data internal', async () => {
    const config = (await ctx.client().get('/api/config')).data;
    const json = JSON.stringify(config);
    assert.ok(!/password|secret|session|admin/i.test(json));
  });
});

describe('formulir kontak dan pesan masuk', () => {
  test('pesan tersimpan, muncul di admin, dan bisa ditandai dibaca', async () => {
    const owner = await loggedIn();
    const anon = ctx.client();
    const sent = await anon.post('/api/contact', { name: 'Siti', email: 'siti@example.com', phone: '0813 9999 0000', message: 'Apakah menerima pesanan nasi kotak?' });
    assert.equal(sent.status, 201);

    const list = await owner.get('/api/admin/messages');
    assert.equal(list.data.total, 1);
    assert.equal(list.data.unread, 1);
    assert.equal(list.data.items[0].phone, '6281399990000');
    assert.equal((await owner.patch(`/api/admin/messages/${list.data.items[0].id}`, { is_read: true })).status, 200);
    assert.equal((await owner.get('/api/admin/messages')).data.unread, 0);
    assert.equal((await owner.patch('/api/admin/messages/9999', { is_read: true })).status, 404);
    assert.equal((await owner.patch(`/api/admin/messages/${list.data.items[0].id}`, { is_read: 'ya' })).status, 400);
  });

  test('validasi: pesan kosong, email salah, honeypot terisi (bot)', async () => {
    const anon = ctx.client();
    assert.equal((await anon.post('/api/contact', { name: 'Siti', message: '' })).status, 400);
    assert.equal((await anon.post('/api/contact', { name: 'S', message: 'halo semua' })).status, 400);
    assert.equal((await anon.post('/api/contact', { name: 'Siti', email: 'bukan-email', message: 'halo semua' })).status, 400);
    assert.equal((await anon.post('/api/contact', { name: 'Siti', message: 'halo semua', website: 'http://spam.example' })).status, 400);
    assert.equal(await countRows(ctx.pool, 'contact_messages'), 0);
  });

  test('pesan hanya bisa dibaca admin', async () => {
    await ctx.client().post('/api/contact', { name: 'Siti', message: 'rahasia pelanggan' });
    assert.equal((await ctx.client().get('/api/admin/messages')).status, 401);
  });
});

describe('akses data pelanggan', () => {
  test('tidak ada endpoint publik yang menampilkan atau mencari pesanan orang lain', async () => {
    const product = await insertProduct(ctx.pool, { price: 5000 });
    const order = await placeOrder([{ product_id: product.id, quantity: 1, price: 5000 }]);
    const anon = ctx.client();
    for (const url of [`/api/orders/${order.order_number}`, `/api/orders/${order.id}`, '/api/orders', '/api/admin/orders', `/api/admin/orders/${order.id}`]) {
      const response = await anon.get(url);
      assert.ok([401, 404].includes(response.status), `${url} => ${response.status}`);
      assert.ok(!JSON.stringify(response.data).includes('081234567890') && !JSON.stringify(response.data).includes('6281234567890'));
    }
  });

  test('file proyek sensitif tidak bisa diunduh lewat static server', async () => {
    for (const url of ['/.env', '/package.json', '/src/app.js', '/db/migrations/001_init.sql', '/node_modules/express/package.json', '/scripts/create-admin.js']) {
      const response = await fetch(`${ctx.baseUrl}${url}`);
      const type = response.headers.get('content-type') || '';
      assert.ok(response.status === 404 || type.includes('html'), `${url} => ${response.status} ${type}`);
      const body = await response.text();
      assert.ok(!body.includes('DB_PASSWORD') && !body.includes('createPool'), `${url} bocor`);
    }
  });
});
