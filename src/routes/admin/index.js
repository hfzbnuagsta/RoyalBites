// Semua endpoint admin ( /api/admin/... ).
// Urutan penjagaan: sesi login -> (untuk perubahan data) token CSRF -> peran (role) yang sesuai.
import { Router } from 'express';
import {
  changePasswordSchema,
  createProductSchema,
  loginSchema,
  orderListQuerySchema,
  reportQuerySchema,
  updateOrderStatusSchema,
  updatePaymentStatusSchema,
  updateProductSchema,
} from '../../schemas.js';
import { sessionCookieOptions } from '../../middleware/auth.js';
import { describePaymentConfig } from '../../payments/describe.js';
import { saveUploadedImage } from '../../middleware/upload.js';
import {
  authenticate,
  changePassword,
  createSession,
  destroySession,
} from '../../services/authService.js';
import { listContactMessages, setMessageRead } from '../../services/messageService.js';
import {
  getAdminOrderDetail,
  listOrders,
  updateOrderStatus,
  updatePaymentStatus,
} from '../../services/orderService.js';
import {
  createProduct,
  getProductById,
  listAdminProducts,
  softDeleteProduct,
  updateProduct,
} from '../../services/productService.js';
import { describeSettings, getAllSettings, updateSettings } from '../../services/settingsService.js';
import { getSummary } from '../../services/statsService.js';
import { AppError, badRequest } from '../../utils/errors.js';
import { parseIdParam, parseOrThrow } from '../../utils/validation.js';

export function createAdminRouter({ pool, config, auth, limiters, paymentService, imageParser }) {
  const router = Router();
  const { requireAdmin, requireRole, requireCsrf } = auth;
  const guard = [requireAdmin, requireCsrf]; // login + token CSRF (untuk method yang mengubah data)

  // ------------------------------------------------------------ Login / sesi
  router.post('/login', limiters.login, async (req, res) => {
    const { username, password } = parseOrThrow(loginSchema, req.body);
    const user = await authenticate(pool, config, username.toLowerCase(), password);
    if (!user) {
      // Pesan sama untuk "user tidak ada" dan "password salah" agar username tidak bisa ditebak.
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Username atau password salah.');
    }
    const session = await createSession(pool, config, user, { ip: req.ip, userAgent: req.get('user-agent') });
    res.cookie(auth.cookieName, session.token, sessionCookieOptions(config, session.expiresAt));
    res.json({ user, csrf_token: session.csrfToken });
  });

  router.get('/session', requireAdmin, (req, res) => {
    res.json({ user: req.admin, csrf_token: req.adminSession.csrfToken });
  });

  router.post('/logout', guard, async (req, res) => {
    await destroySession(pool, req.adminToken);
    res.clearCookie(auth.cookieName, sessionCookieOptions(config));
    res.json({ ok: true });
  });

  router.post('/password', guard, async (req, res) => {
    const { current_password: current, new_password: next } = parseOrThrow(changePasswordSchema, req.body);
    await changePassword(pool, config, req.admin, req.adminSession.id, current, next);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ Ringkasan
  router.get('/summary', requireAdmin, async (req, res) => {
    const query = parseOrThrow(reportQuerySchema, req.query);
    if (Boolean(query.from) !== Boolean(query.to)) {
      throw badRequest('Isi tanggal awal dan tanggal akhir sekaligus.');
    }
    res.json(await getSummary(pool, config, query));
  });

  // ------------------------------------------------------------ Produk
  router.get('/products', requireAdmin, async (req, res) => {
    const products = await listAdminProducts(pool, {
      includeDeleted: req.query.include_deleted === '1',
      search: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '',
      category: typeof req.query.category === 'string' ? req.query.category : '',
    });
    res.json({ products });
  });

  router.post('/products', guard, async (req, res) => {
    const data = parseOrThrow(createProductSchema, req.body);
    res.status(201).json({ product: await createProduct(pool, data) });
  });

  router.patch('/products/:id', guard, async (req, res) => {
    const id = parseIdParam(req.params.id);
    const patch = parseOrThrow(updateProductSchema, req.body);
    res.json({ product: await updateProduct(pool, id, patch) });
  });

  // Hanya pemilik (owner) yang boleh menghapus produk.
  router.delete('/products/:id', guard, requireRole('owner'), async (req, res) => {
    const id = parseIdParam(req.params.id);
    await softDeleteProduct(pool, id);
    res.json({ ok: true });
  });

  router.get('/products/:id', requireAdmin, async (req, res) => {
    res.json({ product: await getProductById(pool, parseIdParam(req.params.id)) });
  });

  // ------------------------------------------------------------ Upload gambar
  router.post('/uploads', guard, imageParser, async (req, res) => {
    const imagePath = await saveUploadedImage(config, req.file);
    res.status(201).json({ path: imagePath });
  });

  // ------------------------------------------------------------ Pesanan
  router.get('/orders', requireAdmin, async (req, res) => {
    const query = parseOrThrow(orderListQuerySchema, req.query);
    res.json(await listOrders(pool, config, query));
  });

  router.get('/orders/:id', requireAdmin, async (req, res) => {
    res.json({ order: await getAdminOrderDetail(pool, parseIdParam(req.params.id)) });
  });

  router.patch('/orders/:id/status', guard, async (req, res) => {
    const id = parseIdParam(req.params.id);
    const body = parseOrThrow(updateOrderStatusSchema, req.body);
    // Jika pesanan QRIS yang masih menunggu dibayar dibatalkan, transaksinya juga ditutup di gateway (upaya terbaik).
    const order = await updateOrderStatus(pool, id, body, req.admin, {
      afterCommit: (providerOrderIds) => paymentService.expireAtProvider(providerOrderIds),
    });
    res.json({ order });
  });

  // "Periksa status ke gateway": menanyakan status pembayaran QRIS yang menunggu langsung ke penyedia pembayaran.
  router.post('/orders/:id/payment/refresh', guard, async (req, res) => {
    const id = parseIdParam(req.params.id);
    await getAdminOrderDetail(pool, id); // 404 jika pesanan tidak ada
    const check = await paymentService.refreshOrderPayment(id);
    res.json({ check, order: await getAdminOrderDetail(pool, id) });
  });

  router.patch('/orders/:id/payment', guard, async (req, res) => {
    const id = parseIdParam(req.params.id);
    const body = parseOrThrow(updatePaymentStatusSchema, req.body);
    res.json({ order: await updatePaymentStatus(pool, id, body, req.admin) });
  });

  // ------------------------------------------------------------ Pengaturan bisnis (hanya owner yang boleh mengubah)
  router.get('/settings', requireAdmin, async (req, res) => {
    res.json({
      settings: await getAllSettings(pool),
      fields: describeSettings(),
      payment: describePaymentConfig(config, paymentService.provider),
    });
  });

  router.put('/settings', guard, requireRole('owner'), async (req, res) => {
    res.json({ settings: await updateSettings(pool, req.body, { qrisAvailable: paymentService.isAvailable() }) });
  });

  // ------------------------------------------------------------ Pesan dari formulir kontak
  router.get('/messages', requireAdmin, async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    res.json(await listContactMessages(pool, { unreadOnly: req.query.unread === '1', page }));
  });

  router.patch('/messages/:id', guard, async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (typeof req.body?.is_read !== 'boolean') throw badRequest('Field is_read harus true atau false.');
    await setMessageRead(pool, id, req.body.is_read);
    res.json({ ok: true });
  });

  return router;
}
