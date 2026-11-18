// Logika pemesanan: membuat pesanan (transaksi + stok), mengubah status, dan membaca data pesanan.
//
// PRINSIP PENTING:
//  1. Harga SELALU diambil dari database, bukan dari browser.
//  2. Pembuatan pesanan + pengurangan stok terjadi dalam SATU transaksi database.
//  3. Baris produk dikunci (SELECT ... FOR UPDATE) agar dua pembeli tidak bisa "membeli stok yang sama".
//  4. idempotency_key mencegah pesanan ganda saat tombol diklik berulang atau request diulang (retry).
import crypto from 'node:crypto';
import { LIMITS, ORDER_STATUS_FLOW, ORDER_STATUS_LABELS } from '../config/constants.js';
import { withTransaction } from '../db/pool.js';
import { AppError, badRequest, conflict, notFound } from '../utils/errors.js';
import { businessDateString, businessDayEndExclusiveUtc, businessDayStartUtc } from '../utils/dates.js';
import { escapeLike } from '../utils/validation.js';
import { getAllSettings } from './settingsService.js';

// Tanpa huruf/angka yang mudah tertukar (I, O, 0, 1). 32 karakter => tidak ada bias saat modulo.
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateOrderNumber(now, offsetMinutes) {
  const datePart = businessDateString(now, offsetMinutes).slice(2).replaceAll('-', ''); // yymmdd
  let suffix = '';
  for (const byte of crypto.randomBytes(5)) suffix += ORDER_NUMBER_ALPHABET[byte % ORDER_NUMBER_ALPHABET.length];
  return `RB-${datePart}-${suffix}`;
}

const formatRupiah = (value) => `Rp${Number(value).toLocaleString('id-ID')}`;

/** Menggabungkan item dengan product_id yang sama (jumlahnya dijumlahkan). */
function mergeItems(items) {
  const merged = new Map();
  for (const { product_id: productId, quantity } of items) {
    merged.set(productId, (merged.get(productId) ?? 0) + quantity);
  }
  const result = [];
  for (const [productId, quantity] of [...merged.entries()].sort((a, b) => a[0] - b[0])) {
    if (quantity > LIMITS.maxQuantityPerItem) {
      throw new AppError(400, 'VALIDATION_ERROR', `Jumlah per menu maksimal ${LIMITS.maxQuantityPerItem}.`, {
        fields: { items: `Jumlah per menu maksimal ${LIMITS.maxQuantityPerItem}.` },
      });
    }
    result.push({ product_id: productId, quantity });
  }
  return result;
}

/** Sidik jari isi permintaan: dipakai agar idempotency key tidak bisa dipakai ulang untuk isi berbeda. */
function fingerprintRequest(input, items) {
  const canonical = JSON.stringify({
    items,
    name: input.customer_name,
    phone: input.customer_phone,
    fulfillment: input.fulfillment_method,
    address: input.fulfillment_method === 'delivery' ? input.delivery_address : null,
    notes: input.customer_notes || null,
    payment: input.payment_method,
    total: input.expected_total,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Membaca pesanan
// ---------------------------------------------------------------------------------------------

function mapOrderRow(row) {
  return {
    id: row.id,
    order_number: row.order_number,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    delivery_address: row.delivery_address,
    fulfillment_method: row.fulfillment_method,
    customer_notes: row.customer_notes,
    subtotal: row.subtotal,
    delivery_fee: row.delivery_fee,
    discount: row.discount,
    total: row.total,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    paid_at: row.paid_at ?? null,
    payment_expires_at: row.payment_expires_at ?? null,
    order_status: row.order_status,
    cancel_reason: row.cancel_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadItems(db, orderId) {
  const [rows] = await db.execute(
    `SELECT product_id, product_name_snapshot AS name, unit_price_snapshot AS unit_price, quantity, line_total
       FROM order_items WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  return rows;
}

/** Tampilan pesanan untuk pelanggan (tanpa ID internal & data admin). */
export async function getCustomerOrderView(db, orderId) {
  const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (rows.length === 0) throw notFound('Pesanan tidak ditemukan.');
  const { id, cancel_reason: _cancelReason, updated_at: _updatedAt, ...order } = mapOrderRow(rows[0]);
  return { ...order, items: await loadItems(db, id) };
}

/** Detail lengkap untuk admin, termasuk riwayat perubahan. */
export async function getAdminOrderDetail(db, orderId) {
  const [rows] = await db.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (rows.length === 0) throw notFound('Pesanan tidak ditemukan.');
  const [events] = await db.execute(
    `SELECT e.id, e.event_type, e.from_value, e.to_value, e.note, e.created_at, u.username AS admin_username
       FROM order_events e LEFT JOIN admin_users u ON u.id = e.admin_user_id
      WHERE e.order_id = ? ORDER BY e.id`,
    [orderId],
  );
  return { ...mapOrderRow(rows[0]), items: await loadItems(db, orderId), events, payments: await loadAdminPayments(db, orderId) };
}

/** Riwayat percobaan pembayaran (gateway) untuk admin: referensi transaksi, status, waktu, dan catatan tindak lanjut. */
async function loadAdminPayments(db, orderId) {
  const [payments] = await db.execute(
    `SELECT id, provider, method, provider_order_id, provider_transaction_id, amount, status, provider_status,
            expires_at, paid_at, last_checked_at, failure_reason, review_note, created_at
       FROM payments WHERE order_id = ? ORDER BY id`,
    [orderId],
  );
  if (payments.length === 0) return [];
  const [notifications] = await db.query(
    `SELECT payment_id, transaction_status, outcome, received_at FROM payment_notifications
      WHERE payment_id IN (?) ORDER BY id`,
    [payments.map((payment) => payment.id)],
  );
  return payments.map((payment) => ({
    ...payment,
    notifications: notifications.filter((item) => item.payment_id === payment.id).slice(-10),
  }));
}

// ---------------------------------------------------------------------------------------------
// Membuat pesanan (pelanggan)
// ---------------------------------------------------------------------------------------------

async function findOrderIdByKey(db, idempotencyKey) {
  const [rows] = await db.execute('SELECT id, request_hash, public_token FROM orders WHERE idempotency_key = ?', [idempotencyKey]);
  return rows[0] ?? null;
}

async function replayExistingOrder(db, existing, requestHash) {
  if (existing.request_hash !== requestHash) {
    throw new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'Permintaan ini berbeda dari pesanan sebelumnya. Muat ulang halaman lalu coba lagi.',
    );
  }
  return {
    order: await getCustomerOrderView(db, existing.id),
    replayed: true,
    orderId: existing.id,
    trackingToken: existing.public_token,
  };
}

/**
 * Membuat pesanan baru.
 * @param {object} input data yang SUDAH divalidasi oleh createOrderSchema
 * @param {{paymentProvider?: object|null}} [options] paymentProvider diperlukan untuk metode QRIS
 * @returns {{order: object, replayed: boolean, orderId: number, trackingToken: string|null}}
 *          replayed=true jika pesanan yang sama sudah pernah dibuat
 */
export async function createOrder(pool, config, input, { paymentProvider = null } = {}) {
  const settings = await getAllSettings(pool);

  if (!settings.accepting_orders) {
    throw conflict(
      'ORDERS_CLOSED',
      'Pemesanan online sedang ditutup. Silakan coba lagi nanti atau hubungi kami.',
    );
  }
  if (input.payment_method === 'cod' && !settings.payment_cod_enabled) {
    throw badRequest('Metode bayar di tempat sedang tidak tersedia.', {
      fields: { payment_method: 'Metode bayar di tempat sedang tidak tersedia.' },
    });
  }
  if (input.payment_method === 'bank_transfer' && !settings.payment_transfer_enabled) {
    throw badRequest('Metode transfer manual sedang tidak tersedia.', {
      fields: { payment_method: 'Metode transfer manual sedang tidak tersedia.' },
    });
  }
  if (input.payment_method === 'qris' && (!paymentProvider || !settings.payment_qris_enabled)) {
    throw badRequest('Pembayaran QRIS sedang tidak tersedia. Pilih metode pembayaran lain.', {
      fields: { payment_method: 'Pembayaran QRIS sedang tidak tersedia.' },
    });
  }
  if (input.fulfillment_method === 'delivery' && !settings.delivery_enabled) {
    throw badRequest('Layanan pengantaran belum tersedia. Silakan pilih ambil sendiri.', {
      fields: { fulfillment_method: 'Layanan pengantaran belum tersedia.' },
    });
  }

  const items = mergeItems(input.items);
  const requestHash = fingerprintRequest(input, items);

  // Jika key ini sudah pernah dipakai, kembalikan pesanan yang sama (bukan membuat baru).
  const existing = await findOrderIdByKey(pool, input.idempotency_key);
  if (existing) return replayExistingOrder(pool, existing, requestHash);

  // Token acak untuk halaman lacak pesanan (256 bit). Hanya dikirim ke pembuat pesanan.
  const publicToken = crypto.randomBytes(32).toString('base64url');
  const isQris = input.payment_method === 'qris';

  try {
    const orderId = await withTransaction(pool, async (connection) => {
      // 1) Kunci baris produk (urut berdasarkan id agar tidak terjadi deadlock antar transaksi).
      const [productRows] = await connection.query(
        `SELECT id, name, price, stock, track_stock, is_available, deleted_at
           FROM products WHERE id IN (?) ORDER BY id FOR UPDATE`,
        [items.map((item) => item.product_id)],
      );
      const productsById = new Map(productRows.map((row) => [row.id, row]));

      // 2) Periksa setiap item; kumpulkan SEMUA masalah agar pelanggan bisa memperbaikinya sekaligus.
      const problems = [];
      const lines = [];
      for (const { product_id: productId, quantity } of items) {
        const product = productsById.get(productId);
        if (!product || product.deleted_at) {
          problems.push({ product_id: productId, code: 'NOT_FOUND', name: product?.name ?? null, requested: quantity, available: 0, message: 'Menu ini sudah tidak tersedia.' });
        } else if (!product.is_available) {
          problems.push({ product_id: productId, code: 'UNAVAILABLE', name: product.name, requested: quantity, available: 0, message: `${product.name} sedang tidak tersedia.` });
        } else if (product.track_stock && product.stock <= 0) {
          problems.push({ product_id: productId, code: 'OUT_OF_STOCK', name: product.name, requested: quantity, available: 0, message: `${product.name} sudah habis.` });
        } else if (product.track_stock && quantity > product.stock) {
          problems.push({ product_id: productId, code: 'INSUFFICIENT_STOCK', name: product.name, requested: quantity, available: product.stock, message: `Stok ${product.name} tinggal ${product.stock}.` });
        } else {
          lines.push({
            product_id: product.id,
            name: product.name,
            unit_price: product.price,
            quantity,
            line_total: product.price * quantity,
            // Hanya produk yang stoknya dihitung yang dikurangi (dan nanti dikembalikan jika dibatalkan).
            deduct_stock: Boolean(product.track_stock),
          });
        }
      }
      if (problems.length > 0) {
        throw conflict('CART_INVALID', 'Beberapa menu di keranjang tidak dapat dipesan.', { problems });
      }

      // 3) Hitung ulang SEMUA angka dari data database.
      const subtotal = lines.reduce((sum, line) => sum + line.line_total, 0);
      const deliveryFee = input.fulfillment_method === 'delivery' ? settings.delivery_fee : 0;
      const discount = 0; // Belum ada fitur promo. Diskon tidak pernah dipercaya dari browser.
      const total = subtotal + deliveryFee - discount;

      if (subtotal < settings.min_order_amount) {
        throw conflict(
          'MIN_ORDER_NOT_MET',
          `Minimum pemesanan ${formatRupiah(settings.min_order_amount)}. Subtotal Anda ${formatRupiah(subtotal)}.`,
          { min_order_amount: settings.min_order_amount, subtotal },
        );
      }
      if (total !== input.expected_total) {
        throw conflict(
          'PRICE_CHANGED',
          `Harga atau ongkos kirim berubah. Total terbaru ${formatRupiah(total)}. Periksa kembali pesanan Anda.`,
          { subtotal, delivery_fee: deliveryFee, total, items: lines },
        );
      }

      // 4) Simpan pesanan (ulangi dengan nomor baru jika kebetulan bentrok).
      const now = new Date();
      // QRIS: batas waktu bayar. Lewat batas dan belum lunas => pesanan dibatalkan & stok dikembalikan.
      const paymentExpiresAt = isQris ? new Date(now.getTime() + config.payment.qrisExpiryMinutes * 60_000) : null;
      let newOrderId = null;
      for (let attempt = 0; attempt < 5 && newOrderId === null; attempt += 1) {
        try {
          const [result] = await connection.execute(
            `INSERT INTO orders
               (order_number, idempotency_key, request_hash, public_token, customer_name, customer_phone, delivery_address,
                fulfillment_method, customer_notes, subtotal, delivery_fee, discount, total, payment_method,
                payment_status, payment_expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              generateOrderNumber(now, config.businessUtcOffsetMinutes),
              input.idempotency_key,
              requestHash,
              publicToken,
              input.customer_name,
              input.customer_phone,
              input.fulfillment_method === 'delivery' ? input.delivery_address : null,
              input.fulfillment_method,
              input.customer_notes || null,
              subtotal,
              deliveryFee,
              discount,
              total,
              input.payment_method,
              isQris ? 'pending' : 'unpaid',
              paymentExpiresAt,
            ],
          );
          newOrderId = result.insertId;
        } catch (error) {
          const isOrderNumberClash = error.code === 'ER_DUP_ENTRY' && String(error.sqlMessage).includes('uq_orders_order_number');
          if (!isOrderNumberClash) throw error;
        }
      }
      if (newOrderId === null) throw new Error('Tidak berhasil membuat nomor pesanan yang unik.');

      await connection.query(
        `INSERT INTO order_items
           (order_id, product_id, product_name_snapshot, unit_price_snapshot, quantity, line_total, stock_deducted)
         VALUES ?`,
        [
          lines.map((line) => [
            newOrderId,
            line.product_id,
            line.name,
            line.unit_price,
            line.quantity,
            line.line_total,
            line.deduct_stock ? 1 : 0,
          ]),
        ],
      );

      // 5) Kurangi stok. Syarat "stock >= qty" adalah sabuk pengaman kedua.
      for (const line of lines.filter((candidate) => candidate.deduct_stock)) {
        const [update] = await connection.execute('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [
          line.quantity,
          line.product_id,
          line.quantity,
        ]);
        if (update.affectedRows !== 1) {
          throw conflict('CART_INVALID', `Stok ${line.name} tidak mencukupi.`, {
            problems: [{ product_id: line.product_id, code: 'INSUFFICIENT_STOCK', name: line.name, requested: line.quantity }],
          });
        }
      }

      await connection.execute(
        "INSERT INTO order_events (order_id, event_type, from_value, to_value) VALUES (?, 'created', NULL, 'pending')",
        [newOrderId],
      );
      if (isQris) {
        await connection.execute(
          "INSERT INTO order_events (order_id, event_type, from_value, to_value, note) VALUES (?, 'payment', NULL, 'pending', 'Menunggu pembayaran QRIS')",
          [newOrderId],
        );
      }
      return newOrderId;
    });

    return { order: await getCustomerOrderView(pool, orderId), replayed: false, orderId, trackingToken: publicToken };
  } catch (error) {
    // Dua request dengan key sama masuk bersamaan (klik ganda / retry otomatis):
    // salah satunya menang dan membuat pesanan. Request yang kalah TIDAK boleh menampilkan error
    // (mis. "stok habis" karena stoknya baru saja diambil oleh request yang menang), melainkan
    // mengembalikan pesanan yang sama. Maka untuk error bisnis maupun UNIQUE KEY, cek dulu apakah
    // pesanan dengan key ini sudah ada.
    const isDuplicateKey =
      error.code === 'ER_DUP_ENTRY' && String(error.sqlMessage).includes('uq_orders_idempotency_key');
    if (isDuplicateKey || (error instanceof AppError && error.status === 409)) {
      const winner = await findOrderIdByKey(pool, input.idempotency_key);
      if (winner) return replayExistingOrder(pool, winner, requestHash);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Pengelolaan pesanan (admin)
// ---------------------------------------------------------------------------------------------

/** Status hanya boleh maju (boleh melompat) atau dibatalkan. Status akhir tidak bisa diubah. */
export function isValidStatusTransition(from, to) {
  if (from === to) return false;
  if (from === 'completed' || from === 'cancelled') return false;
  if (to === 'cancelled') return true;
  return ORDER_STATUS_FLOW.indexOf(to) > ORDER_STATUS_FLOW.indexOf(from);
}

// Perubahan status pembayaran MANUAL oleh admin.
//  - Tunai / transfer manual: admin yang memverifikasi uangnya (unpaid -> paid -> refunded).
//  - QRIS: status pembayaran HANYA diubah oleh sistem (webhook / cek status ke gateway). Admin tidak boleh
//    menandai "lunas" secara manual; satu-satunya perubahan manual adalah mencatat "Dikembalikan"
//    setelah refund dilakukan di dashboard gateway.
const MANUAL_PAYMENT_TRANSITIONS = {
  unpaid: ['paid'],
  paid: ['refunded', 'unpaid'],
  refunded: [],
};
const QRIS_MANUAL_PAYMENT_TRANSITIONS = {
  paid: ['refunded'],
};

/**
 * Membatalkan pesanan di dalam transaksi yang sudah berjalan (baris pesanan HARUS sudah dikunci FOR UPDATE).
 * Satu-satunya tempat stok dikembalikan, sehingga stok tidak mungkin dikembalikan dua kali:
 * pemanggil wajib memastikan status pesanan belum 'cancelled'/'completed' sebelum memanggil.
 *
 * @param {object} order baris pesanan terkunci: {id, payment_method, payment_status}
 * @param {{reason?: string|null, note?: string|null, adminUserId?: number|null, releasePaymentAs?: 'cancelled'|'expired'}} options
 * @returns {Promise<string[]>} provider_order_id pembayaran QRIS yang dilepas (untuk ditutup di gateway setelah commit)
 */
export async function cancelOrderInTx(connection, order, { reason = null, note = null, adminUserId = null, releasePaymentAs = 'cancelled' } = {}) {
  // 1) Kembalikan stok sekali saja (hanya baris yang memang pernah dikurangi).
  const [items] = await connection.execute(
    'SELECT product_id, quantity FROM order_items WHERE order_id = ? AND stock_deducted = 1 ORDER BY product_id',
    [order.id],
  );
  for (const item of items) {
    await connection.execute('UPDATE products SET stock = stock + ? WHERE id = ?', [item.quantity, item.product_id]);
  }

  // 2) Lepaskan pembayaran QRIS yang masih menunggu (transaksi di gateway ditutup setelah commit).
  const [pendingPayments] = await connection.execute(
    "SELECT id, provider_order_id FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY id FOR UPDATE",
    [order.id],
  );
  if (pendingPayments.length > 0) {
    await connection.execute(
      "UPDATE payments SET status = ?, failure_reason = ? WHERE order_id = ? AND status = 'pending'",
      [releasePaymentAs, releasePaymentAs === 'expired' ? 'Batas waktu pembayaran habis' : 'Pesanan dibatalkan', order.id],
    );
  }

  // 3) Status pesanan. Status pembayaran "pending" ikut berubah; "paid" tetap "paid" (uang sudah masuk, perlu refund).
  let paymentStatus = order.payment_status;
  if (order.payment_status === 'pending') paymentStatus = releasePaymentAs;
  await connection.execute(
    "UPDATE orders SET order_status = 'cancelled', cancel_reason = ?, payment_status = ? WHERE id = ?",
    [reason, paymentStatus, order.id],
  );
  await connection.execute(
    "INSERT INTO order_events (order_id, event_type, from_value, to_value, note, admin_user_id) VALUES (?, 'status', ?, 'cancelled', ?, ?)",
    [order.id, order.order_status, note ?? reason, adminUserId],
  );
  if (paymentStatus !== order.payment_status) {
    await connection.execute(
      "INSERT INTO order_events (order_id, event_type, from_value, to_value, note, admin_user_id) VALUES (?, 'payment', ?, ?, ?, ?)",
      [order.id, order.payment_status, paymentStatus, reason, adminUserId],
    );
  }
  if (order.payment_status === 'paid') {
    // Pesanan yang sudah dibayar lalu dibatalkan: tandai agar admin tidak lupa mengembalikan dana.
    await connection.execute(
      "UPDATE payments SET review_note = 'Pesanan dibatalkan setelah dibayar: kembalikan dana lalu tandai Dikembalikan' WHERE order_id = ? AND status = 'paid' AND review_note IS NULL",
      [order.id],
    );
  }
  return pendingPayments.map((payment) => payment.provider_order_id);
}

/**
 * @param {{afterCommit?: (providerOrderIds: string[]) => Promise<void>|void}} [hooks]
 *        afterCommit dipanggil setelah transaksi selesai dengan daftar transaksi gateway yang perlu ditutup.
 */
export async function updateOrderStatus(pool, orderId, { status, note }, adminUser, { afterCommit } = {}) {
  const released = await withTransaction(pool, async (connection) => {
    // Kunci baris pesanan: dua admin yang membatalkan bersamaan tidak akan mengembalikan stok dua kali.
    const [rows] = await connection.execute(
      'SELECT id, order_status, payment_method, payment_status FROM orders WHERE id = ? FOR UPDATE',
      [orderId],
    );
    if (rows.length === 0) throw notFound('Pesanan tidak ditemukan.');
    const order = rows[0];
    const from = order.order_status;

    if (!isValidStatusTransition(from, status)) {
      throw conflict(
        'INVALID_TRANSITION',
        `Status tidak bisa diubah dari "${ORDER_STATUS_LABELS[from]}" ke "${ORDER_STATUS_LABELS[status]}".`,
      );
    }
    // Pesanan QRIS baru boleh diproses setelah pembayarannya terverifikasi oleh gateway.
    if (order.payment_method === 'qris' && status !== 'cancelled' && order.payment_status !== 'paid') {
      throw conflict(
        'PAYMENT_REQUIRED',
        'Pesanan QRIS baru bisa diproses setelah pembayarannya terverifikasi (status "Lunas").',
      );
    }

    if (status === 'cancelled') {
      return cancelOrderInTx(connection, order, { reason: note || null, note: note || null, adminUserId: adminUser.id });
    }

    await connection.execute('UPDATE orders SET order_status = ?, cancel_reason = NULL WHERE id = ?', [status, orderId]);
    await connection.execute(
      "INSERT INTO order_events (order_id, event_type, from_value, to_value, note, admin_user_id) VALUES (?, 'status', ?, ?, ?, ?)",
      [orderId, from, status, note || null, adminUser.id],
    );
    return [];
  });
  if (released.length > 0 && afterCommit) await afterCommit(released);
  return getAdminOrderDetail(pool, orderId);
}

export async function updatePaymentStatus(pool, orderId, { payment_status: paymentStatus, note }, adminUser) {
  await withTransaction(pool, async (connection) => {
    const [rows] = await connection.execute(
      'SELECT id, order_status, payment_method, payment_status FROM orders WHERE id = ? FOR UPDATE',
      [orderId],
    );
    if (rows.length === 0) throw notFound('Pesanan tidak ditemukan.');
    const { order_status: orderStatus, payment_method: method, payment_status: from } = rows[0];
    const isQris = method === 'qris';

    const allowed = (isQris ? QRIS_MANUAL_PAYMENT_TRANSITIONS : MANUAL_PAYMENT_TRANSITIONS)[from] ?? [];
    if (!allowed.includes(paymentStatus)) {
      if (isQris) {
        throw conflict(
          'QRIS_MANUAL_NOT_ALLOWED',
          'Status pembayaran QRIS diatur otomatis oleh sistem pembayaran dan tidak bisa diubah manual. ' +
            'Yang bisa dicatat manual hanya "Dikembalikan" setelah refund dilakukan di dashboard gateway.',
        );
      }
      throw conflict('INVALID_TRANSITION', 'Perubahan status pembayaran ini tidak diizinkan.');
    }
    if (paymentStatus === 'paid' && orderStatus === 'cancelled') {
      throw conflict('INVALID_TRANSITION', 'Pesanan yang dibatalkan tidak bisa ditandai lunas.');
    }

    // paid_at: waktu pembayaran terverifikasi. Kembali ke "belum dibayar" menghapusnya; refund tetap menyimpannya.
    const paidAt = paymentStatus === 'paid' ? new Date() : paymentStatus === 'unpaid' ? null : undefined;
    if (paidAt === undefined) {
      await connection.execute('UPDATE orders SET payment_status = ? WHERE id = ?', [paymentStatus, orderId]);
    } else {
      await connection.execute('UPDATE orders SET payment_status = ?, paid_at = ? WHERE id = ?', [paymentStatus, paidAt, orderId]);
    }
    if (isQris && paymentStatus === 'refunded') {
      await connection.execute(
        "UPDATE payments SET status = 'refunded', review_note = NULL WHERE order_id = ? AND status = 'paid'",
        [orderId],
      );
    }
    await connection.execute(
      "INSERT INTO order_events (order_id, event_type, from_value, to_value, note, admin_user_id) VALUES (?, 'payment', ?, ?, ?, ?)",
      [orderId, from, paymentStatus, note || null, adminUser.id],
    );
  });
  return getAdminOrderDetail(pool, orderId);
}

/** Daftar pesanan dengan pencarian, filter status/tanggal, dan paginasi. */
export async function listOrders(db, config, query) {
  const conditions = [];
  const params = [];

  if (query.status) {
    conditions.push('o.order_status = ?');
    params.push(query.status);
  }
  if (query.payment_status) {
    conditions.push('o.payment_status = ?');
    params.push(query.payment_status);
  }
  if (query.q) {
    const likeText = `%${escapeLike(query.q)}%`;
    const clauses = ["o.order_number LIKE ? ESCAPE '\\\\'", "o.customer_name LIKE ? ESCAPE '\\\\'", "o.customer_phone LIKE ? ESCAPE '\\\\'"];
    params.push(likeText, likeText);
    // Pelanggan menulis 0812..., database menyimpan 62812... — cari keduanya.
    let phoneLike = likeText;
    if (/^[0-9+\s-]+$/.test(query.q)) {
      const digits = query.q.replace(/\D/g, '');
      phoneLike = `%${digits.startsWith('0') ? `62${digits.slice(1)}` : digits}%`;
    }
    params.push(phoneLike);
    conditions.push(`(${clauses.join(' OR ')})`);
  }
  if (query.from) {
    conditions.push('o.created_at >= ?');
    params.push(businessDayStartUtc(query.from, config.businessUtcOffsetMinutes, 'Tanggal awal'));
  }
  if (query.to) {
    conditions.push('o.created_at < ?');
    params.push(businessDayEndExclusiveUtc(query.to, config.businessUtcOffsetMinutes, 'Tanggal akhir'));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM orders o ${where}`, params);

  const offset = (query.page - 1) * query.page_size;
  const [rows] = await db.query(
    `SELECT o.id, o.order_number, o.customer_name, o.customer_phone, o.fulfillment_method, o.total,
            o.payment_method, o.payment_status, o.order_status, o.paid_at, o.payment_expires_at, o.created_at,
            (SELECT COALESCE(SUM(quantity), 0) FROM order_items i WHERE i.order_id = o.id) AS item_count,
            (SELECT p.provider_transaction_id FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS gateway_reference,
            (SELECT p.review_note IS NOT NULL FROM payments p WHERE p.order_id = o.id ORDER BY p.id DESC LIMIT 1) AS needs_review
       FROM orders o ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ? OFFSET ?`,
    [...params, query.page_size, offset],
  );

  const items = rows.map((row) => ({ ...row, needs_review: Boolean(row.needs_review) }));
  return { items, page: query.page, page_size: query.page_size, total };
}
