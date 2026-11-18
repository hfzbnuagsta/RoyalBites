// Endpoint publik untuk pelanggan: menu, konfigurasi bisnis, pemesanan, pelacakan, pembayaran, dan formulir kontak.
import { Router } from 'express';
import { contactMessageSchema, createOrderSchema, trackOrderSchema } from '../schemas.js';
import { createContactMessage } from '../services/messageService.js';
import { createOrder, getCustomerOrderView } from '../services/orderService.js';
import { listPublicProducts } from '../services/productService.js';
import { buildPublicConfig, getAllSettings } from '../services/settingsService.js';
import { buildTrackingView, latestPayment, resolveOrder } from '../services/trackingService.js';
import { AppError, conflict } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validation.js';

export function createPublicRouter({ pool, config, limiters, paymentService }) {
  const router = Router();
  const provider = paymentService.provider;

  // Pelacakan dengan token acak (256 bit) tidak bisa ditebak, jadi tidak diberi limiter ketat.
  // Pelacakan dengan nomor pesanan + nomor WhatsApp bisa ditebak, jadi dibatasi: hanya percobaan gagal yang dihitung.
  const trackGuard = (req, res, next) => (typeof req.body?.token === 'string' ? next() : limiters.trackLookup(req, res, next));

  // Cek kesehatan: apakah server & database hidup. Tidak membocorkan detail error.
  router.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  // Informasi bisnis + metode pembayaran/pengiriman yang aktif.
  router.get('/config', async (req, res) => {
    const qris = provider ? { mode: provider.mode, expiry_minutes: config.payment.qrisExpiryMinutes } : null;
    res.json(buildPublicConfig(await getAllSettings(pool), { qris }));
  });

  // Daftar menu beserta harga & stok resmi dari database.
  router.get('/products', async (req, res) => {
    res.json({ products: await listPublicProducts(pool) });
  });

  // Membuat pesanan. Harga & total dihitung ulang di server; harga dari browser tidak dipakai.
  router.post('/orders', limiters.order, async (req, res) => {
    const input = parseOrThrow(createOrderSchema, req.body);
    const { order: createdOrder, replayed, orderId, trackingToken } = await createOrder(pool, config, input, { paymentProvider: provider });

    // QRIS: kode QR dibuat oleh gateway. Jika gagal, pesanan TETAP ada (stok ditahan sampai batas waktu)
    // dan pelanggan bisa mencoba lagi dari halaman lacak. Pemanggilan berulang tidak membuat transaksi ganda.
    let order = createdOrder;
    let payment = null;
    let paymentError = null;
    if (order.payment_method === 'qris') {
      try {
        await paymentService.ensureQrisPayment(orderId);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        paymentError = { code: error.code, message: error.message };
      }
      payment = await paymentService.viewForOrder(orderId);
      order = await getCustomerOrderView(pool, orderId); // status pembayaran terbaru (mis. "failed" jika QR gagal dibuat)
    }

    // 201 = pesanan baru dibuat, 200 = permintaan yang sama sudah pernah diproses (tidak dibuat ganda).
    res.status(replayed ? 200 : 201).json({
      order,
      replayed,
      tracking_token: trackingToken,
      payment,
      payment_error: paymentError,
    });
  });

  // ------------------------------------------------------------ Lacak pesanan & pembayaran
  // Semua memakai POST + body (token tidak masuk URL/log). Lihat trackOrderSchema untuk bentuk akses.
  router.post('/orders/track', trackGuard, async (req, res) => {
    const lookup = parseOrThrow(trackOrderSchema, req.body);
    const order = await resolveOrder(pool, lookup);
    res.json(await buildTrackingView(pool, paymentService, order));
  });

  // Gambar QRIS asli dari gateway untuk pembayaran yang sedang menunggu.
  router.post('/orders/track/qr', trackGuard, limiters.payment, async (req, res) => {
    const lookup = parseOrThrow(trackOrderSchema, req.body);
    const order = await resolveOrder(pool, lookup);
    const payment = order.payment_method === 'qris' ? await latestPayment(pool, order.id) : null;
    if (!payment) throw conflict('QR_NOT_ACTIVE', 'Pesanan ini tidak memiliki kode QRIS aktif.');
    res.json(await paymentService.getQrDataUri(payment));
  });

  // Membuat kode QRIS baru setelah percobaan sebelumnya gagal (sebelum batas waktu). Idempotent.
  router.post('/orders/track/retry-payment', trackGuard, limiters.payment, async (req, res) => {
    const lookup = parseOrThrow(trackOrderSchema, req.body);
    const order = await resolveOrder(pool, lookup);
    if (order.payment_method !== 'qris') throw conflict('NOT_QRIS', 'Pesanan ini tidak memakai pembayaran QRIS.');
    const { created } = await paymentService.ensureQrisPayment(order.id);
    res.status(created ? 201 : 200).json(await buildTrackingView(pool, paymentService, await resolveOrder(pool, lookup)));
  });

  // "Cek status pembayaran": menanyakan status ke gateway (berguna jika webhook belum sampai). Dibatasi per pembayaran.
  router.post('/orders/track/check-payment', trackGuard, limiters.payment, async (req, res) => {
    const lookup = parseOrThrow(trackOrderSchema, req.body);
    const order = await resolveOrder(pool, lookup);
    if (order.payment_method !== 'qris') throw conflict('NOT_QRIS', 'Pesanan ini tidak memakai pembayaran QRIS.');
    const check = await paymentService.refreshOrderPayment(order.id, { minIntervalSeconds: 8 });
    res.json({ check, ...(await buildTrackingView(pool, paymentService, await resolveOrder(pool, lookup))) });
  });

  // ------------------------------------------------------------ Webhook gateway pembayaran
  // Didaftarkan di dashboard Midtrans (Payment Notification URL). Keamanan = tanda tangan SHA-512 + nominal +
  // (untuk "lunas") konfirmasi ulang ke API status. Balasan 2xx menghentikan retry gateway.
  router.post('/payments/midtrans/notification', limiters.webhook, async (req, res) => {
    const result = await paymentService.handleNotification(req.body);
    res.status(200).json({ ok: true, outcome: result.outcome });
  });

  // Formulir kontak: pesan benar-benar disimpan di database dan bisa dibaca admin.
  router.post('/contact', limiters.contact, async (req, res) => {
    const input = parseOrThrow(contactMessageSchema, req.body);
    await createContactMessage(pool, input);
    res.status(201).json({ ok: true });
  });

  return router;
}
