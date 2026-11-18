// Server Midtrans TIRUAN untuk test (HTTP lokal). Meniru kontrak yang terdokumentasi di docs.midtrans.com:
// Basic auth (ServerKey:), POST /v2/charge (QRIS), GET /v2/{order_id}/status, POST /v2/{order_id}/expire,
// GET /v2/qris/{transaction_id}/qr-code (PNG), dan notifikasi bertanda tangan SHA-512.
//
// PENTING: ini BUKAN Midtrans sungguhan. Test yang memakainya membuktikan bahwa kode kita konsisten dengan
// kontrak yang didokumentasikan, bukan bahwa akun Midtrans sungguhan berhasil menerima pembayaran.
import crypto from 'node:crypto';
import http from 'node:http';
import { midtransSignature } from '../src/payments/signature.js';

// PNG 1x1 yang valid (isi tidak penting; yang diuji adalah rantai pengambilan gambar dari gateway).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const STATUS_CODE = { pending: '201', settlement: '200', capture: '200', cancel: '200', deny: '202', expire: '407', failure: '202' };

export const FAKE_SERVER_KEY = 'SB-Mid-server-KUNCI-TIRUAN-UNTUK-TEST';

export async function startFakeMidtrans({ serverKey = FAKE_SERVER_KEY } = {}) {
  const transactions = new Map(); // order_id -> transaksi
  const requests = []; // log permintaan masuk
  const faults = { charge: [], status: [], qr: [] }; // antrean kegagalan: tiap elemen = HTTP status yang dikembalikan

  const expectedAuth = `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
  let baseUrl = '';

  const send = (res, httpStatus, body, contentType = 'application/json') => {
    res.writeHead(httpStatus, { 'content-type': contentType });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const view = (tx) => ({
    status_code: STATUS_CODE[tx.status] ?? '200',
    status_message: 'Success, transaction is found',
    transaction_id: tx.transaction_id,
    order_id: tx.order_id,
    merchant_id: 'G000000000',
    gross_amount: `${tx.gross_amount}.00`,
    currency: 'IDR',
    payment_type: 'qris',
    transaction_time: '2026-10-16 10:00:00',
    transaction_status: tx.status,
    fraud_status: tx.fraud_status,
    acquirer: 'gopay',
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method, path: url.pathname, body, authorized: req.headers.authorization === expectedAuth, headers: req.headers });

      // Gambar QR tidak butuh autentikasi (URL aksi publik); selebihnya wajib Basic auth.
      const qrMatch = /^\/v[24]\/qris\/([^/]+)\/qr-code$/.exec(url.pathname);
      if (qrMatch && req.method === 'GET') {
        const fault = faults.qr.shift();
        if (fault) return send(res, fault, { status_code: String(fault) });
        return send(res, 200, TINY_PNG, 'image/png');
      }
      if (req.headers.authorization !== expectedAuth) {
        return send(res, 401, { status_code: '401', status_message: 'Access denied due to unauthorized transaction, please check client or server key' });
      }

      if (req.method === 'POST' && url.pathname === '/v2/charge') {
        const fault = faults.charge.shift();
        if (fault) return send(res, fault, { status_code: String(fault), status_message: 'fault injected' });
        const orderId = body?.transaction_details?.order_id;
        const amount = body?.transaction_details?.gross_amount;
        if (body?.payment_type !== 'qris' || !orderId || !Number.isInteger(amount)) {
          return send(res, 200, { status_code: '400', status_message: 'Validation error' });
        }
        if (transactions.has(orderId)) {
          return send(res, 200, { status_code: '406', status_message: 'Order ID already used' });
        }
        const tx = {
          transaction_id: crypto.randomUUID(),
          order_id: orderId,
          gross_amount: amount,
          status: 'pending',
          fraud_status: 'accept',
          chargeBody: body,
        };
        transactions.set(orderId, tx);
        return send(res, 200, {
          ...view(tx),
          status_code: '201',
          status_message: 'QRIS transaction is created',
          actions: [
            { name: 'generate-qr-code', method: 'GET', url: `${baseUrl}/v2/qris/${tx.transaction_id}/qr-code` },
            { name: 'generate-qr-code-v2', method: 'GET', url: `${baseUrl}/v4/qris/${tx.transaction_id}/qr-code` },
          ],
        });
      }

      const statusMatch = /^\/v2\/([^/]+)\/status$/.exec(url.pathname);
      if (req.method === 'GET' && statusMatch) {
        const fault = faults.status.shift();
        if (fault) return send(res, fault, { status_code: String(fault) });
        const tx = transactions.get(decodeURIComponent(statusMatch[1]));
        if (!tx) return send(res, 404, { status_code: '404', status_message: "Transaction doesn't exist." });
        return send(res, 200, view(tx));
      }

      const expireMatch = /^\/v2\/([^/]+)\/expire$/.exec(url.pathname);
      if (req.method === 'POST' && expireMatch) {
        const tx = transactions.get(decodeURIComponent(expireMatch[1]));
        if (!tx) return send(res, 200, { status_code: '404', status_message: "Transaction doesn't exist." });
        if (tx.status !== 'pending') return send(res, 200, { status_code: '412', status_message: 'Transaction status cannot be updated.' });
        tx.status = 'expire';
        return send(res, 200, { ...view(tx), status_message: 'Success, transaction has expired' });
      }
      return send(res, 404, { status_code: '404', status_message: 'not found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const api = {
    baseUrl,
    serverKey,
    transactions,
    requests,
    /** Jumlah permintaan ke path tertentu (mis. '/v2/charge'). */
    count: (method, pathRegex) => requests.filter((r) => r.method === method && pathRegex.test(r.path)).length,
    /** Antrekan kegagalan HTTP (mis. 503) untuk n panggilan berikutnya ke endpoint tertentu. */
    failNext(endpoint, httpStatus = 503, times = 1) {
      for (let i = 0; i < times; i += 1) faults[endpoint].push(httpStatus);
    },
    /** Mengubah status transaksi di sisi "Midtrans" (seperti pelanggan membayar / transaksi kedaluwarsa). */
    setStatus(orderId, status, { fraud = 'accept' } = {}) {
      const tx = transactions.get(orderId);
      if (!tx) throw new Error(`Transaksi ${orderId} tidak ada di server tiruan`);
      tx.status = status;
      tx.fraud_status = fraud;
    },
    /** Membuat isi notifikasi bertanda tangan valid (atau ubah field lalu tanda tangani ulang). */
    notification(orderId, overrides = {}) {
      const tx = transactions.get(orderId);
      const status = overrides.transaction_status ?? tx?.status ?? 'settlement';
      const body = {
        transaction_time: '2026-10-16 10:01:00',
        transaction_status: status,
        transaction_id: tx?.transaction_id ?? crypto.randomUUID(),
        status_message: 'midtrans payment notification',
        status_code: STATUS_CODE[status] ?? '200',
        payment_type: 'qris',
        order_id: orderId,
        merchant_id: 'G000000000',
        gross_amount: `${tx?.gross_amount ?? 0}.00`,
        fraud_status: 'accept',
        currency: 'IDR',
        acquirer: 'gopay',
        ...overrides,
      };
      body.signature_key = overrides.signature_key ?? api.sign(body);
      return body;
    },
    sign: (body) =>
      midtransSignature({ orderId: String(body.order_id), statusCode: String(body.status_code), grossAmount: String(body.gross_amount), serverKey }),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
  return api;
}
