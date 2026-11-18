// Skenario browser untuk pembayaran QRIS + halaman lacak pesanan.
//
// PENTING (kejujuran hasil): gateway di sini adalah server Midtrans TIRUAN lokal (test/fakeMidtrans.js), dan "gambar QR"
// yang dikembalikannya hanya PNG 1x1. Skenario ini membuktikan alur halaman + backend + kontrak yang terdokumentasi,
// BUKAN bahwa akun Midtrans sungguhan menerima pembayaran, dan bukan bahwa kode QR bisa dipindai aplikasi bank.
import assert from 'node:assert/strict';

const money = (n) => `Rp${n.toLocaleString('id-ID')}`;

export async function runQrisScenarios({ browser, server, runner }) {
  const { pool, qris } = server;
  const { scenario } = runner;
  const { fake } = qris;

  async function newPage(baseUrl, viewport = { width: 1280, height: 900 }, { goto = true } = {}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.problems = [];
    page.requestedUrls = [];
    page.on('request', (request) => page.requestedUrls.push(request.url()));
    page.on('pageerror', (error) => page.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      const text = message.text();
      // 404/409 dari API adalah respons yang SENGAJA diuji; sumber luar (font Google) tidak terjangkau di lingkungan uji.
      if (message.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|status of (404|409|429|403)/.test(text)) {
        page.problems.push(`console.error: ${text}`);
      }
      if (/Content Security Policy/i.test(text)) page.problems.push(`CSP: ${text}`);
    });
    if (goto) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.menu-card:not(.skeleton)');
    }
    return page;
  }

  const productId = async (name) => (await pool.query('SELECT id FROM products WHERE name = ?', [name]))[0][0].id;
  const orderCount = async () => (await pool.query('SELECT COUNT(*) AS n FROM orders'))[0][0].n;
  const paymentCount = async () => (await pool.query('SELECT COUNT(*) AS n FROM payments'))[0][0].n;
  const orderRow = async (number) => (await pool.query('SELECT * FROM orders WHERE order_number = ?', [number]))[0][0];
  const paymentRows = async (orderId) => (await pool.query('SELECT * FROM payments WHERE order_id = ? ORDER BY id', [orderId]))[0];
  const charges = () => fake.count('POST', /^\/v2\/charge$/);
  const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  /** Mengisi & mengirim checkout lewat UI. Mengembalikan setelah dialog/halaman berikutnya muncul. */
  async function checkoutViaUi(page, { name, phone, payment = 'qris', delivery = false }) {
    const nasi = await productId('Nasi Uji');
    await page.locator(`[data-add="${nasi}"]`).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    await page.fill('#co-name', name);
    await page.fill('#co-phone', phone);
    if (delivery) {
      await page.check('input[name="fulfillment_method"][value="delivery"]');
      await page.fill('#co-address', 'Jl. Uji Coba No. 12, Kota Uji');
    } else {
      await page.check('input[name="fulfillment_method"][value="pickup"]');
    }
    await page.check(`input[name="payment_method"][value="${payment}"]`);
  }

  /** Alur lengkap QRIS lewat UI sampai halaman lacak menampilkan kode QR. */
  async function placeQrisOrderViaUi(page, { name = 'Pembeli QRIS', phone = '081377770001' } = {}) {
    await checkoutViaUi(page, { name, phone });
    await page.click('#co-submit');
    await page.waitForURL(/\/track\.html#[A-Za-z0-9_-]{43}$/, { timeout: 15000 });
    await page.waitForSelector('#track-result:not([hidden])');
    const number = (await page.locator('#track-number').innerText()).trim();
    const token = page.url().split('#')[1];
    const order = await orderRow(number);
    const [payment] = await paymentRows(order.id);
    return { number, token, order, payment };
  }

  const payPill = (page) => page.locator('#pay-status-pill');
  const waitForPayPill = (page, text, timeout = 15000) =>
    page.waitForFunction((expected) => document.querySelector('#pay-status-pill')?.textContent.includes(expected), text, { timeout });

  // ------------------------------------------------------------------
  await scenario('QRIS di HP (390px): checkout -> halaman lacak menampilkan QR dari gateway; muat ulang tidak menggandakan pesanan/pembayaran', async () => {
    const page = await newPage(qris.baseUrl, { width: 390, height: 844 });
    const ordersBefore = await orderCount();
    const paymentsBefore = await paymentCount();
    const chargesBefore = charges();

    await checkoutViaUi(page, { name: 'Pembeli QRIS', phone: '0813-7777-0001' });
    const info = await page.locator('#co-payment-info').innerText();
    assert.match(info, /QRIS/);
    assert.match(info, /UJI COBA/, 'mode non-produksi harus diberi peringatan jelas');
    assert.equal(await page.locator('#co-total').innerText(), money(20000));
    assert.equal(await overflowOf(page), 0, 'formulir checkout tidak boleh meluber di 390px');
    await page.click('#co-submit');

    await page.waitForURL(/\/track\.html#[A-Za-z0-9_-]{43}$/, { timeout: 15000 });
    await page.waitForSelector('#track-result:not([hidden])');
    await page.waitForSelector('.qr-img');
    const number = (await page.locator('#track-number').innerText()).trim();
    assert.match(number, /^RB-\d{6}-[A-Z0-9]{5}$/);
    const token = page.url().split('#')[1];

    // Tampilan: status pembayaran & pesanan terpisah, QR dari gateway, jumlah benar, hitung mundur, peringatan sandbox.
    assert.equal((await payPill(page).innerText()).trim(), 'Menunggu Pembayaran');
    assert.equal((await page.locator('#order-status-pill').innerText()).trim(), 'Menunggu Konfirmasi');
    assert.match(await page.locator('.qr-img').getAttribute('src'), /^data:image\/png;base64,/);
    assert.match(await page.locator('.pay-amount').innerText(), /Rp20\.000/);
    assert.match(await page.locator('#pay-countdown').innerText(), /sisa \d\d:\d\d/);
    assert.equal(await page.locator('#mode-notice').isVisible(), true);
    assert.match(await page.locator('#mode-notice').innerText(), /UJI COBA/);
    assert.equal(await overflowOf(page), 0, 'halaman lacak tidak boleh meluber di 390px');

    // BUKTI di database & gateway tiruan: tepat satu pesanan, satu pembayaran pending, satu transaksi di gateway.
    const order = await orderRow(number);
    assert.equal(order.payment_method, 'qris');
    assert.equal(order.payment_status, 'pending');
    assert.equal(order.order_status, 'pending');
    assert.equal(order.total, 20000);
    const rows = await paymentRows(order.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending');
    assert.ok(rows[0].provider_transaction_id, 'referensi transaksi gateway harus tersimpan');
    assert.equal(fake.transactions.get(rows[0].provider_order_id).transaction_id, rows[0].provider_transaction_id);
    assert.equal(await orderCount(), ordersBefore + 1);
    assert.equal(await paymentCount(), paymentsBefore + 1);
    assert.equal(charges(), chargesBefore + 1);

    // Token rahasia hanya di fragment URL: tidak pernah ikut dalam URL permintaan ke server.
    assert.ok(page.requestedUrls.every((url) => !url.includes(token)), 'token tidak boleh muncul di URL permintaan mana pun');

    // Muat ulang beberapa kali: hanya MEMBACA. Tidak ada pesanan/pembayaran/transaksi baru.
    for (let i = 0; i < 2; i += 1) {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.qr-img');
      assert.equal((await page.locator('#track-number').innerText()).trim(), number);
    }
    assert.equal(await orderCount(), ordersBefore + 1, 'muat ulang tidak boleh membuat pesanan');
    assert.equal(await paymentCount(), paymentsBefore + 1, 'muat ulang tidak boleh membuat pembayaran');
    assert.equal(charges(), chargesBefore + 1, 'muat ulang tidak boleh membuat transaksi di gateway');
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Pembayaran dikonfirmasi gateway (webhook valid): halaman berubah jadi LUNAS otomatis; webhook berulang tidak mengubah apa pun', async () => {
    const page = await newPage(qris.baseUrl);
    const { number, order, payment } = await placeQrisOrderViaUi(page, { name: 'Pembeli Lunas', phone: '081377770002' });
    assert.equal(order.payment_status, 'pending');

    // Pelanggan "membayar" di sisi gateway; gateway mengirim notifikasi bertanda tangan.
    fake.setStatus(payment.provider_order_id, 'settlement');
    const notification = fake.notification(payment.provider_order_id);
    const first = await qris.notify(notification);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).outcome, 'applied');

    await waitForPayPill(page, 'Lunas'); // polling otomatis, tanpa memuat ulang
    assert.match(await page.locator('#pay-body').innerText(), /Pembayaran diterima/);
    assert.equal(await page.locator('.qr-img').count(), 0, 'QR tidak boleh tampil setelah lunas');
    assert.equal((await page.locator('#order-status-pill').innerText()).trim(), 'Menunggu Konfirmasi', 'status pesanan terpisah: toko belum memprosesnya');

    const paid = await orderRow(number);
    assert.equal(paid.payment_status, 'paid');
    assert.equal(paid.order_status, 'pending');
    assert.ok(paid.paid_at);
    const [row] = await paymentRows(paid.id);
    assert.equal(row.status, 'paid');
    assert.equal(row.provider_transaction_id, payment.provider_transaction_id);

    // Notifikasi yang sama dikirim ulang (retry gateway): tetap 200, tidak ada perubahan.
    const [[{ n: notificationsBefore }]] = await pool.query('SELECT COUNT(*) AS n FROM payment_notifications WHERE provider_order_id = ?', [payment.provider_order_id]);
    const replay = await qris.notify(notification);
    assert.equal(replay.status, 200);
    const [[{ n: notificationsAfter }]] = await pool.query('SELECT COUNT(*) AS n FROM payment_notifications WHERE provider_order_id = ?', [payment.provider_order_id]);
    assert.equal(notificationsAfter, notificationsBefore, 'notifikasi duplikat tidak boleh dicatat ulang');
    const after = await orderRow(number);
    assert.equal(after.payment_status, 'paid');
    assert.equal(String(after.paid_at), String(paid.paid_at), 'waktu lunas tidak boleh berubah karena notifikasi ulang');
    assert.equal((await paymentRows(paid.id)).length, 1);
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Browser tidak bisa membuat status lunas: "Saya sudah bayar" hanya bertanya ke gateway; notifikasi palsu ditolak', async () => {
    const page = await newPage(qris.baseUrl);
    const { number, order, payment } = await placeQrisOrderViaUi(page, { name: 'Belum Bayar', phone: '081377770003' });

    // Belum ada pembayaran di gateway: tombol cek hanya menampilkan "belum diterima".
    await page.click('#pay-check');
    await page.waitForFunction(() => document.querySelector('#pay-feedback').textContent.trim() !== '');
    assert.match(await page.locator('#pay-feedback').innerText(), /belum diterima/i);
    assert.equal((await payPill(page).innerText()).trim(), 'Menunggu Pembayaran');
    assert.equal((await orderRow(number)).payment_status, 'pending');

    // Notifikasi dengan tanda tangan salah (penyerang): ditolak, status tidak berubah.
    const forged = fake.notification(payment.provider_order_id, { transaction_status: 'settlement', signature_key: 'x'.repeat(128) });
    const response = await qris.notify(forged);
    assert.equal(response.status, 403);
    assert.equal((await orderRow(number)).payment_status, 'pending');

    // Notifikasi bertanda tangan valid tetapi gateway SENDIRI belum menyatakan lunas: tidak dipercaya begitu saja.
    const unconfirmed = await qris.notify(fake.notification(payment.provider_order_id, { transaction_status: 'settlement' }));
    assert.notEqual(unconfirmed.status, 200, 'tanpa konfirmasi status dari gateway, lunas tidak boleh diterima');
    assert.equal((await orderRow(number)).payment_status, 'pending');
    assert.equal((await paymentRows(order.id))[0].status, 'pending');

    // Pelanggan membayar sungguhan di gateway; kini tombol cek menemukan statusnya, TANPA menunggu webhook.
    fake.setStatus(payment.provider_order_id, 'settlement');
    await page.waitForTimeout(8500); // jeda minimum antar-pengecekan (server membatasi 8 detik per pembayaran)
    await page.click('#pay-check');
    await waitForPayPill(page, 'Lunas');
    assert.equal((await orderRow(number)).payment_status, 'paid');
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Gateway gagal saat checkout: pesanan TETAP tersimpan, halaman lacak menawarkan kode baru, tekan berulang tidak menggandakan transaksi', async () => {
    const page = await newPage(qris.baseUrl);
    fake.failNext('charge', 503);
    const ordersBefore = await orderCount();
    await checkoutViaUi(page, { name: 'Gateway Down', phone: '081377770004' });
    await page.click('#co-submit');
    await page.waitForURL(/\/track\.html#/, { timeout: 15000 });
    await page.waitForSelector('#pay-retry');
    assert.equal(await orderCount(), ordersBefore + 1);
    assert.equal(await page.locator('.qr-img').count(), 0, 'tidak boleh ada QR jika gateway gagal');
    assert.match(await page.locator('#pay-body').innerText(), /belum berhasil/i);
    assert.notEqual((await payPill(page).innerText()).trim(), 'Lunas (Terverifikasi)');
    const number = (await page.locator('#track-number').innerText()).trim();
    const order = await orderRow(number);
    assert.equal(order.payment_status, 'failed');

    // Tekan beberapa kali dengan cepat: hanya satu kode baru yang dibuat.
    const chargesBefore = charges();
    await page.evaluate(() => {
      const button = document.querySelector('#pay-retry');
      for (let i = 0; i < 4; i += 1) button.click();
    });
    await page.waitForSelector('.qr-img', { timeout: 15000 });
    assert.equal(charges(), chargesBefore + 1, 'hanya satu transaksi baru ke gateway');
    const rows = await paymentRows(order.id);
    assert.deepEqual(rows.map((row) => row.status), ['failed', 'pending']);
    assert.equal((await payPill(page).innerText()).trim(), 'Menunggu Pembayaran');
    assert.deepEqual(page.problems, []);
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Pembayaran kedaluwarsa di gateway: halaman menampilkan kedaluwarsa & pesanan dibatalkan; tidak ada tombol bayar', async () => {
    const page = await newPage(qris.baseUrl);
    const { number, order, payment } = await placeQrisOrderViaUi(page, { name: 'Kedaluwarsa', phone: '081377770005' });
    fake.setStatus(payment.provider_order_id, 'expire');
    const response = await qris.notify(fake.notification(payment.provider_order_id, { transaction_status: 'expire' }));
    assert.equal(response.status, 200);

    await waitForPayPill(page, 'Kedaluwarsa');
    assert.equal((await page.locator('#order-status-pill').innerText()).trim(), 'Dibatalkan');
    assert.equal(await page.locator('.qr-img').count(), 0);
    assert.equal(await page.locator('#pay-check').count(), 0);
    assert.equal(await page.locator('#pay-retry').count(), 0, 'pesanan yang kedaluwarsa tidak boleh bisa dibayar lagi');
    assert.match(await page.locator('#pay-body').innerText(), /Waktu pembayaran habis/);
    assert.equal((await orderRow(number)).order_status, 'cancelled');
    assert.equal((await paymentRows(order.id))[0].status, 'expired');
    await page.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Akses lacak: token acak atau nomor pesanan + WhatsApp; kegagalan tidak membocorkan apa pun', async () => {
    const owner = await newPage(qris.baseUrl);
    const { number, token } = await placeQrisOrderViaUi(owner, { name: 'Pemilik Pesanan', phone: '081377770006' });
    await owner.context().close();

    // (a) tanpa token: formulir cari manual
    const page = await newPage(`${qris.baseUrl}/track.html`, { width: 390, height: 844 }, { goto: false });
    await page.goto(`${qris.baseUrl}/track.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#track-lookup:not([hidden])');
    assert.equal(await page.locator('#track-result').isHidden(), true);

    // nomor WhatsApp salah -> pesan SAMA seperti nomor pesanan tidak ada (tidak membocorkan keberadaan pesanan)
    await page.fill('#lookup-number', number);
    await page.fill('#lookup-phone', '081399990000');
    await page.click('#lookup-submit');
    await page.waitForSelector('#lookup-alert:not([hidden])');
    const wrongPhone = await page.locator('#lookup-alert').innerText();
    assert.match(wrongPhone, /Pesanan tidak ditemukan/);
    await page.fill('#lookup-number', 'RB-261009-ZZZZZ');
    await page.fill('#lookup-phone', '081377770006');
    await page.click('#lookup-submit');
    await page.waitForFunction((previous) => document.querySelector('#lookup-alert').textContent !== '' && !document.querySelector('#lookup-submit').disabled, wrongPhone);
    assert.equal(await page.locator('#lookup-alert').innerText(), wrongPhone, 'pesan harus sama untuk nomor pesanan yang tidak ada');
    assert.equal(await page.locator('#track-result').isHidden(), true);

    // format nomor pesanan salah -> validasi di formulir
    await page.fill('#lookup-number', 'abc');
    await page.click('#lookup-submit');
    assert.match(await page.locator('#lookup-number-error').innerText(), /tidak valid/);

    // pasangan yang benar (nomor pesanan huruf kecil pun diterima)
    await page.fill('#lookup-number', number.toLowerCase());
    await page.fill('#lookup-phone', '0813-7777-0006');
    await page.click('#lookup-submit');
    await page.waitForSelector('#track-result:not([hidden])');
    assert.equal((await page.locator('#track-number').innerText()).trim(), number);
    assert.equal(await overflowOf(page), 0);
    await page.context().close();

    // (b) token benar -> tampil; token salah/rusak -> tidak tampil
    const tokenPage = await newPage(`${qris.baseUrl}/track.html`, undefined, { goto: false });
    await tokenPage.goto(`${qris.baseUrl}/track.html#${token}`, { waitUntil: 'domcontentloaded' });
    await tokenPage.waitForSelector('#track-result:not([hidden])');
    assert.equal((await tokenPage.locator('#track-number').innerText()).trim(), number);

    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    await tokenPage.goto(`${qris.baseUrl}/track.html#${flipped}`, { waitUntil: 'domcontentloaded' });
    await tokenPage.reload({ waitUntil: 'domcontentloaded' });
    await tokenPage.waitForSelector('#track-error:not([hidden])');
    assert.match(await tokenPage.locator('#track-error').innerText(), /tidak ditemukan/i);
    assert.equal(await tokenPage.locator('#track-result').isHidden(), true);

    await tokenPage.goto(`${qris.baseUrl}/track.html#bukan-token`, { waitUntil: 'domcontentloaded' });
    await tokenPage.reload({ waitUntil: 'domcontentloaded' });
    await tokenPage.waitForSelector('#track-lookup:not([hidden])');
    assert.match(await tokenPage.locator('#lookup-alert').innerText(), /tidak valid/i);
    await tokenPage.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Metode lama tetap jalan di server ber-QRIS: tunai & transfer manual, dengan tautan lacak tanpa panel QR', async () => {
    const page = await newPage(qris.baseUrl);
    const chargesBefore = charges();
    const paymentsBefore = await paymentCount();

    // QRIS muncul sebagai salah satu pilihan di samping metode lama
    await checkoutViaUi(page, { name: 'Pembeli Tunai', phone: '081377770007', payment: 'cod' });
    const values = await page.locator('input[name="payment_method"]').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.deepEqual(values.sort(), ['bank_transfer', 'cod', 'qris']);
    await page.click('#co-submit');
    await page.waitForSelector('#checkout-success:not([hidden])');
    const number = (await page.locator('#success-number').innerText()).trim();
    const order = await orderRow(number);
    assert.equal(order.payment_method, 'cod');
    assert.equal(order.payment_status, 'unpaid', 'tunai: tidak otomatis lunas');
    assert.equal(charges(), chargesBefore, 'metode lama tidak boleh memanggil gateway');
    assert.equal(await paymentCount(), paymentsBefore);

    // WhatsApp tetap ada (nomor pesanan + ringkasan), tanpa token rahasia
    const wa = await page.locator('#success-whatsapp').getAttribute('href');
    // Nomor yang dipakai = nomor di pengaturan SAAT INI (skenario admin boleh mengubahnya), bukan angka yang di-hardcode.
    const [[{ setting_value: configuredWhatsapp }]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'whatsapp_number'");
    assert.ok(/^62\d{8,13}$/.test(configuredWhatsapp));
    assert.equal(wa.split('?')[0], `https://wa.me/${configuredWhatsapp}`);
    assert.ok(wa.includes('?text='));
    const decoded = decodeURIComponent(wa);
    assert.ok(decoded.includes(number));
    assert.ok(decoded.includes('Nasi Uji'));
    const trackHref = await page.locator('#success-track').getAttribute('href');
    assert.match(trackHref, /^\/track\.html#[A-Za-z0-9_-]{43}$/);
    assert.ok(!decoded.includes(trackHref.split('#')[1]), 'token rahasia tidak boleh masuk pesan WhatsApp');

    // Tautan lacak: tampil tanpa panel QRIS; status pembayaran belum dibayar; pesanan menunggu konfirmasi
    await page.click('#success-track');
    await page.waitForSelector('#track-result:not([hidden])');
    assert.equal(await page.locator('#pay-panel').isHidden(), true);
    assert.equal((await payPill(page).innerText()).trim(), 'Belum Dibayar');
    assert.equal((await page.locator('#order-status-pill').innerText()).trim(), 'Menunggu Konfirmasi');
    assert.equal(await page.locator('#track-whatsapp').isVisible(), true);
    await page.context().close();

    // Transfer manual juga masih berjalan
    const transfer = await newPage(qris.baseUrl);
    await checkoutViaUi(transfer, { name: 'Pembeli Transfer', phone: '081377770008', payment: 'bank_transfer' });
    assert.match(await transfer.locator('#co-payment-info').innerText(), /Bank Uji/);
    await transfer.click('#co-submit');
    await transfer.waitForSelector('#checkout-success:not([hidden])');
    const transferNumber = (await transfer.locator('#success-number').innerText()).trim();
    assert.equal((await orderRow(transferNumber)).payment_status, 'unpaid');
    assert.equal(charges(), chargesBefore);
    await transfer.context().close();
  });

  // ------------------------------------------------------------------
  await scenario('Server tanpa kredensial gateway: QRIS tidak ditawarkan sama sekali (tidak ada tombol palsu)', async () => {
    const page = await newPage(server.baseUrl);
    const nasi = await productId('Nasi Uji');
    await page.locator(`[data-add="${nasi}"]`).click();
    await page.click('#cart-btn');
    await page.click('#checkout-btn');
    await page.waitForSelector('#checkout-dialog[open]');
    const values = await page.locator('input[name="payment_method"]').evaluateAll((inputs) => inputs.map((input) => input.value));
    assert.ok(!values.includes('qris'), `QRIS tidak boleh tampil tanpa gateway, ada: ${values}`);
    assert.ok(values.includes('cod'));
    await page.context().close();
  });
}
