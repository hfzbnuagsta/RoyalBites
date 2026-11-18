// Halaman "Lacak Pesanan" untuk pelanggan.
//
// Akses dilindungi salah satu dari:
//   (a) token acak 256 bit (dari tautan yang hanya diterima pembuat pesanan; ditaruh di URL fragment
//       sehingga tidak ikut tercatat di log server/referrer), atau
//   (b) nomor pesanan + nomor WhatsApp pemesan (dibatasi rate limit karena bisa ditebak).
// Pesan "tidak ditemukan" SAMA untuk semua kegagalan agar nomor pesanan/token tidak bisa ditebak lewat respons.
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS } from '../config/constants.js';
import { notFound } from '../utils/errors.js';

const NOT_FOUND_MESSAGE = 'Pesanan tidak ditemukan. Periksa kembali tautan, nomor pesanan, dan nomor WhatsApp Anda.';

/** @param {{token?: string, order_number?: string, phone?: string}} lookup hasil trackOrderSchema */
export async function resolveOrder(db, lookup) {
  const [rows] = lookup.token
    ? await db.execute('SELECT * FROM orders WHERE public_token = ?', [lookup.token])
    : await db.execute('SELECT * FROM orders WHERE order_number = ? AND customer_phone = ?', [lookup.order_number, lookup.phone]);
  if (rows.length === 0) throw notFound(NOT_FOUND_MESSAGE);
  return rows[0];
}

export async function latestPayment(db, orderId) {
  const [rows] = await db.execute('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  return rows[0] ?? null;
}

/** Tampilan lacak: hanya data milik pelanggan itu sendiri (tanpa ID internal, catatan admin, atau data gateway mentah). */
export async function buildTrackingView(db, paymentService, order) {
  const [items] = await db.execute(
    `SELECT product_name_snapshot AS name, unit_price_snapshot AS unit_price, quantity, line_total
       FROM order_items WHERE order_id = ? ORDER BY id`,
    [order.id],
  );
  const [events] = await db.execute(
    "SELECT event_type, to_value, created_at FROM order_events WHERE order_id = ? ORDER BY id",
    [order.id],
  );
  const payment = order.payment_method === 'qris' ? paymentService.viewOf(await latestPayment(db, order.id), order) : null;

  return {
    order: {
      order_number: order.order_number,
      customer_name: order.customer_name,
      fulfillment_method: order.fulfillment_method,
      delivery_address: order.delivery_address,
      subtotal: order.subtotal,
      delivery_fee: order.delivery_fee,
      discount: order.discount,
      total: order.total,
      payment_method: order.payment_method,
      payment_status: order.payment_status,
      order_status: order.order_status,
      cancel_reason: order.cancel_reason,
      paid_at: order.paid_at,
      created_at: order.created_at,
      items,
    },
    payment,
    labels: {
      order_status: ORDER_STATUS_LABELS[order.order_status],
      payment_status: PAYMENT_STATUS_LABELS[order.payment_status],
    },
    // Riwayat singkat untuk pelanggan (tanpa catatan internal & nama admin).
    timeline: events.map((event) => ({ type: event.event_type, to: event.to_value, at: event.created_at })),
  };
}
