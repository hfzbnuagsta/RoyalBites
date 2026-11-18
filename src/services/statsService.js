// Ringkasan dashboard. Angka-angka sengaja DIPISAHKAN agar tidak menyesatkan:
//   - order_value     : nilai semua pesanan yang tidak dibatalkan (BELUM tentu sudah dibayar)
//   - verified_paid   : pesanan tidak dibatalkan yang pembayarannya sudah diverifikasi admin ("paid")
//   - unpaid_value    : pesanan tidak dibatalkan yang belum dibayar (termasuk QRIS yang masih menunggu)
//   - cancelled_value : nilai pesanan yang dibatalkan (bukan pendapatan)
//   - refunded_value  : pembayaran yang sudah dikembalikan
import { businessRangeToUtc, defaultReportRange } from '../utils/dates.js';
import { getAllSettings } from './settingsService.js';

// Pesanan QRIS yang belum lunas BUKAN penjualan: pembayarannya masih menunggu / gagal / kedaluwarsa.
const VALID_SALE = "o.order_status <> 'cancelled' AND NOT (o.payment_method = 'qris' AND o.payment_status <> 'paid')";

export async function getSummary(db, config, { from, to } = {}) {
  const offset = config.businessUtcOffsetMinutes;
  const range = from && to ? { from, to } : defaultReportRange(new Date(), offset);
  const { start, endExclusive } = businessRangeToUtc(range.from, range.to, offset);

  const [[totals]] = await db.query(
    `SELECT
        COUNT(*)                                                                                   AS total_orders,
        COALESCE(SUM(order_status <> 'cancelled'), 0)                                              AS active_orders,
        COALESCE(SUM(order_status = 'cancelled'), 0)                                               AS cancelled_orders,
        COALESCE(SUM(order_status = 'completed'), 0)                                               AS completed_orders,
        COALESCE(SUM(CASE WHEN order_status <> 'cancelled' THEN total END), 0)                     AS order_value,
        COALESCE(SUM(CASE WHEN order_status <> 'cancelled' AND payment_status = 'paid' THEN total END), 0)   AS verified_paid,
        COALESCE(SUM(CASE WHEN order_status <> 'cancelled' AND payment_status IN ('unpaid','pending','failed') THEN total END), 0) AS unpaid_value,
        COALESCE(SUM(order_status <> 'cancelled' AND payment_status = 'paid'), 0)                  AS paid_orders,
        COALESCE(SUM(CASE WHEN order_status = 'cancelled' THEN total END), 0)                      AS cancelled_value,
        COALESCE(SUM(CASE WHEN payment_status = 'refunded' THEN total END), 0)                     AS refunded_value
       FROM orders
      WHERE created_at >= ? AND created_at < ?`,
    [start, endExclusive],
  );

  // Antrian kerja saat ini — TIDAK tergantung filter tanggal (pesanan lama yang belum selesai tetap harus terlihat).
  const [[queue]] = await db.query(
    `SELECT
        COALESCE(SUM(order_status = 'pending'), 0)   AS pending,
        COALESCE(SUM(order_status = 'confirmed'), 0) AS confirmed,
        COALESCE(SUM(order_status = 'preparing'), 0) AS preparing,
        COALESCE(SUM(order_status = 'ready'), 0)     AS ready
       FROM orders`,
  );

  const [topProducts] = await db.query(
    `SELECT i.product_id, MAX(i.product_name_snapshot) AS name,
            SUM(i.quantity) AS quantity_sold, SUM(i.line_total) AS sales_value,
            COALESCE(SUM(CASE WHEN o.payment_status = 'paid' THEN i.line_total END), 0) AS paid_value
       FROM order_items i
       JOIN orders o ON o.id = i.order_id
      WHERE ${VALID_SALE} AND o.created_at >= ? AND o.created_at < ?
      GROUP BY i.product_id
      ORDER BY quantity_sold DESC, sales_value DESC
      LIMIT 5`,
    [start, endExclusive],
  );

  // Pengelompokan per hari memakai zona waktu bisnis (bukan UTC).
  const [daily] = await db.query(
    `SELECT DATE_FORMAT(DATE_ADD(created_at, INTERVAL ? MINUTE), '%Y-%m-%d') AS day,
            COUNT(*) AS orders,
            COALESCE(SUM(total), 0) AS order_value,
            COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total END), 0) AS paid_value
       FROM orders
      WHERE order_status <> 'cancelled' AND created_at >= ? AND created_at < ?
      GROUP BY day
      ORDER BY day`,
    [offset, start, endExclusive],
  );

  // Pendapatan terverifikasi per metode pembayaran (hanya pesanan lunas yang tidak dibatalkan).
  const [paymentBreakdown] = await db.query(
    `SELECT payment_method, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS value
       FROM orders
      WHERE order_status <> 'cancelled' AND payment_status = 'paid' AND created_at >= ? AND created_at < ?
      GROUP BY payment_method
      ORDER BY payment_method`,
    [start, endExclusive],
  );

  // Hal yang perlu perhatian admin (tidak tergantung rentang tanggal).
  const settings = await getAllSettings(db);
  const [[attention]] = await db.query(
    `SELECT
        (SELECT COUNT(*) FROM orders WHERE order_status = 'cancelled' AND payment_status = 'paid')
          AS paid_but_cancelled,
        (SELECT COUNT(*) FROM orders WHERE payment_method = 'qris' AND order_status = 'pending' AND payment_status = 'pending')
          AS awaiting_qris_payment,
        (SELECT COUNT(*) FROM payments WHERE review_note IS NOT NULL AND status <> 'refunded')
          AS payments_need_review`,
  );
  const [lowStock] = await db.query(
    `SELECT id, name, category, stock, is_available FROM products
      WHERE deleted_at IS NULL AND track_stock = 1 AND stock <= ?
      ORDER BY stock, name LIMIT 50`,
    [settings.low_stock_threshold],
  );

  return {
    range,
    totals,
    queue,
    top_products: topProducts,
    daily,
    payment_breakdown: paymentBreakdown,
    attention: { ...attention, low_stock_threshold: settings.low_stock_threshold, low_stock: lowStock },
    notes: {
      order_value: 'Nilai semua pesanan yang tidak dibatalkan. Belum berarti uangnya sudah diterima.',
      verified_paid:
        'Pendapatan terverifikasi: tunai/transfer yang ditandai "Lunas" oleh admin, dan QRIS yang dikonfirmasi gateway. ' +
        'Pesanan QRIS yang masih menunggu, gagal, atau kedaluwarsa TIDAK dihitung. Dikelompokkan menurut tanggal pesanan.',
      top_products: 'Pesanan QRIS yang belum lunas tidak ikut dihitung.',
    },
  };
}
