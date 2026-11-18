// Pembayaran QRIS lewat payment gateway (Midtrans, atau mock saat development).
//
// PRINSIP KEAMANAN & KONSISTENSI
//  1. Pesanan baru dianggap LUNAS hanya jika gateway yang mengonfirmasi (webhook bertanda tangan valid atau
//     respons API status dari gateway). Respons/klik di browser tidak pernah dipercaya.
//  2. Semua perubahan status berjalan dalam satu transaksi database dengan urutan kunci yang tetap:
//     baris pesanan (orders) dulu, baru baris pembayaran (payments). Tidak ada deadlock antar jalur
//     (webhook, cek status, sweeper, admin) dan tidak ada stok yang dikembalikan dua kali.
//  3. Webhook idempotent: kiriman ulang yang identik dicatat sekali (dedupe_key), kiriman dengan status yang
//     sama menjadi no-op, dan kiriman yang datang terlambat/tidak berurutan tidak boleh memundurkan status.
//  4. Satu pesanan hanya boleh punya satu pembayaran "pending" (dijaga indeks UNIQUE di database).
//  5. Nominal notifikasi harus sama dengan nominal pembayaran; jika tidak, status TIDAK berubah dan admin diberi tanda.
import crypto from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { PaymentProviderError } from '../payments/errors.js';
import { AppError, conflict, notFound } from '../utils/errors.js';
import { cancelOrderInTx } from './orderService.js';

/** Perpindahan status pembayaran yang diizinkan. Status tidak boleh mundur (mis. paid -> pending). */
const PAYMENT_TRANSITIONS = {
  pending: ['paid', 'expired', 'cancelled', 'failed'],
  paid: ['refunded'],
  // Uang yang benar-benar masuk setelah percobaan dinyatakan gagal/kedaluwarsa tetap harus tercatat.
  expired: ['paid'],
  cancelled: ['paid'],
  failed: ['paid'],
  refunded: [],
};

const STALE_CREATION_MS = 120_000; // pembayaran "pending" tanpa referensi gateway setelah 2 menit dianggap macet

/** Memetakan transaction_status gateway ke status pembayaran kita. target null = abaikan. */
export function mapProviderStatus({ transactionStatus, statusCode, fraudStatus }) {
  switch (transactionStatus) {
    case 'settlement':
    case 'capture':
      // Dokumentasi Midtrans: sukses = status_code 200 + fraud_status accept + settlement/capture.
      if (fraudStatus && fraudStatus !== 'accept') return { target: null, reason: 'fraud_status_not_accepted' };
      if (statusCode && statusCode !== '200') return { target: null, reason: 'status_code_not_success' };
      return { target: 'paid' };
    case 'pending':
      return { target: 'pending' };
    case 'expire':
      return { target: 'expired' };
    case 'cancel':
      return { target: 'cancelled' };
    case 'deny':
    case 'failure':
      return { target: 'failed' };
    case 'refund':
    case 'chargeback':
      return { target: 'refunded' };
    default:
      return { target: null, reason: 'unsupported_status' };
  }
}

/** "20000.00" -> 20000. Mengembalikan null jika bukan rupiah bulat. */
export function parseGrossAmount(value) {
  if (value === null || value === undefined) return null;
  const match = /^(\d{1,12})(?:\.0{1,2})?$/.exec(String(value).trim());
  return match ? Number(match[1]) : null;
}

function notificationDedupeKey(body) {
  const fields = ['order_id', 'transaction_id', 'transaction_status', 'status_code', 'gross_amount', 'fraud_status', 'transaction_time', 'settlement_time'];
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(fields.map((field) => (body[field] === undefined ? null : String(body[field])))))
    .digest('hex');
}

function sanitizePayload(body) {
  const payload = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'signature_key') continue; // turunan dari kunci rahasia; tidak perlu disimpan
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) payload[key] = value;
  }
  return payload;
}

export function createPaymentService({ pool, config, provider, logger, clock = () => new Date() }) {
  const settings = config.payment;

  // ---------------------------------------------------------------------------------------------
  // Inti: menerapkan status dari gateway (dipakai webhook, cek status, dan sweeper)
  // ---------------------------------------------------------------------------------------------

  async function addPaymentEvent(connection, orderId, from, to, note) {
    await connection.execute(
      "INSERT INTO order_events (order_id, event_type, from_value, to_value, note) VALUES (?, 'payment', ?, ?, ?)",
      [orderId, from, to, note ? String(note).slice(0, 255) : null],
    );
  }

  async function flagForReview(connection, paymentId, note) {
    await connection.execute('UPDATE payments SET review_note = ? WHERE id = ?', [String(note).slice(0, 255), paymentId]);
  }

  /** Mengubah satu pembayaran + dampaknya pada pesanan. Dipanggil di dalam transaksi dengan order & payment sudah terkunci. */
  async function applyTransition(connection, order, payment, update, target, ctx) {
    const nowDate = ctx.now;
    const providerStatus = update.transactionStatus || null;
    const fraudStatus = update.fraudStatus || null;

    if (target === 'paid') {
      const [others] = await connection.execute(
        'SELECT id, status, provider_order_id FROM payments WHERE order_id = ? AND id <> ? ORDER BY id FOR UPDATE',
        [order.id, payment.id],
      );
      // Pembayaran lain yang masih menunggu menjadi tidak perlu: tutup di database dan (setelah commit) di gateway.
      const pendingOthers = others.filter((other) => other.status === 'pending');
      if (pendingOthers.length > 0) {
        await connection.query(
          "UPDATE payments SET status = 'cancelled', failure_reason = 'Pesanan ini sudah dibayar lewat transaksi lain' WHERE id IN (?)",
          [pendingOthers.map((other) => other.id)],
        );
        ctx.toExpire.push(...pendingOthers.map((other) => other.provider_order_id));
      }
      const otherPaid = others.some((other) => other.status === 'paid');

      await connection.execute(
        "UPDATE payments SET status = 'paid', paid_at = ?, provider_status = ?, fraud_status = ?, failure_reason = NULL WHERE id = ?",
        [nowDate, providerStatus, fraudStatus, payment.id],
      );

      if (otherPaid || order.payment_status === 'paid') {
        const note = 'PEMBAYARAN GANDA: pesanan ini sudah lunas sebelumnya. Kembalikan salah satu pembayaran lewat dashboard gateway.';
        await flagForReview(connection, payment.id, note);
        await addPaymentEvent(connection, order.id, order.payment_status, 'paid', note);
      } else {
        await connection.execute("UPDATE orders SET payment_status = 'paid', paid_at = ? WHERE id = ?", [nowDate, order.id]);
        await addPaymentEvent(connection, order.id, order.payment_status, 'paid', 'Pembayaran QRIS terverifikasi oleh gateway');
      }
      if (order.order_status === 'cancelled') {
        const note = 'DIBAYAR SETELAH PESANAN DIBATALKAN/KEDALUWARSA: kembalikan dana lewat dashboard gateway lalu tandai Dikembalikan.';
        await flagForReview(connection, payment.id, note);
        await addPaymentEvent(connection, order.id, 'paid', 'paid', note);
      }
      return;
    }

    if (target === 'expired') {
      await connection.execute(
        "UPDATE payments SET status = 'expired', provider_status = ?, fraud_status = ?, failure_reason = 'Batas waktu pembayaran habis' WHERE id = ?",
        [providerStatus, fraudStatus, payment.id],
      );
      if (order.order_status === 'pending' && ['pending', 'failed', 'cancelled'].includes(order.payment_status)) {
        // Pesanan belum dibayar sampai batas waktu: batalkan dan kembalikan stok (sekali, lewat cancelOrderInTx).
        await cancelOrderInTx(connection, order, { reason: 'Pembayaran QRIS kedaluwarsa', releasePaymentAs: 'expired' });
      } else if (order.payment_status === 'pending') {
        await connection.execute("UPDATE orders SET payment_status = 'expired' WHERE id = ?", [order.id]);
        await addPaymentEvent(connection, order.id, 'pending', 'expired', 'Batas waktu pembayaran habis');
      }
      return;
    }

    if (target === 'failed' || target === 'cancelled') {
      await connection.execute(
        'UPDATE payments SET status = ?, provider_status = ?, fraud_status = ?, failure_reason = ? WHERE id = ?',
        [target, providerStatus, fraudStatus, target === 'failed' ? 'Pembayaran ditolak/gagal di gateway' : 'Dibatalkan di gateway', payment.id],
      );
      // Pesanan tetap menunggu (stok masih ditahan): pelanggan boleh membuat kode QRIS baru sampai batas waktu.
      if (order.payment_status === 'pending' && order.order_status !== 'cancelled') {
        await connection.execute('UPDATE orders SET payment_status = ? WHERE id = ?', [target, order.id]);
        await addPaymentEvent(connection, order.id, 'pending', target, `Pembayaran QRIS ${target === 'failed' ? 'gagal' : 'dibatalkan'} di gateway`);
      }
      return;
    }

    if (target === 'refunded') {
      await connection.execute(
        "UPDATE payments SET status = 'refunded', provider_status = ?, fraud_status = ?, review_note = NULL WHERE id = ?",
        [providerStatus, fraudStatus, payment.id],
      );
      const [stillPaid] = await connection.execute(
        "SELECT id FROM payments WHERE order_id = ? AND status = 'paid' AND id <> ? LIMIT 1",
        [order.id, payment.id],
      );
      if (order.payment_status === 'paid' && stillPaid.length === 0) {
        await connection.execute("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [order.id]);
        await addPaymentEvent(connection, order.id, 'paid', 'refunded', 'Pembayaran dikembalikan (dari gateway)');
      }
    }
  }

  /**
   * Menerapkan satu pembaruan status dari gateway secara atomik.
   * @returns {Promise<{outcome: string, paymentId?: number, orderId?: number, from?: string, to?: string, toExpire: string[]}>}
   */
  async function processProviderUpdate({ providerOrderId, update, source, notification = null }) {
    const now = clock();
    const toExpire = [];
    const result = await withTransaction(pool, async (connection) => {
      const [found] = await connection.execute('SELECT id, order_id FROM payments WHERE provider_order_id = ?', [providerOrderId]);

      const recordNotification = async (paymentId, outcome) => {
        if (!notification) return;
        await connection.execute(
          `INSERT INTO payment_notifications
             (payment_id, provider, provider_order_id, provider_transaction_id, transaction_status, status_code, gross_amount, dedupe_key, outcome, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            paymentId,
            provider.name,
            providerOrderId,
            update.transactionId,
            update.transactionStatus || 'unknown',
            update.statusCode,
            update.grossAmount,
            notification.dedupeKey,
            outcome,
            JSON.stringify(notification.payload),
          ],
        );
      };

      if (found.length === 0) {
        try {
          await recordNotification(null, 'unknown_payment');
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
        }
        return { outcome: 'unknown_payment' };
      }

      // Urutan kunci tetap: pesanan lalu pembayaran.
      const [orderRows] = await connection.execute(
        `SELECT id, order_number, order_status, payment_method, payment_status, payment_expires_at, total
           FROM orders WHERE id = ? FOR UPDATE`,
        [found[0].order_id],
      );
      const [paymentRows] = await connection.execute('SELECT * FROM payments WHERE id = ? FOR UPDATE', [found[0].id]);
      const order = orderRows[0];
      const payment = paymentRows[0];
      const base = { paymentId: payment.id, orderId: order.id };

      if (payment.provider !== provider.name) {
        try {
          await recordNotification(null, 'unknown_payment');
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
        }
        return { outcome: 'unknown_payment' };
      }

      // Kiriman identik (retry gateway) hanya dicatat sekali. Dicatat di transaksi yang sama dengan efeknya,
      // jadi jika pemrosesan gagal, catatannya ikut dibatalkan dan retry berikutnya diproses ulang.
      let notificationRecorded = false;
      if (notification) {
        try {
          await recordNotification(payment.id, 'processing');
          notificationRecorded = true;
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') return { outcome: 'duplicate_notification', ...base };
          throw error;
        }
      }
      const finish = async (outcome, extra = {}) => {
        if (notificationRecorded) {
          await connection.execute('UPDATE payment_notifications SET outcome = ? WHERE dedupe_key = ?', [outcome, notification.dedupeKey]);
        }
        return { outcome, ...base, ...extra };
      };

      // Nominal harus cocok dengan pembayaran kita.
      if (update.grossAmount !== null && update.grossAmount !== undefined) {
        const amount = parseGrossAmount(update.grossAmount);
        if (amount !== payment.amount) {
          await flagForReview(connection, payment.id, `Nominal dari gateway (${update.grossAmount}) tidak sama dengan nominal pembayaran (${payment.amount}). Status tidak diubah.`);
          logger.warn('payment_amount_mismatch', { payment_id: payment.id, order_id: order.id, source });
          return finish('amount_mismatch');
        }
      }
      if (update.transactionId && payment.provider_transaction_id && update.transactionId !== payment.provider_transaction_id) {
        await flagForReview(connection, payment.id, 'transaction_id dari gateway tidak cocok dengan yang tersimpan. Status tidak diubah.');
        logger.warn('payment_transaction_mismatch', { payment_id: payment.id, order_id: order.id, source });
        return finish('transaction_mismatch');
      }

      const mapped = mapProviderStatus(update);
      if (!mapped.target) {
        if (mapped.reason === 'fraud_status_not_accepted' || mapped.reason === 'status_code_not_success') {
          await flagForReview(connection, payment.id, `Status "${update.transactionStatus}" ditolak (${mapped.reason}). Periksa di dashboard gateway.`);
        }
        return finish('unsupported_status');
      }

      if (update.transactionId && !payment.provider_transaction_id) {
        await connection.execute('UPDATE payments SET provider_transaction_id = ? WHERE id = ?', [update.transactionId, payment.id]);
      }

      if (mapped.target === payment.status) {
        await connection.execute('UPDATE payments SET provider_status = ? WHERE id = ?', [update.transactionStatus || null, payment.id]);
        return finish('duplicate_status');
      }
      if (!PAYMENT_TRANSITIONS[payment.status].includes(mapped.target)) {
        return finish('out_of_order'); // mis. "pending" yang terlambat tiba setelah "paid": diabaikan
      }

      await applyTransition(connection, order, payment, update, mapped.target, { now, toExpire });
      return finish('applied', { from: payment.status, to: mapped.target });
    });

    result.toExpire = toExpire;
    await expireAtProvider(toExpire);
    return result;
  }

  /** Menutup transaksi yang belum dibayar di gateway (upaya terbaik; kegagalan hanya dicatat). */
  async function expireAtProvider(providerOrderIds) {
    if (!provider || providerOrderIds.length === 0 || provider.name === 'mock') return;
    for (const id of providerOrderIds) {
      try {
        await provider.expire(id);
      } catch (error) {
        logger.warn('payment_provider_expire_failed', { provider_order_id: id, error: error.message });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Membuat pembayaran QRIS
  // ---------------------------------------------------------------------------------------------

  async function markCreationFailed(paymentId, orderId, reason) {
    await withTransaction(pool, async (connection) => {
      const [orderRows] = await connection.execute('SELECT id, payment_status FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      const [paymentRows] = await connection.execute('SELECT id, status FROM payments WHERE id = ? FOR UPDATE', [paymentId]);
      if (paymentRows[0]?.status !== 'pending') return;
      await connection.execute("UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ?", [String(reason).slice(0, 255), paymentId]);
      if (orderRows[0].payment_status === 'pending') {
        await connection.execute("UPDATE orders SET payment_status = 'failed' WHERE id = ?", [orderId]);
        await addPaymentEvent(connection, orderId, 'pending', 'failed', 'Kode QRIS gagal dibuat');
      }
    });
  }

  /**
   * Memastikan pesanan QRIS punya pembayaran aktif. AMAN dipanggil berulang (refresh halaman, klik ganda, retry):
   * jika sudah ada pembayaran menunggu/lunas, itulah yang dikembalikan; tidak ada transaksi ganda di gateway.
   * @returns {Promise<{payment: object, created: boolean}>} baris pembayaran terbaru
   */
  async function ensureQrisPayment(orderId) {
    if (!provider) throw new AppError(400, 'PAYMENT_UNAVAILABLE', 'Pembayaran QRIS belum tersedia.');
    const now = clock();

    const prepared = await withTransaction(pool, async (connection) => {
      const [orderRows] = await connection.execute(
        `SELECT id, order_number, customer_name, total, order_status, payment_method, payment_status, payment_expires_at
           FROM orders WHERE id = ? FOR UPDATE`,
        [orderId],
      );
      if (orderRows.length === 0) throw notFound('Pesanan tidak ditemukan.');
      const order = orderRows[0];
      if (order.payment_method !== 'qris') throw conflict('NOT_QRIS', 'Pesanan ini tidak memakai pembayaran QRIS.');

      const [payments] = await connection.execute('SELECT * FROM payments WHERE order_id = ? ORDER BY id FOR UPDATE', [orderId]);
      const paid = payments.find((payment) => payment.status === 'paid');
      if (paid) return { existing: paid };

      const pending = payments.find((payment) => payment.status === 'pending');
      if (pending) {
        const stale = !pending.provider_transaction_id && now.getTime() - new Date(pending.created_at).getTime() > STALE_CREATION_MS;
        if (!stale) return { existing: pending };
        await connection.execute("UPDATE payments SET status = 'failed', failure_reason = 'Pembuatan QRIS tidak selesai' WHERE id = ?", [pending.id]);
      }

      if (order.order_status !== 'pending' || !['pending', 'failed', 'cancelled'].includes(order.payment_status)) {
        throw conflict('PAYMENT_NOT_ALLOWED', 'Pesanan ini sudah tidak bisa dibayar (dibatalkan atau kedaluwarsa). Silakan buat pesanan baru.');
      }
      if (order.payment_expires_at && new Date(order.payment_expires_at) <= now) {
        throw conflict('PAYMENT_EXPIRED', 'Batas waktu pembayaran sudah habis. Silakan buat pesanan baru.');
      }

      const providerOrderId = `${order.order_number}-${payments.length + 1}`;
      const [insert] = await connection.execute(
        `INSERT INTO payments (order_id, provider, method, provider_order_id, amount, status, expires_at)
         VALUES (?, ?, 'qris', ?, ?, 'pending', ?)`,
        [order.id, provider.name, providerOrderId, order.total, order.payment_expires_at],
      );
      if (order.payment_status !== 'pending') {
        await connection.execute("UPDATE orders SET payment_status = 'pending' WHERE id = ?", [order.id]);
        await addPaymentEvent(connection, order.id, order.payment_status, 'pending', 'Percobaan pembayaran QRIS baru');
      }
      return {
        created: {
          paymentId: insert.insertId,
          providerOrderId,
          amount: order.total,
          customerName: order.customer_name,
          expiresAt: order.payment_expires_at ? new Date(order.payment_expires_at) : new Date(now.getTime() + settings.qrisExpiryMinutes * 60_000),
        },
      };
    });

    if (prepared.existing) return { payment: prepared.existing, created: false };

    const { created } = prepared;
    const expiryMinutes = Math.max(1, Math.ceil((created.expiresAt.getTime() - now.getTime()) / 60_000));
    try {
      const qris = await provider.createQris({
        providerOrderId: created.providerOrderId,
        amount: created.amount,
        customerName: created.customerName,
        expiryMinutes,
      });
      await pool.execute(
        `UPDATE payments SET provider_transaction_id = ?, qr_url = ?, qr_string = ?, provider_status = 'pending'
          WHERE id = ? AND status = 'pending'`,
        [qris.transactionId, qris.qrUrl, qris.qrString, created.paymentId],
      );
    } catch (error) {
      logger.error('payment_create_failed', {
        order_id: orderId,
        provider_order_id: created.providerOrderId,
        retryable: error instanceof PaymentProviderError ? error.retryable : null,
        error: error.message,
      });
      await markCreationFailed(created.paymentId, orderId, error instanceof PaymentProviderError ? error.message : 'Kesalahan internal');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Kode QRIS belum bisa dibuat saat ini. Silakan coba lagi sebentar lagi.');
    }
    const [rows] = await pool.execute('SELECT * FROM payments WHERE id = ?', [created.paymentId]);
    return { payment: rows[0], created: true };
  }

  // ---------------------------------------------------------------------------------------------
  // Webhook & pengecekan status
  // ---------------------------------------------------------------------------------------------

  /** Notifikasi dari gateway. Melempar AppError agar status HTTP-nya sesuai kebutuhan retry gateway. */
  async function handleNotification(body) {
    if (!provider) throw new AppError(404, 'NOT_FOUND', 'Pembayaran QRIS tidak aktif.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'INVALID_NOTIFICATION', 'Isi notifikasi tidak valid.');
    }
    // 1) Tanda tangan WAJIB valid sebelum isi notifikasi dipercaya atau disimpan.
    if (!provider.verifyNotification(body)) {
      logger.warn('payment_webhook_bad_signature', { order_id: typeof body.order_id === 'string' ? body.order_id.slice(0, 64) : null });
      throw new AppError(403, 'INVALID_SIGNATURE', 'Tanda tangan notifikasi tidak valid.');
    }
    let update = provider.normalizeNotification(body);
    if (!update.orderId || !update.transactionStatus) {
      throw new AppError(400, 'INVALID_NOTIFICATION', 'Isi notifikasi tidak lengkap.');
    }

    // 2) Sebelum menandai LUNAS, konfirmasi ulang ke API status gateway (disarankan dokumentasi Midtrans).
    //    Jika gateway tidak bisa dihubungi, balas 503 supaya gateway mengirim ulang nanti.
    if (mapProviderStatus(update).target === 'paid' && settings.verifyWithStatusApi && provider.capabilities.statusApi) {
      const [rows] = await pool.execute('SELECT id, status FROM payments WHERE provider_order_id = ? AND provider = ?', [update.orderId, provider.name]);
      // Pembayaran yang sudah "paid" (kiriman ulang) tidak perlu dikonfirmasi lagi: hasilnya no-op / ditandai ganda.
      if (rows.length > 0 && rows[0].status !== 'paid') {
        let confirmed;
        try {
          confirmed = await provider.getStatus(update.orderId);
        } catch (error) {
          logger.warn('payment_webhook_status_check_failed', { order_id: update.orderId, error: error.message });
          throw new AppError(503, 'PAYMENT_STATUS_UNAVAILABLE', 'Belum bisa mengonfirmasi status ke gateway. Silakan kirim ulang.');
        }
        if (!confirmed.found || mapProviderStatus(confirmed).target !== 'paid') {
          logger.warn('payment_webhook_not_confirmed', { order_id: update.orderId });
          throw new AppError(503, 'PAYMENT_NOT_CONFIRMED', 'Status lunas belum terkonfirmasi di API gateway. Silakan kirim ulang.');
        }
        update = { ...confirmed, orderId: update.orderId };
      }
    }

    const outcome = await processProviderUpdate({
      providerOrderId: update.orderId,
      update,
      source: 'webhook',
      notification: { dedupeKey: notificationDedupeKey(body), payload: sanitizePayload(body) },
    });
    logger.info('payment_webhook', { provider_order_id: update.orderId, status: update.transactionStatus, outcome: outcome.outcome });
    return { outcome: outcome.outcome };
  }

  /**
   * Menanyakan status ke gateway untuk pembayaran yang masih menunggu (dipakai tombol "cek status",
   * halaman lacak, admin, dan sweeper). Berguna jika webhook belum/tidak sampai (mis. server lokal tanpa URL publik).
   */
  async function refreshOrderPayment(orderId, { minIntervalSeconds = 0 } = {}) {
    if (!provider?.capabilities.statusApi) return { checked: false, reason: 'unsupported' };
    const now = clock();
    const [rows] = await pool.execute(
      "SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
      [orderId],
    );
    const payment = rows[0];
    if (!payment) return { checked: false, reason: 'no_pending_payment' };
    if (
      minIntervalSeconds > 0 &&
      payment.last_checked_at &&
      now.getTime() - new Date(payment.last_checked_at).getTime() < minIntervalSeconds * 1000
    ) {
      return { checked: false, reason: 'throttled' };
    }
    await pool.execute('UPDATE payments SET last_checked_at = ? WHERE id = ?', [now, payment.id]);

    let status;
    try {
      status = await provider.getStatus(payment.provider_order_id);
    } catch (error) {
      logger.warn('payment_status_check_failed', { provider_order_id: payment.provider_order_id, error: error.message });
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Gagal menghubungi gateway pembayaran. Coba lagi sebentar lagi.');
    }
    if (!status.found) {
      // Gateway tidak mengenal transaksi ini. Jika pembuatannya memang tidak pernah selesai, tandai gagal agar bisa diulang.
      if (!payment.provider_transaction_id && now.getTime() - new Date(payment.created_at).getTime() > STALE_CREATION_MS) {
        await markCreationFailed(payment.id, orderId, 'Transaksi tidak ditemukan di gateway');
      }
      return { checked: true, found: false };
    }
    const result = await processProviderUpdate({ providerOrderId: payment.provider_order_id, update: status, source: 'status_check' });
    return { checked: true, found: true, outcome: result.outcome };
  }

  // ---------------------------------------------------------------------------------------------
  // Sweeper: pesanan QRIS yang tidak dibayar sampai batas waktu
  // ---------------------------------------------------------------------------------------------

  async function expireOrderLocally(orderId) {
    const toRelease = [];
    await withTransaction(pool, async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id, order_status, payment_method, payment_status FROM orders WHERE id = ? FOR UPDATE',
        [orderId],
      );
      const order = rows[0];
      // Periksa ulang setelah terkunci: mungkin baru saja dibayar / dibatalkan oleh jalur lain.
      if (!order || order.payment_method !== 'qris' || order.order_status !== 'pending') return;
      if (!['pending', 'failed', 'cancelled'].includes(order.payment_status)) return;
      const released = await cancelOrderInTx(connection, order, { reason: 'Pembayaran QRIS tidak diterima sampai batas waktu', releasePaymentAs: 'expired' });
      toRelease.push(...released);
    });
    await expireAtProvider(toRelease);
  }

  /**
   * Membatalkan pesanan QRIS yang melewati batas bayar (+ masa tenggang). Sebelum membatalkan, status ditanyakan
   * ke gateway (jika didukung) sehingga pembayaran yang baru masuk tidak ikut dibatalkan.
   */
  async function sweepExpired({ now = clock(), limit = 50 } = {}) {
    const cutoff = new Date(now.getTime() - settings.graceSeconds * 1000);
    const [candidates] = await pool.execute(
      `SELECT id FROM orders
        WHERE payment_method = 'qris' AND order_status = 'pending'
          AND payment_status IN ('pending','failed','cancelled') AND payment_expires_at < ?
        ORDER BY payment_expires_at LIMIT ${Number(limit)}`,
      [cutoff],
    );
    const summary = { checked: candidates.length, expired: 0, paid: 0, errors: 0 };
    for (const { id } of candidates) {
      try {
        if (provider?.capabilities.statusApi) {
          await refreshOrderPayment(id);
        }
        const [rows] = await pool.execute('SELECT order_status, payment_status FROM orders WHERE id = ?', [id]);
        const order = rows[0];
        if (order.payment_status === 'paid') {
          summary.paid += 1; // ternyata sudah dibayar (terdeteksi lewat cek status)
        } else if (order.order_status === 'cancelled') {
          summary.expired += 1; // gateway sendiri sudah menyatakan "expire" dan pesanan dibatalkan
        } else if (order.order_status === 'pending' && ['pending', 'failed', 'cancelled'].includes(order.payment_status)) {
          await expireOrderLocally(id);
          summary.expired += 1;
        }
      } catch (error) {
        summary.errors += 1;
        logger.warn('payment_sweep_failed', { order_id: id, error: error.message });
      }
    }
    return summary;
  }

  function startSweeper() {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        const summary = await sweepExpired();
        if (summary.checked > 0) logger.info('payment_sweep', summary);
      } catch (error) {
        logger.error('payment_sweep_error', { error: error.message });
      } finally {
        running = false;
      }
    }, settings.sweepIntervalSeconds * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  // ---------------------------------------------------------------------------------------------
  // Tampilan & gambar QR untuk pelanggan
  // ---------------------------------------------------------------------------------------------

  function viewOf(payment, order) {
    if (!payment) return null;
    const expiresAt = payment.expires_at ? new Date(payment.expires_at) : null;
    const orderOpen = order.order_status === 'pending' && (!expiresAt || expiresAt > clock());
    return {
      status: payment.status,
      method: 'qris',
      amount: payment.amount,
      expires_at: expiresAt,
      paid_at: payment.paid_at,
      qr_ready: payment.status === 'pending' && Boolean(payment.qr_url),
      // Boleh membuat kode baru jika percobaan sebelumnya gagal/dibatalkan dan batas waktu belum habis.
      can_retry: Boolean(provider) && orderOpen && ['failed', 'cancelled'].includes(order.payment_status),
      mode: payment.provider === 'mock' ? 'mock' : settings.isProduction ? 'live' : 'sandbox',
    };
  }

  /** Tampilan pembayaran terbaru sebuah pesanan (null jika bukan QRIS / belum ada pembayaran). */
  async function viewForOrder(orderId) {
    const [orders] = await pool.execute('SELECT order_status, payment_method, payment_status FROM orders WHERE id = ?', [orderId]);
    if (orders.length === 0 || orders[0].payment_method !== 'qris') return null;
    const [payments] = await pool.execute('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
    return viewOf(payments[0] ?? null, orders[0]);
  }

  /** Gambar QR ASLI dari gateway sebagai data URI (tanpa endpoint publik yang memuat token di URL). */
  async function getQrDataUri(payment) {
    if (!provider) throw new AppError(400, 'PAYMENT_UNAVAILABLE', 'Pembayaran QRIS belum tersedia.');
    const expired = payment.expires_at && new Date(payment.expires_at) <= clock();
    if (payment.status !== 'pending' || expired) {
      throw conflict('QR_NOT_ACTIVE', 'Kode QRIS ini sudah tidak aktif.');
    }
    if (!payment.qr_url) throw conflict('QR_NOT_READY', 'Kode QRIS sedang disiapkan. Coba lagi sebentar.');
    try {
      const { contentType, buffer } = await provider.fetchQrImage(payment.qr_url);
      return { content_type: contentType, data_uri: `data:${contentType};base64,${buffer.toString('base64')}` };
    } catch (error) {
      logger.error('payment_qr_fetch_failed', { payment_id: payment.id, error: error.message });
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'Gambar QRIS belum bisa dimuat. Coba lagi sebentar lagi.');
    }
  }

  return {
    provider,
    isAvailable: () => Boolean(provider),
    ensureQrisPayment,
    handleNotification,
    processProviderUpdate,
    refreshOrderPayment,
    sweepExpired,
    startSweeper,
    expireAtProvider,
    viewOf,
    viewForOrder,
    getQrDataUri,
  };
}
