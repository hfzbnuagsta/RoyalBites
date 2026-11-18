// Simulasi notifikasi pembayaran untuk MODE MOCK (development saja):
//
//   npm run mock:pay -- RB-261021-K7P2M                 -> pembayaran dianggap LUNAS (settlement)
//   npm run mock:pay -- RB-261021-K7P2M --status=expire -> pembayaran kedaluwarsa
//   npm run mock:pay -- RB-261021-K7P2M --url=http://127.0.0.1:3000
//
// Status yang didukung: settlement (default), pending, expire, cancel, deny.
//
// PENTING:
//  - Ini BUKAN pembayaran sungguhan. Skrip hanya mengirim notifikasi bertanda tangan (dengan kunci mock) ke
//    webhook server Anda, persis seperti yang kelak dikirim gateway sungguhan. Server tetap memverifikasi
//    tanda tangan dan nominalnya.
//  - Hanya jalan jika PAYMENT_PROVIDER=mock dan NODE_ENV bukan production. Untuk Midtrans sandbox, pakai
//    simulator resmi Midtrans (lihat README bagian "Pembayaran QRIS"), bukan skrip ini.
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/env.js';
import { createPool } from '../src/db/pool.js';
import { MOCK_DEFAULT_SERVER_KEY } from '../src/payments/mockProvider.js';
import { midtransSignature } from '../src/payments/signature.js';
import { WEBHOOK_PATH } from '../src/payments/describe.js';

dotenv.config({ quiet: true });

const STATUS_CODE = { settlement: '200', pending: '201', cancel: '200', deny: '202', expire: '407' };

function fail(message) {
  console.error(`Gagal: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const orderNumber = args.find((arg) => !arg.startsWith('--'))?.toUpperCase();
const status = (args.find((arg) => arg.startsWith('--status='))?.split('=')[1] ?? 'settlement').toLowerCase();
const urlArg = args.find((arg) => arg.startsWith('--url='))?.split('=')[1];

if (!orderNumber) fail('sebutkan nomor pesanan, mis. npm run mock:pay -- RB-261021-K7P2M');
if (!STATUS_CODE[status]) fail(`status "${status}" tidak dikenal. Pilihan: ${Object.keys(STATUS_CODE).join(', ')}`);

const config = loadConfig();
if (config.isProduction || config.payment.isProduction) fail('skrip simulasi ini DILARANG di production.');
if (config.payment.provider !== 'mock') {
  fail('PAYMENT_PROVIDER harus "mock" (isi di .env lalu restart server). Skrip ini tidak untuk Midtrans sungguhan/sandbox.');
}

const pool = createPool(config.db);
try {
  const [rows] = await pool.query(
    `SELECT p.provider_order_id, p.provider_transaction_id, p.amount, p.status
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.order_number = ? AND p.provider = 'mock'
      ORDER BY p.id DESC LIMIT 1`,
    [orderNumber],
  );
  if (rows.length === 0) fail(`tidak ada pembayaran QRIS (mock) untuk pesanan ${orderNumber}.`);
  const payment = rows[0];

  const body = {
    order_id: payment.provider_order_id,
    transaction_id: payment.provider_transaction_id,
    transaction_status: status,
    status_code: STATUS_CODE[status],
    gross_amount: `${payment.amount}.00`,
    payment_type: 'qris',
    fraud_status: 'accept',
    transaction_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  body.signature_key = midtransSignature({
    orderId: body.order_id,
    statusCode: body.status_code,
    grossAmount: body.gross_amount,
    serverKey: config.payment.serverKey || MOCK_DEFAULT_SERVER_KEY,
  });

  const target = `${(urlArg || `http://127.0.0.1:${config.port}`).replace(/\/+$/, '')}${WEBHOOK_PATH}`;
  let response;
  try {
    response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    fail(`server tidak dapat dihubungi di ${target} (${error.cause?.code || error.message}). Jalankan server dulu: npm run dev`);
  }
  const text = await response.text();
  console.log(`POST ${target} -> HTTP ${response.status}`);
  console.log(`Pembayaran ${payment.provider_order_id}: status sebelumnya "${payment.status}", notifikasi "${status}" (${body.gross_amount}).`);
  console.log(`Balasan server: ${text}`);
  console.log('Buka halaman lacak pesanan untuk melihat perubahannya (halaman memperbarui diri otomatis).');
  if (!response.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
