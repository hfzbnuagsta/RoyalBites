// Tautan WhatsApp untuk konfirmasi pesanan. Hanya berisi nomor pesanan & ringkasan (tanpa token rahasia).
// Membuka WhatsApp BUKAN pembayaran: status bayar hanya berubah oleh server.
import { formatRupiah } from "./format.js";

const PAYMENT_STATUS_TEXT = {
  unpaid: "belum dibayar",
  pending: "menunggu pembayaran",
  paid: "lunas",
  failed: "gagal",
  expired: "kedaluwarsa",
  cancelled: "dibatalkan",
  refunded: "dikembalikan",
};

/** @param config hasil GET /api/config  @param order data pesanan dari server  @returns {string|null} */
export function buildWhatsappLink(config, order) {
  const number = config?.business?.whatsapp_number;
  if (!number) return null; // nomor belum diisi pemilik -> tombol tidak ditampilkan
  const method = config.ordering.payment_methods.find((entry) => entry.value === order.payment_method);
  const status = PAYMENT_STATUS_TEXT[order.payment_status];
  const lines = [
    `Halo ${config.business.name}, saya ingin konfirmasi pesanan ${order.order_number}.`,
    "",
    `Nama: ${order.customer_name}`,
    "Pesanan:",
    ...order.items.map((item) => `- ${item.quantity}x ${item.name} (${formatRupiah(item.line_total)})`),
    `Total: ${formatRupiah(order.total)}`,
    order.fulfillment_method === "delivery" ? `Diantar ke: ${order.delivery_address}` : "Ambil sendiri di toko",
    `Pembayaran: ${method?.label ?? order.payment_method}${status ? ` (${status})` : ""}`,
  ];
  return `https://wa.me/${number}?text=${encodeURIComponent(lines.join("\n"))}`;
}
