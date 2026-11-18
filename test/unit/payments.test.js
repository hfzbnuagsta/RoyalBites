// Test unit pembayaran: tanda tangan, pemetaan status, aturan konfigurasi, dan klien Midtrans.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertRunnable, loadConfig } from '../../src/config/env.js';
import { PaymentProviderError } from '../../src/payments/errors.js';
import { createMidtransProvider } from '../../src/payments/midtransProvider.js';
import { createPaymentProvider } from '../../src/payments/index.js';
import { midtransSignature, verifyMidtransSignature } from '../../src/payments/signature.js';
import { mapProviderStatus, parseGrossAmount } from '../../src/services/paymentService.js';
import { FAKE_SERVER_KEY, startFakeMidtrans } from '../fakeMidtrans.js';

const baseEnv = { DB_USER: 'app', DB_NAME: 'royal_bites', DB_PASSWORD: 'rahasia-db-yang-kuat' };

describe('tanda tangan webhook Midtrans', () => {
  // Vektor uji dihitung terpisah (Python hashlib): SHA512("RB-261009-K7P2M-1" + "200" + "20000.00" + "SB-Mid-server-contoh")
  const VECTOR = '1dc616cde51144332d1afb9f7206d0a5f0a724dff587e932493ab1fa5bb619921fc535b0dafe96a7b45488868ccdbe49d2f90db93acb1b94ee7a5a374c006d53';
  const body = { order_id: 'RB-261009-K7P2M-1', status_code: '200', gross_amount: '20000.00', signature_key: VECTOR };

  test('rumus = SHA512(order_id + status_code + gross_amount + ServerKey)', () => {
    assert.equal(midtransSignature({ orderId: body.order_id, statusCode: '200', grossAmount: '20000.00', serverKey: 'SB-Mid-server-contoh' }), VECTOR);
    assert.equal(verifyMidtransSignature(body, 'SB-Mid-server-contoh'), true);
  });
  test('huruf besar pada hex tetap diterima; kunci salah / field berubah / hilang ditolak', () => {
    assert.equal(verifyMidtransSignature({ ...body, signature_key: VECTOR.toUpperCase() }, 'SB-Mid-server-contoh'), true);
    assert.equal(verifyMidtransSignature(body, 'kunci-lain'), false);
    assert.equal(verifyMidtransSignature({ ...body, gross_amount: '20000.01' }, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature({ ...body, order_id: 'RB-261009-K7P2M-2' }, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature({ ...body, signature_key: undefined }, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature({ ...body, signature_key: VECTOR.slice(0, 100) }, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature({ ...body, signature_key: ['x'] }, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature({ ...body, order_id: { $ne: 1 } }, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature(null, 'SB-Mid-server-contoh'), false);
    assert.equal(verifyMidtransSignature(body, ''), false, 'tanpa kunci server tidak ada tanda tangan yang sah');
  });
  test('gross_amount dipakai persis seperti teks yang dikirim ("20000.00" berbeda dari "20000")', () => {
    assert.equal(verifyMidtransSignature({ ...body, gross_amount: '20000' }, 'SB-Mid-server-contoh'), false);
  });
});

describe('pemetaan status gateway', () => {
  const cases = [
    [{ transactionStatus: 'settlement', statusCode: '200', fraudStatus: 'accept' }, 'paid'],
    [{ transactionStatus: 'settlement', statusCode: '200', fraudStatus: null }, 'paid'],
    [{ transactionStatus: 'capture', statusCode: '200', fraudStatus: 'accept' }, 'paid'],
    [{ transactionStatus: 'settlement', statusCode: '200', fraudStatus: 'challenge' }, null],
    [{ transactionStatus: 'settlement', statusCode: '202', fraudStatus: 'accept' }, null],
    [{ transactionStatus: 'pending' }, 'pending'],
    [{ transactionStatus: 'expire' }, 'expired'],
    [{ transactionStatus: 'cancel' }, 'cancelled'],
    [{ transactionStatus: 'deny' }, 'failed'],
    [{ transactionStatus: 'failure' }, 'failed'],
    [{ transactionStatus: 'refund' }, 'refunded'],
    [{ transactionStatus: 'chargeback' }, 'refunded'],
    [{ transactionStatus: 'partial_refund' }, null],
    [{ transactionStatus: 'authorize' }, null],
    [{ transactionStatus: '' }, null],
    [{ transactionStatus: 'sesuatu-yang-baru' }, null],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${expected}`, () => assert.equal(mapProviderStatus(input).target, expected));
  }
});

describe('parseGrossAmount', () => {
  test('rupiah bulat diterima; pecahan/aneh ditolak', () => {
    assert.equal(parseGrossAmount('20000.00'), 20000);
    assert.equal(parseGrossAmount('20000'), 20000);
    assert.equal(parseGrossAmount(' 15000.0 '), 15000);
    for (const bad of ['20000.50', '-5', '1e5', '', 'abc', null, undefined, '20000.001', '1,000.00']) assert.equal(parseGrossAmount(bad), null, String(bad));
  });
});

describe('aturan konfigurasi pembayaran', () => {
  const run = (extra) => assertRunnable(loadConfig({ ...baseEnv, ...extra }));
  test('tanpa PAYMENT_PROVIDER: QRIS nonaktif dan tidak ada penyedia', () => {
    const config = loadConfig({ ...baseEnv });
    assert.equal(config.payment.enabled, false);
    assert.equal(createPaymentProvider(config.payment), null);
    assert.doesNotThrow(() => run({}));
  });
  test('mock DITOLAK di production (NODE_ENV=production atau PAYMENT_IS_PRODUCTION=true)', () => {
    assert.throws(() => run({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'mock' }), /DILARANG di production/);
    assert.throws(() => run({ PAYMENT_PROVIDER: 'mock', PAYMENT_IS_PRODUCTION: 'true' }), /DILARANG di production/);
    assert.doesNotThrow(() => run({ PAYMENT_PROVIDER: 'mock' }));
  });
  test('midtrans wajib punya PAYMENT_SERVER_KEY', () => {
    assert.throws(() => run({ PAYMENT_PROVIDER: 'midtrans' }), /PAYMENT_SERVER_KEY wajib/);
    assert.doesNotThrow(() => run({ PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'SB-Mid-server-x' }));
  });
  test('mode production tidak boleh memakai kunci sandbox; pesan tidak membocorkan kunci', () => {
    assert.throws(
      () => run({ PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'SB-Mid-server-RAHASIA123', PAYMENT_IS_PRODUCTION: 'true' }),
      (error) => /kunci sandbox/.test(error.message) && !error.message.includes('RAHASIA123'),
    );
  });
  test('PAYMENT_API_BASE_URL (khusus test) ditolak di production; provider tak dikenal ditolak', () => {
    assert.throws(
      () => run({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'Mid-server-x', PAYMENT_API_BASE_URL: 'http://evil.example' }),
      /hanya untuk test/,
    );
    assert.throws(() => run({ PAYMENT_PROVIDER: 'stripe' }), /tidak dikenal/);
  });
  test('nilai kedaluwarsa di luar batas ditolak', () => {
    assert.throws(() => loadConfig({ ...baseEnv, PAYMENT_QRIS_EXPIRY_MINUTES: '1' }), /PAYMENT_QRIS_EXPIRY_MINUTES/);
    assert.equal(loadConfig({ ...baseEnv }).payment.qrisExpiryMinutes, 15);
  });
});

describe('klien Midtrans', () => {
  let fake;
  before(async () => {
    fake = await startFakeMidtrans();
  });
  after(() => fake.stop());
  const providerFor = (overrides = {}, fetchImpl) =>
    createMidtransProvider(
      loadConfig({ ...baseEnv, PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: FAKE_SERVER_KEY, PAYMENT_API_BASE_URL: fake.baseUrl, ...overrides }).payment,
      fetchImpl ? { fetchImpl } : undefined,
    );

  test('basis URL: sandbox/production resmi sesuai mode', () => {
    const sandbox = createMidtransProvider(loadConfig({ ...baseEnv, PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'k' }).payment);
    assert.equal(sandbox.mode, 'sandbox');
    const live = createMidtransProvider(loadConfig({ ...baseEnv, PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'Mid-server-k', PAYMENT_IS_PRODUCTION: 'true' }).payment);
    assert.equal(live.mode, 'live');
    const urls = [];
    const capture = () => (url) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ status_code: '404' }), { status: 404 }));
    };
    return Promise.all([
      createMidtransProvider(loadConfig({ ...baseEnv, PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'k' }).payment, { fetchImpl: capture() }).getStatus('A-1'),
      createMidtransProvider(loadConfig({ ...baseEnv, PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'Mid-server-k', PAYMENT_IS_PRODUCTION: 'true' }).payment, { fetchImpl: capture() }).getStatus('A-1'),
    ]).then(() => {
      assert.deepEqual(urls, ['https://api.sandbox.midtrans.com/v2/A-1/status', 'https://api.midtrans.com/v2/A-1/status']);
    });
  });

  test('createQris: kirim permintaan sesuai kontrak dan kembalikan transaksi + URL QR dari gateway', async () => {
    fake.requests.length = 0;
    const result = await providerFor().createQris({ providerOrderId: 'RB-1-1', amount: 12500, customerName: 'Budi', expiryMinutes: 15 });
    assert.ok(result.transactionId);
    assert.ok(result.qrUrl.startsWith(fake.baseUrl));
    const request = fake.requests.at(-1);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/v2/charge');
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${FAKE_SERVER_KEY}:`).toString('base64')}`);
    assert.deepEqual(request.body.transaction_details, { order_id: 'RB-1-1', gross_amount: 12500 });
    assert.equal(request.body.payment_type, 'qris');
    assert.deepEqual(request.body.qris, { acquirer: 'gopay' });
    assert.deepEqual(request.body.custom_expiry, { expiry_duration: 15, unit: 'minute' });
  });

  test('kegagalan: 401 (tidak bisa diulang, tanpa kunci di pesan), 5xx & jaringan (bisa diulang), order_id ganda (406)', async () => {
    const wrong = createMidtransProvider(loadConfig({ ...baseEnv, PAYMENT_PROVIDER: 'midtrans', PAYMENT_SERVER_KEY: 'SB-Mid-server-SALAH', PAYMENT_API_BASE_URL: fake.baseUrl }).payment);
    await assert.rejects(wrong.createQris({ providerOrderId: 'RB-2-1', amount: 1000, customerName: 'A', expiryMinutes: 15 }), (error) => {
      assert.ok(error instanceof PaymentProviderError);
      assert.equal(error.retryable, false);
      assert.ok(!error.message.includes('SALAH'));
      return true;
    });
    fake.failNext('charge', 503);
    await assert.rejects(providerFor().createQris({ providerOrderId: 'RB-2-2', amount: 1000, customerName: 'A', expiryMinutes: 15 }), (error) => error.retryable === true);
    const down = providerFor({}, () => Promise.reject(new TypeError('fetch failed')));
    await assert.rejects(down.getStatus('RB-2-3'), (error) => error.retryable === true && !/fetch failed/.test(error.message));

    await providerFor().createQris({ providerOrderId: 'RB-2-4', amount: 1000, customerName: 'A', expiryMinutes: 15 });
    await assert.rejects(providerFor().createQris({ providerOrderId: 'RB-2-4', amount: 1000, customerName: 'A', expiryMinutes: 15 }), (error) => error.providerCode === '406' && error.retryable === false);
  });

  test('respons gateway yang tidak sesuai ditolak: nominal beda, bukan pending, order_id beda, tanpa URL QR', async () => {
    const charge = (data) =>
      providerFor({}, () => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }))).createQris({
        providerOrderId: 'RB-3-1',
        amount: 5000,
        customerName: 'A',
        expiryMinutes: 15,
      });
    const good = {
      status_code: '201',
      transaction_id: 'tx-1',
      order_id: 'RB-3-1',
      gross_amount: '5000.00',
      transaction_status: 'pending',
      actions: [{ name: 'generate-qr-code', method: 'GET', url: `${fake.baseUrl}/v2/qris/tx-1/qr-code` }],
    };
    assert.ok((await charge(good)).qrUrl);
    await assert.rejects(charge({ ...good, gross_amount: '4000.00' }), /Nominal/);
    await assert.rejects(charge({ ...good, transaction_status: 'settlement' }), /tidak sesuai/);
    await assert.rejects(charge({ ...good, order_id: 'RB-OTHER' }), /tidak sesuai/);
    await assert.rejects(charge({ ...good, actions: [] }), /URL gambar QR/);
  });

  test('URL QR hanya boleh ke host Midtrans (anti-SSRF): host lain, skema file/http publik ditolak', async () => {
    const charge = (url) =>
      providerFor({}, () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              status_code: '201', transaction_id: 't', order_id: 'RB-4-1', gross_amount: '5000.00', transaction_status: 'pending',
              actions: [{ name: 'generate-qr-code', method: 'GET', url }],
            }),
            { status: 200 },
          ),
        ),
      ).createQris({ providerOrderId: 'RB-4-1', amount: 5000, customerName: 'A', expiryMinutes: 15 });
    for (const bad of ['http://169.254.169.254/latest/meta-data', 'https://evil.example/qr.png', 'file:///etc/passwd', 'http://api.midtrans.com/v2/qris/x/qr-code', 'bukan-url']) {
      await assert.rejects(charge(bad), /URL QR|host tidak dikenal/, bad);
    }
    // alamat resmi diterima
    assert.ok((await charge('https://api.sandbox.midtrans.com/v2/qris/x/qr-code')).qrUrl);
    assert.ok((await charge('https://api.midtrans.com/v2/qris/x/qr-code')).qrUrl);
    // fetchQrImage menerapkan aturan yang sama
    await assert.rejects(providerFor().fetchQrImage('http://169.254.169.254/'), /host tidak dikenal/);
  });

  test('fetchQrImage: hanya gambar & ukuran wajar', async () => {
    const png = await providerFor().fetchQrImage(`${fake.baseUrl}/v2/qris/abc/qr-code`);
    assert.equal(png.contentType, 'image/png');
    assert.ok(png.buffer.length > 0);
    const reply = (headers, body) => providerFor({}, () => Promise.resolve(new Response(body, { status: 200, headers })));
    await assert.rejects(reply({ 'content-type': 'text/html' }, '<script>alert(1)</script>').fetchQrImage(`${fake.baseUrl}/x`), /bukan gambar/);
    await assert.rejects(reply({ 'content-type': 'image/png' }, Buffer.alloc(400 * 1024)).fetchQrImage(`${fake.baseUrl}/x`), /Ukuran/);
    await assert.rejects(reply({ 'content-type': 'image/png' }, '').fetchQrImage(`${fake.baseUrl}/x`), /Ukuran/);
  });

  test('getStatus: transaksi tidak ada => found:false; sukses => status ternormalisasi; order_id berbeda ditolak', async () => {
    const provider = providerFor();
    assert.deepEqual(await provider.getStatus('RB-TIDAK-ADA-1'), { found: false });
    await provider.createQris({ providerOrderId: 'RB-5-1', amount: 7000, customerName: 'A', expiryMinutes: 15 });
    fake.setStatus('RB-5-1', 'settlement');
    const status = await provider.getStatus('RB-5-1');
    assert.equal(status.transactionStatus, 'settlement');
    assert.equal(status.statusCode, '200');
    assert.equal(status.grossAmount, '7000.00');
    assert.equal(status.fraudStatus, 'accept');
    const mismatched = providerFor({}, () => Promise.resolve(new Response(JSON.stringify({ status_code: '200', order_id: 'LAIN', transaction_status: 'settlement' }), { status: 200 })));
    await assert.rejects(mismatched.getStatus('RB-5-1'), /order_id yang berbeda/);
  });
});
