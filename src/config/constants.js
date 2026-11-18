// Konstanta bisnis yang dipakai bersama oleh backend (validasi) dan dikirim ke frontend lewat API.
// Menambah kategori baru = tambahkan satu baris di CATEGORIES (lalu restart server).

export const CATEGORIES = [
  { value: 'makanan', label: 'Royale Signatures' },
  { value: 'minuman', label: 'Royale Drinks' },
  { value: 'jajanan', label: 'Royale Snacks' },
  { value: 'paket', label: 'Royale Combos' },
];
export const CATEGORY_VALUES = CATEGORIES.map((category) => category.value);

export const FULFILLMENT_METHODS = {
  pickup: 'Ambil Sendiri',
  delivery: 'Diantar',
};

export const PAYMENT_METHODS = {
  cod: 'Bayar di Tempat (Tunai)',
  bank_transfer: 'Transfer Manual',
  qris: 'QRIS (Scan & Bayar)',
};

// Urutan status pesanan. Status hanya boleh maju (boleh melompat), atau dibatalkan.
export const ORDER_STATUS_FLOW = ['pending', 'confirmed', 'preparing', 'ready', 'completed'];
export const ORDER_STATUSES = [...ORDER_STATUS_FLOW, 'cancelled'];
export const ORDER_STATUS_LABELS = {
  pending: 'Menunggu Konfirmasi',
  confirmed: 'Dikonfirmasi',
  preparing: 'Sedang Disiapkan',
  ready: 'Siap Diambil/Diantar',
  completed: 'Selesai',
  cancelled: 'Dibatalkan',
};

// Status pembayaran DIPISAH dari status pesanan.
//   unpaid  = belum dibayar (tunai / transfer manual)      pending = menunggu pembayaran QRIS
//   paid    = lunas (QRIS: dikonfirmasi gateway)             failed / expired / cancelled = percobaan bayar tidak berhasil
//   refunded = dikembalikan
export const PAYMENT_STATUSES = ['unpaid', 'pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded'];
export const PAYMENT_STATUS_LABELS = {
  unpaid: 'Belum Dibayar',
  pending: 'Menunggu Pembayaran',
  paid: 'Lunas (Terverifikasi)',
  failed: 'Pembayaran Gagal',
  expired: 'Pembayaran Kedaluwarsa',
  cancelled: 'Pembayaran Dibatalkan',
  refunded: 'Dikembalikan',
};
// Status pembayaran QRIS yang belum lunas dan belum berakhir.
export const PAYMENT_STATUSES_AWAITING = ['unpaid', 'pending'];

// Batas keamanan/kewajaran.
export const LIMITS = {
  maxItemsPerOrder: 30,
  maxQuantityPerItem: 99,
  maxPrice: 10_000_000,
  maxStock: 100_000,
};

// Gambar produk hanya boleh berasal dari dua folder ini.
export const IMAGE_PATH_PATTERN = /^\/(uploads|images\/products)\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.(jpe?g|png|webp)$/;
