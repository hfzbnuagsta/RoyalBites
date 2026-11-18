// Test mode MOCK (khusus development/test): jelas terpisah dari gateway sungguhan.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { MOCK_DEFAULT_SERVER_KEY } from '../../src/payments/mockProvider.js';
import { midtransSignature } from '../../src/payments/signature.js';
import { FAKE_SERVER_KEY, startFakeMidtrans } from '../fakeMidtrans.js';
import { clearData, insertProduct, orderPayload, prepareDatabase, startTestServer } from '../helpers.js';

let ctx;
let client;
before(async () => {
  ctx = await startTestServer({ PAYMENT_PROVIDER: 'mock' });
  await prepareDatabase(ctx.config);
  client = ctx.client();
});
after(() => ctx.stop());
beforeEach(() => clearData(ctx.pool));

const NOTIFICATION_PATH = '/api/payments/midtrans/notification';

function signedNotification(providerOrderId, { status = 'settlement', amount, key = MOCK_DEFAULT_SERVER_KEY, transactionId = 'mock-tx' } = {}) {
  const body = {
    transaction_status: status,
    transaction_id: transactionId,
    status_code: status === 'settlement' ? '200' : '201',
    order_id: providerOrderId,
    gross_amount: `${amount}.00`,
    fraud_status: 'accept',
  };
  return { ...body, signature_key: midtransSignature({ orderId: body.order_id, statusCode: body.status_code, grossAmount: body.gross_amount, serverKey: key }) };
}

async function placeOrder() {
  const product = await insertProduct(ctx.pool, { price: 16000, stock: 5, track_stock: 1 });
  const response = await client.post('/api/orders', orderPayload([{ product_id: product.id, quantity: 1, price: 16000 }], { payment_method: 'qris' }));
  const [[payment]] = await ctx.pool.query('SELECT * FROM payments ORDER BY id DESC LIMIT 1');
  return { response, product, payment };
}

describe('mode MOCK', () => {
  test('ditandai jelas "mock" di config publik dan di pembayaran; kunci tidak bocor', async () => {
    const config = (await client.get('/api/config')).data;
    const qris = config.ordering.payment_methods.find((method) => method.value === 'qris');
    assert.equal(qris.mode, 'mock');
    const { response } = await placeOrder();
    assert.equal(response.status, 201);
    assert.equal(response.data.payment.mode, 'mock');
    assert.ok(!JSON.stringify([config, response.data]).includes(MOCK_DEFAULT_SERVER_KEY));
  });

  test('gambar QR mock jelas bukan QRIS sah (label MOCK, tidak bisa dipindai)', async () => {
    const { response } = await placeOrder();
    const qr = await client.post('/api/orders/track/qr', { token: response.data.tracking_token });
    assert.equal(qr.status, 200);
    assert.equal(qr.data.content_type, 'image/svg+xml');
    const svg = Buffer.from(qr.data.data_uri.split(',')[1], 'base64').toString('utf8');
    assert.match(svg, /MOCK/);
    assert.match(svg, /BUKAN QRIS SAH/);
    assert.ok(!/<(script|image|foreignObject)/i.test(svg));
  });

  test('tanpa webhook bertanda tangan, tidak ada yang berubah menjadi lunas (cek status tidak didukung mock)', async () => {
    const { response, payment } = await placeOrder();
    const check = await client.post('/api/orders/track/check-payment', { token: response.data.tracking_token });
    assert.equal(check.data.check.checked, false);
    assert.equal(check.data.check.reason, 'unsupported');
    assert.equal(check.data.order.payment_status, 'pending');
    // klaim lunas dari browser tidak ada jalurnya sama sekali
    const forged = await client.post(NOTIFICATION_PATH, signedNotification(payment.provider_order_id, { amount: 16000, key: 'tebakan-kunci' }));
    assert.equal(forged.status, 403);
    const [[order]] = await ctx.pool.query('SELECT payment_status FROM orders');
    assert.equal(order.payment_status, 'pending');
  });

  test('webhook bertanda tangan kunci mock -> lunas; diulang -> tidak ganda', async () => {
    const { response, payment } = await placeOrder();
    // transaction_id yang tidak cocok dengan yang tersimpan ditolak (ditandai), tidak melunasi pesanan.
    const wrongTx = await client.post(NOTIFICATION_PATH, signedNotification(payment.provider_order_id, { amount: 16000 }));
    assert.equal(wrongTx.data.outcome, 'transaction_mismatch');
    assert.equal((await ctx.pool.query('SELECT payment_status FROM orders'))[0][0].payment_status, 'pending');

    const body = signedNotification(payment.provider_order_id, { amount: 16000, transactionId: payment.provider_transaction_id });
    assert.equal((await client.post(NOTIFICATION_PATH, body)).data.outcome, 'applied');
    assert.equal((await client.post(NOTIFICATION_PATH, body)).data.outcome, 'duplicate_notification');
    const view = (await client.post('/api/orders/track', { token: response.data.tracking_token })).data;
    assert.equal(view.order.payment_status, 'paid');
    assert.equal(view.payment.status, 'paid');
  });

  test('sweeper mock: kedaluwarsa dibatalkan lokal dan stok kembali', async () => {
    const { product } = await placeOrder();
    await ctx.pool.execute('UPDATE orders SET payment_expires_at = ?', [new Date(Date.now() - 10 * 60_000)]);
    const summary = await ctx.paymentService.sweepExpired();
    assert.equal(summary.expired, 1);
    const [[order]] = await ctx.pool.query('SELECT order_status, payment_status FROM orders');
    assert.deepEqual({ ...order }, { order_status: 'cancelled', payment_status: 'expired' });
    assert.equal((await ctx.pool.query('SELECT stock FROM products WHERE id = ?', [product.id]))[0][0].stock, 5);
  });

  test('pembayaran mock tidak bisa "diselesaikan" oleh server yang memakai gateway lain (penyedia berbeda = tidak dikenal)', async () => {
    const { payment } = await placeOrder();
    const fake = await startFakeMidtrans({ serverKey: MOCK_DEFAULT_SERVER_KEY });
    const other = await startTestServer({ PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: MOCK_DEFAULT_SERVER_KEY, PAYMENT_API_BASE_URL: fake.baseUrl });
    try {
      const response = await other.client().post(NOTIFICATION_PATH, signedNotification(payment.provider_order_id, { amount: 16000 }));
      assert.equal(response.status, 200);
      assert.equal(response.data.outcome, 'unknown_payment');
      const [[order]] = await ctx.pool.query('SELECT payment_status FROM orders');
      assert.equal(order.payment_status, 'pending');
    } finally {
      await other.stop();
      await fake.stop();
    }
    assert.ok(FAKE_SERVER_KEY);
  });
});
