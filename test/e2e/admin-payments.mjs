// Skenario browser dashboard admin untuk pembayaran QRIS, laporan, dan peringatan stok.
// Gateway = server Midtrans TIRUAN lokal (lihat catatan di qris.mjs): yang diuji adalah alur & aturan, bukan akun Midtrans sungguhan.
import assert from 'node:assert/strict';
import { FAKE_SERVER_KEY } from '../fakeMidtrans.js';
import { ADMIN_PASSWORD } from '../helpers.js';

const money = (n) => `Rp${Number(n).toLocaleString('id-ID')}`;

export async function runAdminPaymentScenarios({ browser, server, runner }) {
  const { pool, qris } = server;
  const { scenario } = runner;
  const { fake } = qris;

  const productId = async (name) => (await pool.query('SELECT id FROM products WHERE name = ?', [name]))[0][0].id;
  const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];

  /** Pesanan QRIS lewat API publik (seperti pelanggan). */
  async function placeQrisOrder({ name, phone, quantity = 1 }) {
    const nasi = await productId('Nasi Uji');
    const response = await fetch(`${qris.baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items: [{ product_id: nasi, quantity }],
        customer_name: name,
        customer_phone: phone,
        fulfillment_method: 'pickup',
        payment_method: 'qris',
        expected_total: 20000 * quantity,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    const order = await one('SELECT * FROM orders WHERE order_number = ?', [body.order.order_number]);
    const payment = await one('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id]);
    return { order, payment, number: body.order.order_number };
  }

  async function settle(payment) {
    fake.setStatus(payment.provider_order_id, 'settlement');
    const response = await qris.notify(fake.notification(payment.provider_order_id));
    assert.equal(response.status, 200);
  }

  async function openAdmin(viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.problems = [];
    page.on('pageerror', (error) => page.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|status of (401|409)/.test(text)) {
        page.problems.push(`console.error: ${text}`);
      }
      if (/Content Security Policy/i.test(text)) page.problems.push(`CSP: ${text}`);
    });
    await page.goto(`${qris.baseUrl}/admin/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-view:not([hidden])');
    await page.fill('#login-username', 'pemilik');
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('#login-submit');
    await page.waitForSelector('#app-view:not([hidden])');
    return page;
  }

  const gotoTab = async (page, tab) => {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForSelector(`.tab[data-tab="${tab}"][aria-current="page"]`);
  };
  const statValue = async (page, label) => (await page.locator('.stat', { hasText: label }).locator('.value').innerText()).trim();
  const verifiedPaidInDb = async () =>
    Number((await one("SELECT COALESCE(SUM(total), 0) AS v FROM orders WHERE payment_status = 'paid' AND order_status <> 'cancelled'")).v);

  async function openOrderDetail(page, number) {
    await gotoTab(page, 'orders');
    // Filter daftar pesanan diingat selama sesi; kosongkan agar pesanan yang statusnya sudah berubah tetap terlihat.
    await page.getByRole('button', { name: 'Reset' }).click();
    await page.waitForSelector('#of-payment');
    const row = page.locator('#admin-main tr', { hasText: number });
    await row.waitFor();
    await row.getByRole('button', { name: /Lihat detail/ }).click();
    await page.waitForSelector('#order-dialog[open] #payment-panel');
  }

  // ------------------------------------------------------------------
  await scenario('Admin & QRIS: referensi gateway + waktu tampil; tidak bisa ditandai lunas manual; lunas hanya setelah gateway; pendapatan hanya dari yang lunas', async () => {
    const { number, payment } = await placeQrisOrder({ name: 'Admin QRIS Satu', phone: '081388880001' });
    const page = await openAdmin();

    // Daftar pesanan: status pembayaran, metode, referensi gateway, batas waktu bayar
    await gotoTab(page, 'orders');
    const row = page.locator('#admin-main tr', { hasText: number });
    await row.waitFor();
    const rowText = await row.innerText();
    assert.match(rowText, /Menunggu Pembayaran/);
    assert.match(rowText, /QRIS/);
    assert.ok(rowText.includes(payment.provider_transaction_id.slice(0, 8)), 'referensi gateway harus tampil di daftar');
    assert.match(rowText, /Bayar sebelum/);

    // Filter status pembayaran "Menunggu Pembayaran"
    await page.selectOption('#of-payment', 'pending');
    await page.click('.filters button[type=submit]');
    await page.waitForFunction((n) => document.querySelector('#admin-main').innerText.includes(n), number);

    // Detail: referensi transaksi lengkap, waktu, tombol cek gateway; TIDAK ada "Tandai Lunas"
    await page.locator('#admin-main tr', { hasText: number }).getByRole('button', { name: /Lihat detail/ }).click();
    await page.waitForSelector('#order-dialog[open] #payment-panel');
    const panel = await page.locator('#payment-panel').innerText();
    assert.ok(panel.includes(payment.provider_transaction_id), 'referensi transaksi gateway lengkap harus tampil');
    assert.ok(panel.includes(payment.provider_order_id));
    assert.match(panel, /Batas waktu bayar/);
    assert.match(panel, /Pesanan dibuat/);
    assert.equal(await page.getByRole('button', { name: /Tandai Lunas/ }).count(), 0, 'QRIS tidak boleh ditandai lunas manual');
    assert.equal(await page.locator('#check-gateway').isVisible(), true);
    // Pesanan QRIS yang belum lunas hanya bisa dibatalkan, tidak bisa diproses
    const options = await page.locator('#st-status option').allTextContents();
    assert.deepEqual(options, ['Dibatalkan']);
    assert.match(await page.locator('#order-detail').innerText(), /baru bisa dikonfirmasi\/diproses setelah pembayaran berstatus Lunas/);

    // "Periksa status ke gateway" saat belum dibayar: tetap menunggu
    await page.click('#check-gateway');
    await page.waitForFunction(() => document.querySelector('#toast-message').textContent.includes('Status diperiksa ke gateway'));
    assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', [number])).payment_status, 'pending');
    await page.keyboard.press('Escape');

    // Pendapatan terverifikasi belum bertambah karena pesanan ini belum lunas
    const paidBefore = await verifiedPaidInDb();
    await gotoTab(page, 'summary');
    await page.waitForSelector('.stat');
    assert.equal(await statValue(page, 'Lunas terverifikasi'), money(paidBefore));

    // Pelanggan membayar -> gateway memberi tahu -> admin melihat LUNAS dengan waktu bayar
    await settle(payment);
    await openOrderDetail(page, number);
    const paidPanel = await page.locator('#payment-panel').innerText();
    assert.match(paidPanel, /Lunas \(Terverifikasi\)/);
    assert.equal(await page.getByRole('button', { name: /Tandai Lunas/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /Catat Sudah Dikembalikan/ }).count(), 1, 'hanya refund yang boleh dicatat manual');
    assert.equal(await page.locator('#check-gateway').count(), 0, 'tidak ada pembayaran menunggu lagi');
    assert.ok((await page.locator('#payment-panel details.notifications').textContent()).includes('settlement'), 'notifikasi gateway tercatat'); // textContent: daftar ada di <details> yang tertutup
    const confirmable = await page.locator('#st-status option').allTextContents();
    assert.ok(confirmable.includes('Dikonfirmasi'), 'setelah lunas, pesanan boleh diproses');
    await page.keyboard.press('Escape');

    // Pendapatan terverifikasi bertambah tepat Rp20.000
    const paidAfter = await verifiedPaidInDb();
    assert.equal(paidAfter, paidBefore + 20000);
    await gotoTab(page, 'summary');
    await page.waitForSelector('.stat');
    assert.equal(await statValue(page, 'Lunas terverifikasi'), money(paidAfter));
    assert.match(await page.locator('#admin-main').innerText(), /QRIS/); // rincian per metode pembayaran
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Admin membatalkan pesanan QRIS yang sudah LUNAS: ada peringatan refund, dan Ringkasan menandainya "dibayar tetapi dibatalkan"', async () => {
    const { number, payment } = await placeQrisOrder({ name: 'Admin QRIS Batal', phone: '081388880002' });
    await settle(payment);
    const paidBefore = await verifiedPaidInDb();
    const page = await openAdmin();
    await openOrderDetail(page, number);

    await page.selectOption('#st-status', 'cancelled');
    await page.click('#status-form button[type=submit]');
    const confirmText = await page.locator('#confirm-message').innerText();
    assert.match(confirmText, /sudah DIBAYAR/);
    assert.match(confirmText, /refund/i);
    await page.click('#confirm-ok');
    await page.waitForFunction(() => document.querySelector('#order-detail').innerText.includes('sudah final'));
    assert.equal((await one('SELECT order_status FROM orders WHERE order_number = ?', [number])).order_status, 'cancelled');
    await page.keyboard.press('Escape');

    // Pesanan batal tidak dihitung sebagai pendapatan, dan muncul sebagai peringatan
    assert.equal(await verifiedPaidInDb(), paidBefore - 20000);
    await gotoTab(page, 'summary');
    await page.waitForSelector('.callout.bad');
    assert.match(await page.locator('.callout.bad').first().innerText(), /sudah DIBAYAR tetapi dibatalkan/);
    assert.equal(await statValue(page, 'Lunas terverifikasi'), money(await verifiedPaidInDb()));

    // Refund dilakukan di dashboard gateway lalu dicatat manual: peringatan hilang
    await page.locator('.callout.bad button').first().click();
    await page.locator('#admin-main tr', { hasText: number }).waitFor();
    await page.locator('#admin-main tr', { hasText: number }).getByRole('button', { name: /Lihat detail/ }).click();
    await page.waitForSelector('#order-dialog[open] #payment-panel');
    await page.getByRole('button', { name: /Catat Sudah Dikembalikan/ }).click();
    assert.match(await page.locator('#confirm-message').innerText(), /dashboard gateway/);
    await page.click('#confirm-ok');
    // Tunggu bukti di riwayat (kata "Dikembalikan" juga ada pada label tombol, jadi tidak cukup).
    await page.waitForFunction(() => document.querySelector('#order-detail').innerText.includes('→ Dikembalikan'));
    assert.equal((await one('SELECT payment_status FROM orders WHERE order_number = ?', [number])).payment_status, 'refunded');
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Stok menipis: Ringkasan menampilkan menu yang stoknya dihitung & di bawah batas; Produk punya filter status', async () => {
    const [low] = await pool.execute(
      "INSERT INTO products (name, description, price, category, stock, track_stock, is_available) VALUES ('Menu Menipis Uji', 'Stok hampir habis.', 9000, 'makanan', 2, 1, 1)",
    );
    await pool.execute(
      "INSERT INTO products (name, description, price, category, stock, track_stock, is_available) VALUES ('Menu Stok Banyak Uji', 'Stok aman.', 9000, 'makanan', 80, 1, 1)",
    );
    assert.ok(low.insertId > 0);
    const page = await openAdmin();
    await gotoTab(page, 'summary');
    await page.waitForSelector('#low-stock-table');
    const table = await page.locator('#low-stock-table').innerText();
    assert.match(table, /Menu Menipis Uji/);
    assert.ok(!table.includes('Menu Stok Banyak Uji'), 'stok aman tidak boleh tampil di daftar peringatan');
    assert.ok(!table.includes('Nasi Uji'), 'menu tanpa hitung stok tidak boleh tampil');

    // dari peringatan langsung ke Produk
    await page.getByRole('button', { name: 'Atur stok Menu Menipis Uji' }).click();
    await page.waitForSelector('.tab[data-tab="products"][aria-current="page"]');
    await page.locator('#admin-main tr', { hasText: 'Menu Menipis Uji' }).waitFor();
    assert.match(await page.locator('#admin-main tr', { hasText: 'Menu Menipis Uji' }).innerText(), /Stok menipis/);

    // tanpa filter: kedua menu terlihat
    await page.fill('#pf-q', '');
    await page.click('.filters button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#product-count') && document.querySelector('#admin-main').innerText.includes('Menu Stok Banyak Uji'));
    // filter status "Stok menipis": hanya yang menipis
    await page.selectOption('#pf-status', 'low');
    await page.click('.filters button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#product-count') && !document.querySelector('#admin-main').innerText.includes('Menu Stok Banyak Uji'));
    assert.match(await page.locator('#admin-main').innerText(), /Menu Menipis Uji/);
    assert.match(await page.locator('#product-count').innerText(), /menu aktif/);

    // Pemilik mengubah batas -> peringatan menyesuaikan (batas 0: hanya yang habis)
    await gotoTab(page, 'settings');
    await page.waitForSelector('#set-low_stock_threshold');
    await page.fill('#set-low_stock_threshold', '0');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PUT' && response.status() === 200),
      page.click('.settings-form button[type=submit]'),
    ]);
    await gotoTab(page, 'summary');
    await page.waitForSelector('.stat');
    assert.ok(!(await page.locator('#admin-main').innerText()).includes('Menu Menipis Uji'), 'batas 0: stok 2 tidak lagi dianggap menipis');
    // pulihkan
    await gotoTab(page, 'settings');
    await page.fill('#set-low_stock_threshold', '5');
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/api/admin/settings') && response.request().method() === 'PUT' && response.status() === 200),
      page.click('.settings-form button[type=submit]'),
    ]);
    assert.equal((await one("SELECT setting_value FROM settings WHERE setting_key = 'low_stock_threshold'")).setting_value, '5');
    await pool.execute("UPDATE products SET deleted_at = NOW() WHERE name IN ('Menu Menipis Uji', 'Menu Stok Banyak Uji')");
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Pengaturan: konfigurasi QRIS tampil baca-saja tanpa kunci rahasia; server tanpa gateway menampilkan "Belum aktif"', async () => {
    const page = await openAdmin();
    await gotoTab(page, 'settings');
    await page.waitForSelector('#payment-config');
    const text = await page.locator('#payment-config').innerText();
    assert.match(text, /Terkonfigurasi/);
    assert.match(text, /SANDBOX/);
    assert.match(text, /\/api\/payments\/midtrans\/notification|PAYMENT_WEBHOOK_URL/);
    const html = await page.content();
    assert.ok(!html.includes(FAKE_SERVER_KEY), 'kunci rahasia gateway tidak boleh muncul di halaman admin');
    assert.equal(await page.locator('#set-payment_qris_enabled').isVisible(), true);
    await page.context().close();

    // server tanpa kredensial gateway
    const context = await browser.newContext();
    const plain = await context.newPage();
    await plain.goto(`${server.baseUrl}/admin/`, { waitUntil: 'domcontentloaded' });
    await plain.waitForSelector('#login-view:not([hidden])');
    await plain.fill('#login-username', 'pemilik');
    await plain.fill('#login-password', ADMIN_PASSWORD);
    await plain.click('#login-submit');
    await plain.waitForSelector('#app-view:not([hidden])');
    await gotoTab(plain, 'settings');
    await plain.waitForSelector('#payment-config');
    assert.match(await plain.locator('#payment-config').innerText(), /Belum aktif/);
    await context.close();
  });

  // ------------------------------------------------------------------
  await scenario('Responsif: dashboard admin (dengan data QRIS) tidak meluber horizontal di 390 px', async () => {
    const page = await openAdmin({ width: 390, height: 800 });
    for (const tab of ['summary', 'orders', 'products', 'settings']) {
      await gotoTab(page, tab);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `tab ${tab}: halaman bergeser ${overflow}px`);
    }
    // detail pesanan QRIS di HP
    await gotoTab(page, 'orders');
    await page.locator('#admin-main tr', { hasText: 'QRIS' }).first().getByRole('button', { name: /Lihat detail/ }).click();
    await page.waitForSelector('#order-dialog[open] #payment-panel');
    const dialogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(dialogOverflow <= 0, `detail pesanan bergeser ${dialogOverflow}px`);
    await page.context().close();
  });
}
