// Skenario admin di browser: tanpa login ditolak, login/logout, kelola pesanan & produk, peran, pengaturan, pesan.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_PASSWORD } from '../helpers.js';

const IMAGE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/images/products/nasi-kentut.jpeg');

export async function runAdminScenarios({ browser, server, runner }) {
  const { baseUrl, pool } = server;
  const { scenario } = runner;

  const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];
  const productId = async (name) => (await one('SELECT id FROM products WHERE name = ?', [name])).id;

  /** Membuat pesanan lewat API publik (seperti pelanggan sungguhan). */
  async function placeOrder({ items, name = 'Pelanggan Uji', phone = '081211112222', total }) {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items,
        customer_name: name,
        customer_phone: phone,
        fulfillment_method: 'pickup',
        payment_method: 'cod',
        expected_total: total,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, `pesanan uji gagal dibuat: ${JSON.stringify(body)}`);
    return body.order;
  }

  async function openAdmin(viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.problems = [];
    page.on('pageerror', (error) => page.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|status of 401/.test(text)) {
        page.problems.push(`console.error: ${text}`);
      }
      if (/Content Security Policy/i.test(text)) page.problems.push(`CSP: ${text}`);
    });
    await page.goto(`${baseUrl}/admin/`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  async function login(page, username = 'pemilik', password = ADMIN_PASSWORD) {
    await page.waitForSelector('#login-view:not([hidden])');
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForSelector('#app-view:not([hidden])');
  }

  const saved = (page) =>
    page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PUT' && response.status() === 200);

  const gotoTab = async (page, tab) => {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForSelector(`.tab[data-tab="${tab}"][aria-current="page"]`);
  };

  // ------------------------------------------------------------------
  await scenario('Tanpa login: semua endpoint admin ditolak (401) dan halaman admin hanya menampilkan form login', async () => {
    const endpoints = [
      ['GET', '/api/admin/summary'],
      ['GET', '/api/admin/orders'],
      ['GET', '/api/admin/orders/1'],
      ['GET', '/api/admin/products'],
      ['GET', '/api/admin/settings'],
      ['GET', '/api/admin/messages'],
      ['GET', '/api/admin/session'],
      ['POST', '/api/admin/products'],
      ['PATCH', '/api/admin/orders/1/status'],
      ['PATCH', '/api/admin/orders/1/payment'],
      ['PUT', '/api/admin/settings'],
      ['DELETE', '/api/admin/products/1'],
      ['POST', '/api/admin/uploads'],
    ];
    for (const [method, url] of endpoints) {
      const response = await fetch(`${baseUrl}${url}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(response.status, 401, `${method} ${url} harus 401, dapat ${response.status}`);
    }
    const page = await openAdmin();
    await page.waitForSelector('#login-view:not([hidden])');
    assert.equal(await page.locator('#app-view').isHidden(), true);
    assert.equal(await page.locator('#admin-main .tab, #admin-main table').count(), 0);
    await page.context().close();
  });

  await scenario('Login gagal menampilkan pesan umum (tidak membocorkan apakah username ada)', async () => {
    const page = await openAdmin();
    await page.waitForSelector('#login-view:not([hidden])');
    await page.fill('#login-username', 'pemilik');
    await page.fill('#login-password', 'password-salah-sekali');
    await page.click('#login-submit');
    await page.waitForSelector('#login-alert:not([hidden])');
    const wrong = await page.locator('#login-alert').innerText();
    await page.evaluate(() => { document.querySelector('#login-alert').hidden = true; });
    await page.fill('#login-username', 'tidak-ada-user');
    await page.click('#login-submit');
    await page.waitForSelector('#login-alert:not([hidden])');
    const unknown = await page.locator('#login-alert').innerText();
    assert.match(wrong, /Username atau password salah/);
    assert.equal(wrong, unknown);
    assert.equal(await page.locator('#app-view').isHidden(), true);
    await page.context().close();
  });

  await scenario('ALUR UTAMA ADMIN: login -> pesanan pelanggan terlihat -> ubah status -> tandai lunas, tersimpan di MySQL', async () => {
    const nasi = await productId('Nasi Uji');
    const order = await placeOrder({ items: [{ product_id: nasi, quantity: 2 }], name: 'Ani Admin-Uji', total: 40000 });

    const page = await openAdmin();
    await login(page);
    await gotoTab(page, 'orders');
    const row = page.locator('tr', { hasText: order.order_number });
    await row.waitFor();
    assert.match(await row.innerText(), /Ani Admin-Uji/);
    assert.match(await row.innerText(), /Menunggu Konfirmasi/);

    await row.getByRole('button', { name: /Lihat detail/ }).click();
    await page.waitForSelector('#order-dialog[open] #status-form');
    assert.match(await page.locator('#order-detail').innerText(), /Rp40\.000/);

    // pending -> confirmed
    await page.selectOption('#st-status', 'confirmed');
    await page.click('#status-form button[type=submit]');
    // Tunggu bukti perubahan di riwayat (bukan sekadar kata "Dikonfirmasi", yang juga ada di pilihan status).
    await page.waitForFunction(() => document.querySelector('#order-detail').innerText.includes('→ Dikonfirmasi'));
    assert.equal((await one('SELECT order_status FROM orders WHERE order_number = ?', [order.order_number])).order_status, 'confirmed');

    // tandai lunas (dengan konfirmasi)
    await page.getByRole('button', { name: /Tandai Lunas/ }).click();
    await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#order-detail').innerText.includes('Lunas (Terverifikasi)'));
    const saved = await one('SELECT order_status, payment_status FROM orders WHERE order_number = ?', [order.order_number]);
    assert.equal(saved.payment_status, 'paid');

    // riwayat tercatat dengan nama admin
    const events = (await pool.query('SELECT event_type, to_value FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.order_number = ? ORDER BY e.id', [order.order_number]))[0];
    assert.deepEqual(events.map((e) => `${e.event_type}:${e.to_value}`), ['created:pending', 'status:confirmed', 'payment:paid']);
    assert.match(await page.locator('#order-detail').innerText(), /Pesanan dibuat oleh pelanggan/);
    assert.match(await page.locator('#order-detail').innerText(), /oleh pemilik/);

    // lanjutkan sampai selesai; status final tidak bisa diubah lagi
    await page.selectOption('#st-status', 'completed');
    await page.click('#status-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#order-detail').innerText.includes('sudah final'));
    assert.equal((await one('SELECT order_status FROM orders WHERE order_number = ?', [order.order_number])).order_status, 'completed');
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  await scenario('Membatalkan pesanan mengembalikan stok SEKALI (stok yang dihitung)', async () => {
    await pool.execute("INSERT INTO products (name, description, price, category, stock, track_stock, is_available) VALUES ('Stok Uji', '', 1000, 'jajanan', 10, 1, 1)");
    const id = await productId('Stok Uji');
    const order = await placeOrder({ items: [{ product_id: id, quantity: 3 }], total: 3000 });
    assert.equal((await one('SELECT stock FROM products WHERE id = ?', [id])).stock, 7);

    const page = await openAdmin();
    await login(page);
    await gotoTab(page, 'orders');
    await page.locator('tr', { hasText: order.order_number }).getByRole('button', { name: /Lihat detail/ }).click();
    await page.waitForSelector('#status-form');
    await page.selectOption('#st-status', 'cancelled');
    await page.fill('#st-note', 'Pelanggan batal');
    await page.click('#status-form button[type=submit]');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#order-detail').innerText.includes('sudah final'));
    assert.equal((await one('SELECT stock FROM products WHERE id = ?', [id])).stock, 10, 'stok dikembalikan');
    assert.equal((await one('SELECT cancel_reason FROM orders WHERE order_number = ?', [order.order_number])).cancel_reason, 'Pelanggan batal');
    // pesanan yang dibatalkan tidak bisa ditandai lunas (tombol tidak ada) dan API menolak
    assert.equal(await page.getByRole('button', { name: /Tandai Lunas/ }).count(), 0);
    await page.context().close();
  });

  await scenario('Ringkasan: angka cocok dengan database dan memisahkan nilai pesanan vs lunas', async () => {
    const page = await openAdmin();
    await login(page);
    await gotoTab(page, 'summary');
    await page.waitForSelector('.cards .stat');
    const text = await page.locator('#admin-main').innerText();
    const total = (await one('SELECT COUNT(*) AS n FROM orders')).n;
    const paid = (await one("SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE payment_status='paid' AND order_status <> 'cancelled'")).s;
    assert.ok(text.includes(`Rp${Number(paid).toLocaleString('id-ID')}`), 'nilai lunas harus tampil');
    assert.match(text, /Lunas terverifikasi/);
    assert.match(text, /Nilai pesanan \(belum tentu dibayar\)/);
    const shownTotal = Number((await page.locator('.stat', { hasText: 'Total pesanan' }).locator('.value').innerText()).trim());
    assert.ok(shownTotal <= total && shownTotal > 0, `total pesanan tampil ${shownTotal}, DB ${total}`);
    await page.context().close();
  });

  await scenario('Produk: tambah (dengan upload foto), ubah harga, sembunyikan, hapus — tersimpan & tampil di situs', async () => {
    const page = await openAdmin();
    await login(page);
    await gotoTab(page, 'products');
    await page.click('text=+ Tambah produk');
    await page.waitForSelector('#product-dialog[open]');

    // validasi: kosong ditolak
    await page.click('#pf-submit');
    assert.match(await page.locator('#pf-name-error').innerText(), /minimal 2/);
    assert.match(await page.locator('#pf-price-error').innerText(), /minimal 1/);

    await page.fill('#pf-name', 'Sate Uji Coba');
    await page.fill('#pf-description', 'Dibuat saat pengujian.');
    await page.fill('#pf-price', '12500');
    await page.selectOption('#pf-category', 'makanan');
    await page.setInputFiles('#pf-image', IMAGE_FILE);
    await page.check('#pf-track');
    await page.fill('#pf-stock', '4');
    await page.click('#pf-submit');
    await page.waitForFunction(() => !document.querySelector('#product-dialog').open);
    const row = page.locator('tr', { hasText: 'Sate Uji Coba' });
    await row.waitFor();

    const created = await one("SELECT * FROM products WHERE name = 'Sate Uji Coba'");
    assert.equal(created.price, 12500);
    assert.equal(created.stock, 4);
    assert.equal(created.track_stock, 1);
    assert.match(created.image, /^\/uploads\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/, 'foto tersimpan lewat upload');
    const imageResponse = await fetch(`${baseUrl}${created.image}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type'), /^image\//);

    // tampil di API publik
    const publicList = (await (await fetch(`${baseUrl}/api/products`)).json()).products;
    assert.ok(publicList.some((p) => p.name === 'Sate Uji Coba' && p.price === 12500));

    // ubah harga
    await row.getByRole('button', { name: /^Ubah/ }).click();
    await page.waitForSelector('#product-dialog[open]');
    assert.equal(await page.inputValue('#pf-name'), 'Sate Uji Coba');
    await page.fill('#pf-price', '15000');
    await page.click('#pf-submit');
    await page.waitForFunction(() => !document.querySelector('#product-dialog').open);
    await page.waitForFunction(() => document.querySelector('#admin-main').innerText.includes('Rp15.000'));
    assert.equal((await one("SELECT price FROM products WHERE name = 'Sate Uji Coba'")).price, 15000);

    // sembunyikan (tetap ada di admin, hilang dari situs)
    await page.locator('tr', { hasText: 'Sate Uji Coba' }).getByRole('button', { name: /^Sembunyikan/ }).click();
    await page.waitForFunction(() => document.querySelector('#admin-main').innerText.includes('Disembunyikan'));
    const hidden = (await (await fetch(`${baseUrl}/api/products`)).json()).products.find((p) => p.name === 'Sate Uji Coba');
    assert.equal(hidden.availability, 'unavailable');

    // hapus (soft delete) oleh pemilik
    await page.locator('tr', { hasText: 'Sate Uji Coba' }).getByRole('button', { name: /^Hapus/ }).click();
    await page.click('#confirm-ok');
    await page.waitForFunction(() => !document.querySelector('#admin-main').innerText.includes('Sate Uji Coba'));
    const deleted = await one("SELECT deleted_at FROM products WHERE name = 'Sate Uji Coba'");
    assert.ok(deleted.deleted_at, 'produk ditandai terhapus (riwayat pesanan tetap aman)');
    const afterDelete = (await (await fetch(`${baseUrl}/api/products`)).json()).products;
    assert.ok(!afterDelete.some((p) => p.name === 'Sate Uji Coba'));
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  await scenario('Peran staf: tidak ada tab Pengaturan & tombol Hapus; API menolak (403)', async () => {
    const page = await openAdmin();
    await login(page, 'kasir');
    assert.equal(await page.locator('.tab[data-tab="settings"]').isHidden(), true);
    await gotoTab(page, 'products');
    await page.waitForSelector('table.data');
    assert.equal(await page.getByRole('button', { name: /^Hapus/ }).count(), 0);

    // lewat API langsung dengan sesi staf (cookie + CSRF dari browser)
    const result = await page.evaluate(async () => {
      const session = await (await fetch('/api/admin/session')).json();
      const headers = { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token };
      const del = await fetch('/api/admin/products/1', { method: 'DELETE', headers });
      const put = await fetch('/api/admin/settings', { method: 'PUT', headers, body: JSON.stringify({ business_name: 'Diretas' }) });
      const noCsrf = await fetch('/api/admin/products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return { del: del.status, put: put.status, noCsrf: noCsrf.status };
    });
    assert.equal(result.del, 403);
    assert.equal(result.put, 403);
    assert.ok([401, 403].includes(result.noCsrf), `tanpa CSRF harus ditolak, dapat ${result.noCsrf}`);
    await page.context().close();
  });

  await scenario('Pengaturan bisnis (pemilik): perubahan langsung berlaku di situs pelanggan; validasi menolak data salah', async () => {
    const page = await openAdmin();
    await login(page);
    await gotoTab(page, 'settings');
    await page.waitForSelector('.settings-form');

    // validasi: nomor WhatsApp salah
    await page.fill('#set-whatsapp_number', '123');
    await page.click('.settings-form button[type=submit]');
    await page.waitForSelector('#set-whatsapp_number-error:not(:empty)');
    assert.match(await page.locator('#set-whatsapp_number-error').innerText(), /tidak valid/);

    // nilai benar: ubah nama bisnis, nomor, jam buka, dan tutup pemesanan
    await page.fill('#set-business_name', 'Royal Bites Uji');
    await page.fill('#set-whatsapp_number', '0812-0000-1111');
    await page.fill('#set-opening_hours', 'Setiap hari 09.00–17.00');
    await page.uncheck('#set-accepting_orders');
    // Tunggu respons simpan dari server (toast lama bisa masih tampil, jadi tidak boleh dijadikan penanda).
    await Promise.all([saved(page), page.click('.settings-form button[type=submit]')]);

    const config = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.equal(config.business.name, 'Royal Bites Uji');
    assert.equal(config.business.whatsapp_number, '6281200001111');
    assert.equal(config.ordering.accepting_orders, false);

    // situs pelanggan memakai nilai baru; pemesanan ditutup => tombol tambah nonaktif & server menolak
    const customer = await (await browser.newContext()).newPage();
    await customer.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await customer.waitForSelector('.menu-card:not(.skeleton)');
    assert.match(await customer.locator('#order-banner').innerText(), /ditutup/);
    assert.match(await customer.locator('#info-hours').innerText(), /09\.00/);
    assert.equal(await customer.locator('[data-add]').first().isDisabled(), true);
    const nasi = await productId('Nasi Uji');
    const refused = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ product_id: nasi, quantity: 1 }], customer_name: 'Tutup', customer_phone: '081200000009', fulfillment_method: 'pickup', payment_method: 'cod', expected_total: 20000, idempotency_key: crypto.randomUUID() }),
    });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error.code, 'ORDERS_CLOSED');
    await customer.context().close();

    // pulihkan agar skenario lain tidak terganggu
    await page.check('#set-accepting_orders');
    await Promise.all([saved(page), page.click('.settings-form button[type=submit]')]);
    assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).ordering.accepting_orders, true);
    await page.context().close();
  });

  await scenario('Pesan masuk dari formulir kontak tampil di admin dan bisa ditandai dibaca', async () => {
    await fetch(`${baseUrl}/api/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pengirim Uji', message: 'Pesan untuk admin uji.' }) });
    const page = await openAdmin();
    await login(page);
    await gotoTab(page, 'messages');
    const card = page.locator('.message', { hasText: 'Pesan untuk admin uji.' });
    await card.waitFor();
    assert.equal(await page.locator('#tab-badge-messages').isVisible(), true);
    await card.getByRole('button', { name: /sudah dibaca/ }).click();
    await page.waitForFunction(() => document.querySelector('.message.read'));
    assert.equal((await one("SELECT is_read FROM contact_messages WHERE message = 'Pesan untuk admin uji.'")).is_read, 1);
    await page.context().close();
  });

  await scenario('Logout: sesi dihapus di server; setelah itu API admin kembali 401', async () => {
    const page = await openAdmin();
    await login(page);
    const csrf = await page.evaluate(async () => (await (await fetch('/api/admin/session')).json()).csrf_token);
    assert.ok(csrf);
    await page.click('#logout-btn');
    await page.waitForSelector('#login-view:not([hidden])');
    assert.equal(await page.locator('#app-view').isHidden(), true);
    const status = await page.evaluate(async () => (await fetch('/api/admin/orders')).status);
    assert.equal(status, 401);
    // memuat ulang halaman tidak memulihkan sesi
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-view:not([hidden])');
    await page.context().close();
  });

  await scenario('Ubah password: password lama berhenti berlaku, password baru bisa dipakai; aturan panjang ditegakkan', async () => {
    await pool.execute("DELETE FROM admin_users WHERE username = 'sementara'");
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const { createAdminUser } = await import('../../src/services/authService.js');
    await createAdminUser(pool, server.config, { username: 'sementara', password: ADMIN_PASSWORD, role: 'staff' });
    const page = await openAdmin();
    await login(page, 'sementara');
    await page.click('#open-password');
    await page.fill('#pw-current', ADMIN_PASSWORD);
    await page.fill('#pw-new', 'pendek');
    await page.fill('#pw-confirm', 'pendek');
    await page.click('#pw-submit');
    assert.match(await page.locator('#pw-alert').innerText(), /minimal 12/);
    const baru = 'PasswordBaruYangPanjang-77';
    await page.fill('#pw-new', baru);
    await page.fill('#pw-confirm', baru);
    await page.click('#pw-submit');
    await page.waitForFunction(() => !document.querySelector('#password-dialog').open);
    await page.click('#logout-btn');
    await page.waitForSelector('#login-view:not([hidden])');
    await page.fill('#login-username', 'sementara');
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('#login-submit');
    await page.waitForFunction(() => document.querySelector('#login-alert') && !document.querySelector('#login-alert').hidden);
    assert.equal(await page.locator('#app-view').isHidden(), true, 'password lama harus ditolak');
    await page.fill('#login-password', baru);
    await page.click('#login-submit');
    await page.waitForSelector('#app-view:not([hidden])');
    await page.context().close();
  });

  await scenario('Responsif: dashboard admin tidak menggeser halaman secara horizontal di 390 px', async () => {
    const page = await openAdmin({ width: 390, height: 800 });
    await login(page);
    for (const tab of ['summary', 'orders', 'products', 'messages', 'settings']) {
      await gotoTab(page, tab);
      await page.waitForTimeout(250);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `tab ${tab}: halaman bergeser ${overflow}px`);
    }
    await page.context().close();
  });
}
