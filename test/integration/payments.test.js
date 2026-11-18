// Test integrasi pembayaran QRIS + lacak pesanan.
// Memakai server MySQL sungguhan, server aplikasi sungguhan, dan SERVER MIDTRANS TIRUAN lokal (test/fakeMidtrans.js).
// Ini membuktikan kode kita konsisten dengan kontrak Midtrans yang didokumentasikan — BUKAN bahwa akun Midtrans
// sungguhan sudah berhasil menerima pembayaran.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { FAKE_SERVER_KEY, startFakeMidtrans } from '../fakeMidtrans.js';
import {
  clearData,
  countRows,
  createAdmin,
  insertProduct,
  orderPayload,
  prepareDatabase,
  setSettings,
  startTestServer,
  stockOf,
} from '../helpers.js';

let fake;
let ctx;
let client;

before(async () => {
  fake = await startFakeMidtrans();
  ctx = await startTestServer({
    PAYMENT_PROVIDER: 'midtrans',
    PAYMENT_SERVER_KEY: FAKE_SERVER_KEY,
    PAYMENT_API_BASE_URL: fake.baseUrl,
    PAYMENT_QRIS_EXPIRY_MINUTES: '15',
  });
  await prepareDatabase(ctx.config);
  client = ctx.client();
});
after(async () => {
  await ctx.stop();
  await fake.stop();
});
beforeEach(async () => {
  await clearData(ctx.pool);
  fake.transactions.clear();
  fake.requests.length = 0;
});

// ------------------------------------------------------------------------------------------ alat bantu
const NOTIFICATION_PATH = '/api/payments/midtrans/notification';
const hook = (body) => client.post(NOTIFICATION_PATH, body);

async function placeQrisOrder({ stock = 10, track = 1, price = 20000, quantity = 1, overrides = {} } = {}) {
  const product = await insertProduct(ctx.pool, { price, stock, track_stock: track });
  const payload = orderPayload([{ product_id: product.id, quantity, price }], { payment_method: 'qris', ...overrides });
  const response = await client.post('/api/orders', payload);
  return { response, product, payload, token: response.data?.tracking_token, order: response.data?.order };
}

const orderRow = async (orderNumber) => (await ctx.pool.execute('SELECT * FROM orders WHERE order_number = ?', [orderNumber]))[0][0];
const paymentRows = async (orderId) => (await ctx.pool.execute('SELECT * FROM payments WHERE order_id = ? ORDER BY id', [orderId]))[0];
const eventsOf = async (orderId) => (await ctx.pool.execute('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', [orderId]))[0];
const providerOrderIdOf = async (orderNumber) => {
  const order = await orderRow(orderNumber);
  return (await paymentRows(order.id)).at(-1).provider_order_id;
};

/** Pelanggan "membayar" di Midtrans lalu Midtrans mengirim webhook. */
async function payViaWebhook(providerOrderId) {
  fake.setStatus(providerOrderId, 'settlement');
  return hook(fake.notification(providerOrderId));
}

const track = (token) => client.post('/api/orders/track', { token });

async function ownerClient() {
  await createAdmin(ctx);
  const owner = ctx.client();
  assert.equal((await owner.login()).status, 200);
  return owner;
}

// ------------------------------------------------------------------------------------------ konfigurasi
describe('QRIS: ketersediaan', () => {
  test('ditawarkan di /api/config saat gateway terkonfigurasi, dengan mode sandbox', async () => {
    const { data } = await client.get('/api/config');
    const qris = data.ordering.payment_methods.find((method) => method.value === 'qris');
    assert.ok(qris);
    assert.equal(qris.mode, 'sandbox');
    assert.equal(qris.expiry_minutes, 15);
    assert.ok(!JSON.stringify(data).includes(FAKE_SERVER_KEY), 'kunci rahasia tidak boleh muncul di config publik');
  });

  test('pemilik bisa menonaktifkan QRIS: hilang dari config dan pesanan QRIS ditolak', async () => {
    await setSettings(ctx.pool, { payment_qris_enabled: false });
    const { data } = await client.get('/api/config');
    assert.ok(!data.ordering.payment_methods.some((method) => method.value === 'qris'));
    const { response } = await placeQrisOrder();
    assert.equal(response.status, 400);
    assert.equal(fake.count('POST', /charge/), 0);
  });

  test('tanpa payment gateway terkonfigurasi: QRIS tidak ditawarkan dan pesanan QRIS ditolak', async () => {
    const plain = await startTestServer({}, { paymentProvider: null });
    try {
      const anon = plain.client();
      const config = (await anon.get('/api/config')).data;
      assert.ok(!config.ordering.payment_methods.some((method) => method.value === 'qris'));
      const product = await insertProduct(plain.pool, { price: 10000 });
      const response = await anon.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 1, price: 10000 }], { payment_method: 'qris' }));
      assert.equal(response.status, 400);
      assert.equal((await anon.post(NOTIFICATION_PATH, fake.notification('X-1', { gross_amount: '1.00' }))).status, 404);
    } finally {
      await plain.stop();
    }
  });
});

// ------------------------------------------------------------------------------------------ checkout QRIS
describe('QRIS: membuat pesanan dan pembayaran', () => {
  test('pesanan QRIS: pembayaran pending, QR dari gateway, nominal = total server, stok berkurang sekali', async () => {
    const { response, product, token } = await placeQrisOrder({ price: 20000, quantity: 2, stock: 10 });
    assert.equal(response.status, 201);
    const { order, payment, payment_error: paymentError } = response.data;
    assert.equal(paymentError, null);
    assert.equal(order.payment_method, 'qris');
    assert.equal(order.payment_status, 'pending'); // pembayaran terpisah dari status pesanan
    assert.equal(order.order_status, 'pending');
    assert.equal(order.total, 40000);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(payment.status, 'pending');
    assert.equal(payment.qr_ready, true);
    assert.equal(payment.amount, 40000);
    assert.equal(payment.mode, 'sandbox');
    assert.ok(new Date(payment.expires_at) > new Date());
    assert.equal(await stockOf(ctx.pool, product.id), 8);

    // Yang dikirim ke gateway: order_id unik per percobaan, nominal dari database, Basic auth dengan server key.
    const charge = fake.requests.find((request) => request.path === '/v2/charge');
    assert.equal(charge.authorized, true);
    assert.equal(charge.body.payment_type, 'qris');
    assert.equal(charge.body.transaction_details.order_id, `${order.order_number}-1`);
    assert.equal(charge.body.transaction_details.gross_amount, 40000);
    assert.equal(fake.count('POST', /^\/v2\/charge$/), 1);

    const row = await orderRow(order.order_number);
    const [paymentRow] = await paymentRows(row.id);
    assert.equal(paymentRow.provider, 'midtrans');
    assert.equal(paymentRow.status, 'pending');
    assert.equal(paymentRow.amount, 40000);
    assert.ok(paymentRow.provider_transaction_id, 'referensi transaksi gateway tersimpan');
    assert.ok(paymentRow.qr_url.startsWith(fake.baseUrl));
    assert.ok(row.payment_expires_at > new Date());
    assert.equal(row.paid_at, null);
  });

  test('respons pesanan tidak membocorkan kunci rahasia, qr_url mentah, atau data gateway', async () => {
    const { response } = await placeQrisOrder();
    const json = JSON.stringify(response.data);
    assert.ok(!json.includes(FAKE_SERVER_KEY));
    assert.ok(!json.includes(fake.baseUrl), 'URL QR mentah tidak dikirim ke browser');
    assert.ok(!('qr_url' in response.data.payment));
  });

  test('klik ganda / retry dengan kunci sama: satu pesanan, satu pembayaran, satu transaksi di gateway', async () => {
    const product = await insertProduct(ctx.pool, { price: 15000, stock: 20, track_stock: 1 });
    const payload = orderPayload([{ product_id: product.id, quantity: 1, price: 15000 }], { payment_method: 'qris' });
    const responses = await Promise.all(Array.from({ length: 6 }, () => client.post('/api/orders', payload)));
    assert.ok(responses.every((response) => [200, 201].includes(response.status)), JSON.stringify(responses.map((r) => r.status)));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(new Set(responses.map((response) => response.data.order.order_number)).size, 1);
    assert.equal(new Set(responses.map((response) => response.data.tracking_token)).size, 1);
    assert.equal(await countRows(ctx.pool, 'orders'), 1);
    assert.equal(await countRows(ctx.pool, 'payments'), 1);
    assert.equal(fake.count('POST', /^\/v2\/charge$/), 1);
    assert.equal(await stockOf(ctx.pool, product.id), 19);
  });

  test('memuat ulang halaman lacak / "buat ulang QRIS" saat masih pending tidak membuat pembayaran baru', async () => {
    const { token } = await placeQrisOrder();
    for (let i = 0; i < 3; i += 1) {
      const response = await client.post('/api/orders/track/retry-payment', { token });
      assert.equal(response.status, 200);
      assert.equal(response.data.payment.status, 'pending');
    }
    await Promise.all(Array.from({ length: 4 }, () => track(token)));
    assert.equal(await countRows(ctx.pool, 'payments'), 1);
    assert.equal(fake.count('POST', /^\/v2\/charge$/), 1);
  });

  test('harga berubah / stok kurang tetap divalidasi: tidak ada pembayaran dibuat', async () => {
    const product = await insertProduct(ctx.pool, { price: 20000, stock: 1, track_stock: 1 });
    const stale = await client.post(
      '/api/orders',
      orderPayload([{ product_id: product.id, quantity: 1, price: 20000 }], { payment_method: 'qris', expected_total: 1000 }),
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.data.error.code, 'PRICE_CHANGED');
    const tooMany = await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 5, price: 20000 }], { payment_method: 'qris' }));
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.data.error.code, 'CART_INVALID');
    assert.equal(await countRows(ctx.pool, 'orders'), 0);
    assert.equal(await countRows(ctx.pool, 'payments'), 0);
    assert.equal(fake.count('POST', /^\/v2\/charge$/), 0);
    assert.equal(await stockOf(ctx.pool, product.id), 1);
  });

  test('gateway error saat membuat QRIS: pesanan tetap ada, pembayaran "failed", lalu bisa dicoba lagi tanpa transaksi ganda', async () => {
    fake.failNext('charge', 503);
    const { response, product, token } = await placeQrisOrder({ stock: 5 });
    assert.equal(response.status, 201);
    assert.equal(response.data.payment_error.code, 'PAYMENT_PROVIDER_ERROR');
    assert.equal(response.data.payment.status, 'failed');
    assert.equal(response.data.payment.can_retry, true);
    assert.equal(response.data.order.payment_status, 'failed');
    assert.equal(await stockOf(ctx.pool, product.id), 4, 'stok ditahan sampai batas waktu bayar');

    const retry = await client.post('/api/orders/track/retry-payment', { token });
    assert.equal(retry.status, 201);
    assert.equal(retry.data.payment.status, 'pending');
    assert.equal(retry.data.payment.qr_ready, true);
    assert.equal(retry.data.order.payment_status, 'pending');

    const rows = await paymentRows((await orderRow(response.data.order.order_number)).id);
    assert.deepEqual(rows.map((row) => [row.status, row.provider_order_id.endsWith(`-${rows.indexOf(row) + 1}`)]), [['failed', true], ['pending', true]]);
    // klik ulang tidak menambah percobaan
    await client.post('/api/orders/track/retry-payment', { token });
    assert.equal(await countRows(ctx.pool, 'payments'), 2);
  });

  test('kredensial gateway salah (401): pesanan tidak hilang, kunci tidak bocor ke pelanggan maupun database', async () => {
    const wrongKey = await startTestServer({
      PAYMENT_PROVIDER: 'midtrans',
      PAYMENT_SERVER_KEY: 'SB-Mid-server-SALAH-TOTAL',
      PAYMENT_API_BASE_URL: fake.baseUrl,
    });
    try {
      const anon = wrongKey.client();
      const product = await insertProduct(wrongKey.pool, { price: 10000 });
      const response = await anon.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 1, price: 10000 }], { payment_method: 'qris' }));
      assert.equal(response.status, 201);
      assert.equal(response.data.payment_error.code, 'PAYMENT_PROVIDER_ERROR');
      assert.ok(!JSON.stringify(response.data).includes('SALAH-TOTAL'));
      const [[row]] = await wrongKey.pool.query('SELECT failure_reason FROM payments');
      assert.ok(!String(row.failure_reason).includes('SALAH-TOTAL'));
      assert.match(row.failure_reason, /kredensial/i);
    } finally {
      await wrongKey.stop();
    }
  });
});

// ------------------------------------------------------------------------------------------ webhook
describe('QRIS: webhook', () => {
  test('webhook valid (settlement): pesanan lunas, waktu bayar tercatat, riwayat tercatat', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    const response = await payViaWebhook(providerOrderId);
    assert.equal(response.status, 200);
    assert.equal(response.data.outcome, 'applied');

    const row = await orderRow(order.order_number);
    assert.equal(row.payment_status, 'paid');
    assert.ok(row.paid_at instanceof Date);
    assert.equal(row.order_status, 'pending', 'status pesanan tidak otomatis berubah; admin yang memproses');
    const [payment] = await paymentRows(row.id);
    assert.equal(payment.status, 'paid');
    assert.ok(payment.paid_at);
    assert.equal(payment.provider_status, 'settlement');
    const events = await eventsOf(row.id);
    assert.ok(events.some((event) => event.event_type === 'payment' && event.to_value === 'paid'));
    // Sebelum menandai lunas, status dikonfirmasi ulang ke API status gateway.
    assert.equal(fake.count('GET', /\/status$/), 1);
  });

  test('tanda tangan salah ditolak (403): tidak ada perubahan dan tidak ada catatan notifikasi', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'settlement');

    const forged = fake.notification(providerOrderId, { signature_key: 'f'.repeat(128) });
    assert.equal((await hook(forged)).status, 403);
    // tanda tangan dari kunci yang salah
    const body = fake.notification(providerOrderId);
    const otherKey = crypto.createHash('sha512').update(`${providerOrderId}200${body.gross_amount}kunci-lain`).digest('hex');
    assert.equal((await hook({ ...body, signature_key: otherKey })).status, 403);
    // field yang ditandatangani diubah setelah ditandatangani (nominal dikecilkan)
    assert.equal((await hook({ ...body, gross_amount: '1.00' })).status, 403);
    // tanpa tanda tangan sama sekali
    const { signature_key: _removed, ...unsigned } = body;
    assert.equal((await hook(unsigned)).status, 403);

    assert.equal((await orderRow(order.order_number)).payment_status, 'pending');
    assert.equal(await countRows(ctx.pool, 'payment_notifications'), 0);
    assert.equal(fake.count('GET', /\/status$/), 0, 'notifikasi palsu tidak memicu panggilan ke gateway');
  });

  test('isi notifikasi rusak: 400', async () => {
    assert.equal((await client.post(NOTIFICATION_PATH, ['bukan', 'objek'])).status, 400);
    assert.equal((await client.post(NOTIFICATION_PATH, {})).status, 403);
  });

  test('webhook sama dikirim berulang: efek hanya sekali (satu catatan, satu peristiwa lunas, waktu bayar tidak berubah)', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    const body = (fake.setStatus(providerOrderId, 'settlement'), fake.notification(providerOrderId));

    const first = await hook(body);
    assert.equal(first.data.outcome, 'applied');
    const paidAt = (await orderRow(order.order_number)).paid_at.getTime();
    const eventsBefore = (await eventsOf((await orderRow(order.order_number)).id)).length;

    for (let i = 0; i < 3; i += 1) {
      const again = await hook(body);
      assert.equal(again.status, 200, 'balasan 2xx supaya gateway berhenti mengirim ulang');
      assert.equal(again.data.outcome, 'duplicate_notification');
    }
    assert.equal(await countRows(ctx.pool, 'payment_notifications'), 1);
    assert.equal((await orderRow(order.order_number)).paid_at.getTime(), paidAt);
    assert.equal((await eventsOf((await orderRow(order.order_number)).id)).length, eventsBefore);
    assert.equal((await paymentRows((await orderRow(order.order_number)).id)).length, 1);
  });

  test('10 webhook identik bersamaan: tepat satu yang diterapkan', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    const body = (fake.setStatus(providerOrderId, 'settlement'), fake.notification(providerOrderId));
    const responses = await Promise.all(Array.from({ length: 10 }, () => hook(body)));
    assert.ok(responses.every((response) => response.status === 200), JSON.stringify(responses.map((r) => [r.status, r.data])));
    const outcomes = responses.map((response) => response.data.outcome);
    assert.equal(outcomes.filter((outcome) => outcome === 'applied').length, 1);
    assert.equal(await countRows(ctx.pool, 'payment_notifications'), 1);
    const events = await eventsOf((await orderRow(order.order_number)).id);
    assert.equal(events.filter((event) => event.event_type === 'payment' && event.to_value === 'paid').length, 1);
  });

  test('status sama tapi kiriman berbeda: no-op (duplicate_status), tidak mengubah apa pun', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    await payViaWebhook(providerOrderId);
    const paidAt = (await orderRow(order.order_number)).paid_at.getTime();
    const response = await hook(fake.notification(providerOrderId, { settlement_time: '2026-10-16 10:05:00', transaction_time: '2026-10-16 10:04:59' }));
    assert.equal(response.data.outcome, 'duplicate_status');
    assert.equal((await orderRow(order.order_number)).paid_at.getTime(), paidAt);
  });

  test('tidak berurutan: "pending" yang terlambat tiba setelah "lunas" tidak memundurkan status', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    await payViaWebhook(providerOrderId);
    const late = await hook(fake.notification(providerOrderId, { transaction_status: 'pending', status_code: '201' }));
    assert.equal(late.status, 200);
    assert.equal(late.data.outcome, 'out_of_order');
    const row = await orderRow(order.order_number);
    assert.equal(row.payment_status, 'paid');
    assert.equal((await paymentRows(row.id))[0].status, 'paid');
  });

  test('settlement tetapi API status gateway belum membenarkan: 503 (gateway akan mengirim ulang), status tidak berubah', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    // Server tiruan masih "pending": notifikasi lunas tidak boleh dipercaya begitu saja.
    const response = await hook(fake.notification(providerOrderId, { transaction_status: 'settlement' }));
    assert.equal(response.status, 503);
    assert.equal(response.data.error.code, 'PAYMENT_NOT_CONFIRMED');
    assert.equal((await orderRow(order.order_number)).payment_status, 'pending');
    assert.equal(await countRows(ctx.pool, 'payment_notifications'), 0, 'kegagalan tidak meninggalkan catatan, jadi retry diproses ulang');
  });

  test('API status gateway sedang tidak bisa dihubungi: 503; retry berikutnya berhasil', async () => {
    const { order } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'settlement');
    fake.failNext('status', 503);
    const body = fake.notification(providerOrderId);
    const failed = await hook(body);
    assert.equal(failed.status, 503);
    assert.equal((await orderRow(order.order_number)).payment_status, 'pending');
    const retried = await hook(body);
    assert.equal(retried.status, 200);
    assert.equal(retried.data.outcome, 'applied');
    assert.equal((await orderRow(order.order_number)).payment_status, 'paid');
  });

  test('nominal tidak cocok (tanda tangan valid): status TIDAK berubah dan ditandai untuk ditinjau admin', async () => {
    const { order } = await placeQrisOrder({ price: 20000 });
    const providerOrderId = await providerOrderIdOf(order.order_number);
    // Notifikasi expire dengan nominal salah (tidak melewati API status) — juga ditolak.
    const response = await hook(fake.notification(providerOrderId, { transaction_status: 'expire', gross_amount: '5000.00' }));
    assert.equal(response.status, 200);
    assert.equal(response.data.outcome, 'amount_mismatch');
    const row = await orderRow(order.order_number);
    assert.equal(row.payment_status, 'pending');
    assert.equal(row.order_status, 'pending');
    const [payment] = await paymentRows(row.id);
    assert.equal(payment.status, 'pending');
    assert.match(payment.review_note, /Nominal/);

    // Daftar pesanan admin menandai pesanan ini "perlu ditinjau"
    const owner = await ownerClient();
    const listed = (await owner.get('/api/admin/orders?payment_status=pending')).data.items.find((item) => item.order_number === order.order_number);
    assert.equal(listed.needs_review, true);
  });

  test('nominal lunas dari gateway berbeda dengan pesanan: tidak ditandai lunas', async () => {
    const { order } = await placeQrisOrder({ price: 20000 });
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'settlement');
    fake.transactions.get(providerOrderId).gross_amount = 1000; // gateway melaporkan nominal lain
    const response = await hook(fake.notification(providerOrderId));
    assert.equal(response.data.outcome, 'amount_mismatch');
    assert.equal((await orderRow(order.order_number)).payment_status, 'pending');
  });

  test('order_id tidak dikenal (tanda tangan valid): diabaikan dengan 200, tidak ada perubahan', async () => {
    const { order } = await placeQrisOrder();
    const unknown = fake.notification('RB-999999-ZZZZZ-1', { transaction_status: 'settlement', gross_amount: '20000.00', transaction_id: crypto.randomUUID() });
    const response = await hook(unknown);
    assert.equal(response.status, 200);
    assert.equal(response.data.outcome, 'unknown_payment');
    assert.equal((await orderRow(order.order_number)).payment_status, 'pending');
  });

  test('expire: pembayaran kedaluwarsa, pesanan dibatalkan, stok kembali SEKALI saja', async () => {
    const { order, product } = await placeQrisOrder({ quantity: 3, stock: 10 });
    assert.equal(await stockOf(ctx.pool, product.id), 7);
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'expire');

    const body = fake.notification(providerOrderId);
    assert.equal((await hook(body)).data.outcome, 'applied');
    const row = await orderRow(order.order_number);
    assert.equal(row.order_status, 'cancelled');
    assert.equal(row.payment_status, 'expired');
    assert.match(row.cancel_reason, /kedaluwarsa/i);
    assert.equal(await stockOf(ctx.pool, product.id), 10);

    // diulang & variasi: stok tidak bertambah lagi
    await hook(body);
    await hook(fake.notification(providerOrderId, { transaction_time: '2026-10-16 10:09:00' }));
    assert.equal(await stockOf(ctx.pool, product.id), 10);
    // dan admin tidak bisa membatalkan lagi (status akhir) sehingga stok tak mungkin kembali dua kali
    const owner = await ownerClient();
    const cancel = await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'cancelled' });
    assert.equal(cancel.status, 409);
    assert.equal(await stockOf(ctx.pool, product.id), 10);
  });

  test('deny/failure: pembayaran gagal, pesanan tetap menunggu dan stok ditahan; pelanggan bisa membuat QRIS baru', async () => {
    const { order, product, token } = await placeQrisOrder({ stock: 5 });
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'deny');
    assert.equal((await hook(fake.notification(providerOrderId))).data.outcome, 'applied');

    const row = await orderRow(order.order_number);
    assert.equal(row.payment_status, 'failed');
    assert.equal(row.order_status, 'pending');
    assert.equal(await stockOf(ctx.pool, product.id), 4);
    const view = (await track(token)).data;
    assert.equal(view.payment.status, 'failed');
    assert.equal(view.payment.can_retry, true);

    const retry = await client.post('/api/orders/track/retry-payment', { token });
    assert.equal(retry.status, 201);
    assert.equal(retry.data.payment.status, 'pending');
  });

  test('pembayaran terlambat: lunas setelah pesanan kedaluwarsa/dibatalkan tetap tercatat, ditandai perlu refund, bukan pendapatan', async () => {
    const { order, product } = await placeQrisOrder({ price: 25000, stock: 5 });
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'expire');
    await hook(fake.notification(providerOrderId));
    assert.equal(await stockOf(ctx.pool, product.id), 5);

    // Pelanggan ternyata membayar (mis. QR lama) dan gateway melaporkan settlement.
    fake.setStatus(providerOrderId, 'settlement');
    const late = await hook(fake.notification(providerOrderId));
    assert.equal(late.data.outcome, 'applied');

    const row = await orderRow(order.order_number);
    assert.equal(row.order_status, 'cancelled', 'pesanan tidak dihidupkan lagi');
    assert.equal(row.payment_status, 'paid', 'uang yang masuk tercatat');
    assert.equal(await stockOf(ctx.pool, product.id), 5, 'stok tidak berubah lagi');
    const [payment] = await paymentRows(row.id);
    assert.match(payment.review_note, /DIBAYAR SETELAH/);

    const owner = await ownerClient();
    const summary = (await owner.get('/api/admin/summary')).data;
    assert.equal(summary.attention.paid_but_cancelled, 1);
    assert.equal(summary.attention.payments_need_review, 1);
    assert.equal(summary.totals.verified_paid, 0, 'pesanan dibatalkan tidak dihitung sebagai pendapatan');

    // Setelah refund di dashboard gateway, admin bisa mencatat "Dikembalikan".
    const refunded = await owner.patch(`/api/admin/orders/${row.id}/payment`, { payment_status: 'refunded', note: 'Refund via dashboard' });
    assert.equal(refunded.status, 200);
    assert.equal(refunded.data.order.payment_status, 'refunded');
    assert.equal((await owner.get('/api/admin/summary')).data.attention.payments_need_review, 0);
  });

  test('pembayaran ganda: percobaan lama yang ikut lunas ditandai ganda, pesanan tetap lunas sekali', async () => {
    const { order, token } = await placeQrisOrder({ price: 18000 });
    const firstId = await providerOrderIdOf(order.order_number);
    fake.setStatus(firstId, 'deny');
    await hook(fake.notification(firstId));
    await client.post('/api/orders/track/retry-payment', { token });
    const secondId = await providerOrderIdOf(order.order_number);
    assert.notEqual(firstId, secondId);

    await payViaWebhook(secondId);
    const row = await orderRow(order.order_number);
    const paidAt = row.paid_at.getTime();
    assert.equal(row.payment_status, 'paid');

    // Percobaan pertama ternyata juga dibayar pelanggan.
    fake.setStatus(firstId, 'settlement');
    const dup = await hook(fake.notification(firstId));
    assert.equal(dup.data.outcome, 'applied');
    const rows = await paymentRows(row.id);
    assert.deepEqual(rows.map((payment) => payment.status), ['paid', 'paid']);
    assert.match(rows[0].review_note, /PEMBAYARAN GANDA/);
    assert.equal((await orderRow(order.order_number)).paid_at.getTime(), paidAt);
    const owner = await ownerClient();
    assert.equal((await owner.get('/api/admin/summary')).data.totals.verified_paid, 18000, 'dihitung sekali');
  });

  test('QR lama yang masih pending ikut ditutup saat percobaan lain sudah lunas (satu pembayaran aktif per pesanan)', async () => {
    const { order, token } = await placeQrisOrder();
    const firstId = await providerOrderIdOf(order.order_number);
    // percobaan pertama gagal di gateway, pelanggan membuat percobaan kedua
    fake.setStatus(firstId, 'cancel');
    await hook(fake.notification(firstId));
    await client.post('/api/orders/track/retry-payment', { token });
    const secondId = await providerOrderIdOf(order.order_number);
    assert.equal((await paymentRows((await orderRow(order.order_number)).id)).filter((p) => p.status === 'pending').length, 1);

    // percobaan pertama ternyata lunas lebih dulu (terlambat tiba): yang kedua harus ditutup
    fake.setStatus(firstId, 'settlement');
    await hook(fake.notification(firstId));
    const rows = await paymentRows((await orderRow(order.order_number)).id);
    assert.deepEqual(rows.map((payment) => payment.status), ['paid', 'cancelled']);
    assert.equal(fake.transactions.get(secondId).status, 'expire', 'transaksi kedua ditutup di gateway');
  });

  test('database menolak dua pembayaran pending untuk satu pesanan (penjaga terakhir)', async () => {
    const { order } = await placeQrisOrder();
    const row = await orderRow(order.order_number);
    await assert.rejects(
      ctx.pool.execute("INSERT INTO payments (order_id, provider, provider_order_id, amount, status) VALUES (?, 'midtrans', 'X-DUP-1', ?, 'pending')", [row.id, row.total]),
      (error) => error.code === 'ER_DUP_ENTRY',
    );
  });
});

// ------------------------------------------------------------------------------------------ cek status & sweeper
describe('QRIS: cek status ke gateway dan pembatalan otomatis', () => {
  test('"cek status" dari halaman lacak menandai lunas jika gateway sudah settlement (tanpa webhook), dengan throttle', async () => {
    const { order, token } = await placeQrisOrder();
    const providerOrderId = await providerOrderIdOf(order.order_number);

    const first = await client.post('/api/orders/track/check-payment', { token });
    assert.equal(first.status, 200);
    assert.equal(first.data.check.checked, true);
    assert.equal(first.data.payment.status, 'pending');

    const throttled = await client.post('/api/orders/track/check-payment', { token });
    assert.equal(throttled.data.check.reason, 'throttled');
    assert.equal(fake.count('GET', /\/status$/), 1, 'dibatasi: tidak menyerang API gateway');

    fake.setStatus(providerOrderId, 'settlement');
    await ctx.pool.execute('UPDATE payments SET last_checked_at = NULL');
    const paid = await client.post('/api/orders/track/check-payment', { token });
    assert.equal(paid.data.payment.status, 'paid');
    assert.equal(paid.data.order.payment_status, 'paid');
  });

  test('admin dapat "periksa status ke gateway"; wajib login; staf pun boleh', async () => {
    const { order } = await placeQrisOrder();
    const row = await orderRow(order.order_number);
    const providerOrderId = await providerOrderIdOf(order.order_number);
    assert.equal((await client.post(`/api/admin/orders/${row.id}/payment/refresh`, {})).status, 401);

    await createAdmin(ctx, { username: 'kasir', role: 'staff' });
    const staff = ctx.client();
    await staff.login('kasir');
    fake.setStatus(providerOrderId, 'settlement');
    const response = await staff.post(`/api/admin/orders/${row.id}/payment/refresh`, {});
    assert.equal(response.status, 200);
    assert.equal(response.data.order.payment_status, 'paid');
    assert.equal(response.data.order.payments[0].status, 'paid');
  });

  test('sweeper: pesanan lewat batas bayar dibatalkan, stok kembali sekali, transaksi gateway ditutup, idempoten', async () => {
    const { order, product } = await placeQrisOrder({ quantity: 2, stock: 10 });
    const row = await orderRow(order.order_number);
    const providerOrderId = await providerOrderIdOf(order.order_number);

    // Belum lewat batas: tidak disentuh.
    assert.deepEqual((await ctx.paymentService.sweepExpired()).checked, 0);

    // Lewat batas tetapi masih dalam masa tenggang (90 dtk): tidak disentuh.
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE id = ?', [new Date(Date.now() - 30_000), row.id]);
    assert.equal((await ctx.paymentService.sweepExpired()).checked, 0);

    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE id = ?', [new Date(Date.now() - 10 * 60_000), row.id]);
    const summary = await ctx.paymentService.sweepExpired();
    assert.equal(summary.checked, 1);
    assert.equal(summary.expired, 1);

    const after = await orderRow(order.order_number);
    assert.equal(after.order_status, 'cancelled');
    assert.equal(after.payment_status, 'expired');
    assert.equal(await stockOf(ctx.pool, product.id), 10);
    assert.equal((await paymentRows(row.id))[0].status, 'expired');
    assert.equal(fake.transactions.get(providerOrderId).status, 'expire', 'ditutup di gateway agar tidak bisa dibayar lagi');

    // Dijalankan lagi (juga bersamaan): tidak ada efek tambahan.
    await Promise.all([ctx.paymentService.sweepExpired(), ctx.paymentService.sweepExpired()]);
    assert.equal(await stockOf(ctx.pool, product.id), 10);
    assert.equal((await ctx.paymentService.sweepExpired()).checked, 0);
  });

  test('sweeper: jika gateway ternyata sudah settlement, pesanan TIDAK dibatalkan', async () => {
    const { order, product } = await placeQrisOrder({ stock: 5 });
    const row = await orderRow(order.order_number);
    const providerOrderId = await providerOrderIdOf(order.order_number);
    fake.setStatus(providerOrderId, 'settlement'); // webhook-nya hilang di jalan
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE id = ?', [new Date(Date.now() - 10 * 60_000), row.id]);

    const summary = await ctx.paymentService.sweepExpired();
    assert.equal(summary.paid, 1);
    assert.equal(summary.expired, 0);
    const after = await orderRow(order.order_number);
    assert.equal(after.order_status, 'pending');
    assert.equal(after.payment_status, 'paid');
    assert.equal(await stockOf(ctx.pool, product.id), 4);
  });

  test('sweeper: gateway tidak bisa dihubungi => pesanan tidak dibatalkan sembarangan (aman, dicoba lagi nanti)', async () => {
    const { order } = await placeQrisOrder();
    const row = await orderRow(order.order_number);
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE id = ?', [new Date(Date.now() - 10 * 60_000), row.id]);
    fake.failNext('status', 503);
    const summary = await ctx.paymentService.sweepExpired();
    assert.equal(summary.errors, 1);
    assert.equal((await orderRow(order.order_number)).order_status, 'pending');
    assert.equal((await ctx.paymentService.sweepExpired()).expired, 1, 'percobaan berikutnya berhasil');
  });

  test('sweeper: pesanan yang pembuatan QRIS-nya gagal terus tetap dibatalkan setelah batas waktu', async () => {
    fake.failNext('charge', 503);
    const { order, product } = await placeQrisOrder({ stock: 4 });
    const row = await orderRow(order.order_number);
    assert.equal(await stockOf(ctx.pool, product.id), 3);
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE id = ?', [new Date(Date.now() - 10 * 60_000), row.id]);
    await ctx.paymentService.sweepExpired();
    const after = await orderRow(order.order_number);
    assert.equal(after.order_status, 'cancelled');
    assert.equal(after.payment_status, 'failed', 'riwayat kegagalan tidak ditimpa');
    assert.equal(await stockOf(ctx.pool, product.id), 4);
  });

  test('setelah batas waktu, membuat QRIS baru ditolak', async () => {
    fake.failNext('charge', 503);
    const { order, token } = await placeQrisOrder();
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE order_number = ?', [new Date(Date.now() - 60_000), order.order_number]);
    const retry = await client.post('/api/orders/track/retry-payment', { token });
    assert.equal(retry.status, 409);
    assert.equal(retry.data.error.code, 'PAYMENT_EXPIRED');
  });
});

// ------------------------------------------------------------------------------------------ stok & admin
describe('QRIS: stok dan pengelolaan admin', () => {
  test('admin membatalkan pesanan QRIS yang menunggu: stok kembali sekali, pembayaran dibatalkan, gateway ditutup; expire susulan tidak mengubah apa pun', async () => {
    const { order, product } = await placeQrisOrder({ quantity: 2, stock: 6 });
    const row = await orderRow(order.order_number);
    const providerOrderId = await providerOrderIdOf(order.order_number);
    const owner = await ownerClient();

    const cancelled = await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'cancelled', note: 'Pelanggan minta batal' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.order.order_status, 'cancelled');
    assert.equal(cancelled.data.order.payment_status, 'cancelled');
    assert.equal(cancelled.data.order.payments[0].status, 'cancelled');
    assert.equal(await stockOf(ctx.pool, product.id), 6);
    assert.equal(fake.transactions.get(providerOrderId).status, 'expire');
    assert.equal(fake.count('POST', /\/expire$/), 1);

    // Gateway lalu mengirim notifikasi expire: tidak mengubah apa pun (status sudah akhir).
    const late = await hook(fake.notification(providerOrderId, { transaction_status: 'expire' }));
    assert.equal(late.data.outcome, 'out_of_order');
    assert.equal(await stockOf(ctx.pool, product.id), 6);
  });

  test('pesanan QRIS yang sudah lunas lalu dibatalkan admin: stok kembali sekali, dana ditandai perlu dikembalikan', async () => {
    const { order, product } = await placeQrisOrder({ quantity: 1, stock: 3 });
    const row = await orderRow(order.order_number);
    await payViaWebhook(await providerOrderIdOf(order.order_number));
    const owner = await ownerClient();
    const cancelled = await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'cancelled', note: 'Stok bahan habis' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.order.payment_status, 'paid');
    assert.match(cancelled.data.order.payments[0].review_note, /kembalikan dana/i);
    assert.equal(await stockOf(ctx.pool, product.id), 3);
    assert.equal((await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'cancelled' })).status, 409);
    assert.equal(await stockOf(ctx.pool, product.id), 3);
    assert.equal((await owner.get('/api/admin/summary')).data.attention.paid_but_cancelled, 1);
  });

  test('admin TIDAK bisa menandai QRIS lunas manual dan tidak bisa memproses pesanan yang belum lunas', async () => {
    const { order } = await placeQrisOrder();
    const row = await orderRow(order.order_number);
    const owner = await ownerClient();

    const manual = await owner.patch(`/api/admin/orders/${row.id}/payment`, { payment_status: 'paid' });
    assert.equal(manual.status, 409);
    assert.equal(manual.data.error.code, 'QRIS_MANUAL_NOT_ALLOWED');
    const confirm = await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'confirmed' });
    assert.equal(confirm.status, 409);
    assert.equal(confirm.data.error.code, 'PAYMENT_REQUIRED');
    assert.equal((await orderRow(order.order_number)).payment_status, 'pending');

    await payViaWebhook(await providerOrderIdOf(order.order_number));
    for (const status of ['confirmed', 'preparing', 'ready', 'completed']) {
      assert.equal((await owner.patch(`/api/admin/orders/${row.id}/status`, { status })).status, 200, status);
    }
    // pembayaran QRIS yang lunas hanya bisa dicatat "dikembalikan", tidak bisa dikembalikan ke belum dibayar
    assert.equal((await owner.patch(`/api/admin/orders/${row.id}/payment`, { payment_status: 'unpaid' })).status, 409);
  });

  test('detail admin memuat referensi gateway, status pembayaran terpisah, waktu dibuat/dibayar/kedaluwarsa, dan riwayat notifikasi', async () => {
    const { order } = await placeQrisOrder();
    const row = await orderRow(order.order_number);
    const providerOrderId = await providerOrderIdOf(order.order_number);
    await payViaWebhook(providerOrderId);
    const owner = await ownerClient();
    const detail = (await owner.get(`/api/admin/orders/${row.id}`)).data.order;
    assert.equal(detail.payment_method, 'qris');
    assert.equal(detail.payment_status, 'paid');
    assert.equal(detail.order_status, 'pending');
    assert.ok(detail.paid_at && detail.created_at && detail.payment_expires_at);
    const [payment] = detail.payments;
    assert.equal(payment.provider_order_id, providerOrderId);
    assert.equal(payment.provider_transaction_id, fake.transactions.get(providerOrderId).transaction_id);
    assert.equal(payment.status, 'paid');
    assert.equal(payment.notifications[0].outcome, 'applied');
    assert.ok(!JSON.stringify(detail).includes('public_token'));
    assert.ok(!('qr_url' in payment));

    const list = (await owner.get('/api/admin/orders?payment_status=paid')).data;
    assert.equal(list.total, 1);
    assert.ok(list.items[0].paid_at);
    // Daftar admin memuat referensi gateway, batas waktu bayar, dan penanda tinjau (tanpa data rahasia)
    assert.equal(list.items[0].gateway_reference, fake.transactions.get(providerOrderId).transaction_id);
    assert.ok(list.items[0].payment_expires_at);
    assert.equal(list.items[0].needs_review, false);
    assert.ok(!JSON.stringify(list).includes('public_token'));
    assert.equal((await owner.get('/api/admin/orders?payment_status=pending')).data.total, 0);
  });

  test('laporan: hanya QRIS yang benar-benar lunas dihitung sebagai pendapatan; menunggu/gagal tidak', async () => {
    const owner = await ownerClient();
    const a = await placeQrisOrder({ price: 10000 });
    const b = await placeQrisOrder({ price: 20000 });
    const c = await placeQrisOrder({ price: 30000 });
    await payViaWebhook(await providerOrderIdOf(a.order.order_number));
    const failedId = await providerOrderIdOf(c.order.order_number);
    fake.setStatus(failedId, 'deny');
    await hook(fake.notification(failedId));

    const { totals, top_products: top, payment_breakdown: breakdown, attention } = (await owner.get('/api/admin/summary')).data;
    assert.equal(totals.verified_paid, 10000);
    assert.equal(totals.paid_orders, 1);
    assert.equal(totals.unpaid_value, 50000, 'b (menunggu) + c (gagal) belum dibayar');
    assert.equal(attention.awaiting_qris_payment, 1);
    assert.deepEqual(breakdown.map((row) => [row.payment_method, row.orders, row.value]), [['qris', 1, 10000]]);
    assert.equal(top.length, 1, 'produk dari pesanan QRIS yang belum lunas tidak masuk produk terlaris');
    assert.equal(top[0].paid_value, 10000);
    assert.ok(b.order);
  });

  test('metode lama tetap berjalan: tunai & transfer manual (unpaid -> paid oleh admin), tanpa baris pembayaran gateway', async () => {
    await setSettings(ctx.pool, { payment_transfer_enabled: true, payment_transfer_instructions: 'Bank Uji 000-000 a.n. Tes' });
    const product = await insertProduct(ctx.pool, { price: 12000 });
    const owner = await ownerClient();
    for (const method of ['cod', 'bank_transfer']) {
      const response = await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 1, price: 12000 }], { payment_method: method }));
      assert.equal(response.status, 201, method);
      assert.equal(response.data.order.payment_status, 'unpaid');
      assert.equal(response.data.payment, null);
      assert.match(response.data.tracking_token, /^[A-Za-z0-9_-]{43}$/);
      const row = await orderRow(response.data.order.order_number);
      assert.equal(row.payment_expires_at, null);
      const paid = await owner.patch(`/api/admin/orders/${row.id}/payment`, { payment_status: 'paid' });
      assert.equal(paid.status, 200, method);
      assert.equal(paid.data.order.payment_status, 'paid');
      assert.ok(paid.data.order.paid_at);
      assert.equal((await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'confirmed' })).status, 200);
    }
    assert.equal(await countRows(ctx.pool, 'payments'), 0);
    assert.equal(fake.requests.length, 0, 'metode lama tidak menyentuh gateway');
    assert.equal((await owner.get('/api/admin/summary')).data.totals.verified_paid, 24000);
  });

  test('pembatalan pesanan tunai tetap mengembalikan stok sekali (perilaku lama tidak berubah)', async () => {
    const product = await insertProduct(ctx.pool, { price: 9000, stock: 5, track_stock: 1 });
    const owner = await ownerClient();
    const response = await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 2, price: 9000 }]));
    const row = await orderRow(response.data.order.order_number);
    assert.equal(await stockOf(ctx.pool, product.id), 3);
    assert.equal((await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'cancelled' })).status, 200);
    assert.equal((await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'cancelled' })).status, 409);
    assert.equal(await stockOf(ctx.pool, product.id), 5);
  });

  test('status pembayaran QRIS terpisah dari status pesanan: pesanan selesai tidak mengubah status bayar', async () => {
    const { order } = await placeQrisOrder();
    const row = await orderRow(order.order_number);
    await payViaWebhook(await providerOrderIdOf(order.order_number));
    const owner = await ownerClient();
    await owner.patch(`/api/admin/orders/${row.id}/status`, { status: 'confirmed' });
    const after = await orderRow(order.order_number);
    assert.equal(after.order_status, 'confirmed');
    assert.equal(after.payment_status, 'paid');
  });
});

// ------------------------------------------------------------------------------------------ lacak pesanan
describe('lacak pesanan: akses aman', () => {
  test('dengan token: menampilkan pesanan milik token itu saja, tanpa data internal', async () => {
    const mine = await placeQrisOrder({ price: 11000 });
    const other = await placeQrisOrder({ price: 22000 });
    const response = await track(mine.token);
    assert.equal(response.status, 200);
    assert.equal(response.data.order.order_number, mine.order.order_number);
    assert.equal(response.data.order.total, 11000);
    assert.equal(response.data.payment.status, 'pending');
    assert.equal(response.data.labels.payment_status, 'Menunggu Pembayaran');
    const json = JSON.stringify(response.data);
    assert.ok(!json.includes(other.order.order_number));
    assert.ok(!json.includes(mine.token));
    assert.ok(!/"id"|public_token|qr_url|provider_order_id|provider_transaction_id|review_note|customer_phone/.test(json), json);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('dengan nomor pesanan + nomor WhatsApp (format 08.. diterima); salah satu keliru = tidak ditemukan dengan pesan yang sama', async () => {
    const { order, token } = await placeQrisOrder();
    const ok = await client.post('/api/orders/track', { order_number: order.order_number.toLowerCase(), phone: '0812-3456-7890' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.order.order_number, order.order_number);

    const wrongPhone = await client.post('/api/orders/track', { order_number: order.order_number, phone: '081299998888' });
    const wrongNumber = await client.post('/api/orders/track', { order_number: 'RB-261009-AAAAA', phone: '081234567890' });
    const wrongToken = await client.post('/api/orders/track', { token: 'A'.repeat(43) });
    for (const response of [wrongPhone, wrongNumber, wrongToken]) assert.equal(response.status, 404);
    assert.equal(wrongPhone.data.error.message, wrongNumber.data.error.message);
    assert.equal(wrongPhone.data.error.message, wrongToken.data.error.message);
    assert.ok(token);
  });

  test('permintaan tidak lengkap / token berbentuk salah ditolak (400); tidak bisa memakai nomor pesanan saja', async () => {
    const { order } = await placeQrisOrder();
    assert.equal((await client.post('/api/orders/track', {})).status, 400);
    assert.equal((await client.post('/api/orders/track', { order_number: order.order_number })).status, 400);
    assert.equal((await client.post('/api/orders/track', { token: "' OR 1=1 --" })).status, 400);
    assert.equal((await client.post('/api/orders/track', { token: 'short' })).status, 400);
    assert.equal((await client.get(`/api/orders/track?order_number=${order.order_number}`)).status, 404, 'tidak ada akses lewat GET/URL');
  });

  test('pelacakan dengan nomor + telepon dibatasi (rate limit) setelah banyak percobaan gagal; token tidak ikut dibatasi', async () => {
    const limited = await startTestServer(
      { RATE_LIMIT_ENABLED: 'true', PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: FAKE_SERVER_KEY, PAYMENT_API_BASE_URL: fake.baseUrl },
    );
    try {
      const anon = limited.client();
      const statuses = [];
      for (let i = 0; i < 18; i += 1) {
        statuses.push((await anon.post('/api/orders/track', { order_number: 'RB-261009-AAAAA', phone: '081234567890' })).status);
      }
      assert.deepEqual(statuses.slice(0, 15), Array(15).fill(404));
      assert.deepEqual(statuses.slice(15), [429, 429, 429]);
      // Token acak 256 bit tidak bisa ditebak, jadi tidak dibatasi oleh limiter "tebakan".
      assert.equal((await anon.post('/api/orders/track', { token: 'B'.repeat(43) })).status, 404);
    } finally {
      await limited.stop();
    }
  });

  test('gambar QRIS: data URI dari gateway untuk pembayaran pending; ditolak jika tidak aktif / bukan QRIS', async () => {
    const { token, order } = await placeQrisOrder();
    const qr = await client.post('/api/orders/track/qr', { token });
    assert.equal(qr.status, 200);
    assert.equal(qr.data.content_type, 'image/png');
    assert.match(qr.data.data_uri, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    assert.equal(fake.count('GET', /qr-code$/), 1, 'gambar diambil dari gateway');
    assert.equal((await client.post('/api/orders/track/qr', { token: 'C'.repeat(43) })).status, 404);

    await payViaWebhook(await providerOrderIdOf(order.order_number));
    const afterPaid = await client.post('/api/orders/track/qr', { token });
    assert.equal(afterPaid.status, 409);
    assert.equal(afterPaid.data.error.code, 'QR_NOT_ACTIVE');

    const cod = await client.post('/api/orders', orderPayload([{ product_id: (await insertProduct(ctx.pool, { price: 5000 })).id, quantity: 1, price: 5000 }]));
    assert.equal((await client.post('/api/orders/track/qr', { token: cod.data.tracking_token })).status, 409);
    assert.equal((await client.post('/api/orders/track/retry-payment', { token: cod.data.tracking_token })).status, 409);
  });

  test('gambar QR gagal dimuat dari gateway: 502 tanpa detail internal', async () => {
    const { token } = await placeQrisOrder();
    fake.failNext('qr', 500);
    const qr = await client.post('/api/orders/track/qr', { token });
    assert.equal(qr.status, 502);
    assert.ok(!JSON.stringify(qr.data).includes(fake.baseUrl));
  });

  test('QR kedaluwarsa tidak ditampilkan lagi', async () => {
    const { token, order } = await placeQrisOrder();
    await ctx.pool.execute('UPDATE payments SET expires_at = ? WHERE 1 = 1', [new Date(Date.now() - 1000)]);
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ? WHERE order_number = ?', [new Date(Date.now() - 1000), order.order_number]);
    assert.equal((await client.post('/api/orders/track/qr', { token })).status, 409);
  });

  test('pesanan tunai juga bisa dilacak (tanpa bagian pembayaran gateway)', async () => {
    const product = await insertProduct(ctx.pool, { price: 7000 });
    const created = await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 1, price: 7000 }]));
    const view = (await track(created.data.tracking_token)).data;
    assert.equal(view.payment, null);
    assert.equal(view.order.payment_method, 'cod');
    assert.equal(view.order.order_status, 'pending');
  });
});
