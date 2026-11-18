// Kumpulan skema validasi request (zod). Dipakai oleh routes sebelum data menyentuh database.
import { z } from 'zod';
import {
  CATEGORY_VALUES,
  IMAGE_PATH_PATTERN,
  LIMITS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
} from './config/constants.js';
import { indonesianMobile, integer, text } from './utils/validation.js';

// ---------------------------------------------------------------- Produk (admin)
const imagePath = z
  .string()
  .regex(IMAGE_PATH_PATTERN, 'Path gambar tidak valid. Unggah gambar lewat dashboard.')
  .nullable();

const productFields = {
  name: text({ min: 2, max: 120, label: 'Nama produk' }),
  description: text({ max: 500, label: 'Deskripsi' }),
  price: integer({ min: 1, max: LIMITS.maxPrice, label: 'Harga' }),
  category: z.enum(CATEGORY_VALUES, { errorMap: () => ({ message: 'Kategori tidak valid.' }) }),
  stock: integer({ min: 0, max: LIMITS.maxStock, label: 'Stok' }),
  track_stock: z.boolean({ invalid_type_error: 'Hitung stok harus ya/tidak.' }),
  is_available: z.boolean({ invalid_type_error: 'Status ketersediaan harus ya/tidak.' }),
  image: imagePath,
};

export const createProductSchema = z.object({
  name: productFields.name,
  description: productFields.description.default(''),
  price: productFields.price,
  category: productFields.category,
  stock: productFields.stock.default(0),
  track_stock: productFields.track_stock.default(false),
  is_available: productFields.is_available.default(true),
  image: productFields.image.default(null),
});

export const updateProductSchema = z
  .object({
    name: productFields.name,
    description: productFields.description,
    price: productFields.price,
    category: productFields.category,
    stock: productFields.stock,
    track_stock: productFields.track_stock,
    is_available: productFields.is_available,
    image: productFields.image,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: 'Tidak ada data yang diubah.' });

// ---------------------------------------------------------------- Pesanan (pelanggan)
export const createOrderSchema = z
  .object({
    items: z
      .array(
        z.object({
          product_id: integer({ min: 1, max: 4_294_967_295, label: 'ID produk' }),
          quantity: integer({ min: 1, max: LIMITS.maxQuantityPerItem, label: 'Jumlah' }),
        }),
        { required_error: 'Keranjang kosong.', invalid_type_error: 'Daftar item tidak valid.' },
      )
      .min(1, 'Keranjang masih kosong.')
      .max(LIMITS.maxItemsPerOrder, `Maksimal ${LIMITS.maxItemsPerOrder} jenis menu per pesanan.`),
    customer_name: text({ min: 2, max: 100, label: 'Nama' }),
    customer_phone: indonesianMobile('Nomor WhatsApp'),
    fulfillment_method: z.enum(['pickup', 'delivery'], {
      errorMap: () => ({ message: 'Pilih metode pengambilan: ambil sendiri atau diantar.' }),
    }),
    delivery_address: text({ max: 300, label: 'Alamat pengantaran' }).nullish(),
    customer_notes: text({ max: 500, label: 'Catatan' }).nullish(),
    payment_method: z.enum(['cod', 'bank_transfer', 'qris'], {
      errorMap: () => ({ message: 'Pilih metode pembayaran.' }),
    }),
    // Total yang dilihat pelanggan di layar; server memakainya hanya untuk mendeteksi harga berubah.
    expected_total: integer({ min: 0, max: 1_000_000_000, label: 'Total' }),
    idempotency_key: z.string({ required_error: 'Kunci permintaan hilang.' }).uuid('Kunci permintaan tidak valid.'),
  })
  .superRefine((order, ctx) => {
    if (order.fulfillment_method === 'delivery' && (order.delivery_address ?? '').length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delivery_address'],
        message: 'Alamat pengantaran wajib diisi lengkap (minimal 10 karakter).',
      });
    }
  });

// ---------------------------------------------------------------- Formulir kontak
export const contactMessageSchema = z.object({
  name: text({ min: 2, max: 100, label: 'Nama' }),
  email: z
    .union([z.literal(''), z.string().trim().toLowerCase().email('Format email tidak valid.').max(150)])
    .optional(),
  phone: z.union([z.literal(''), indonesianMobile('Nomor telepon')]).optional(),
  message: text({ min: 5, max: 1000, label: 'Pesan' }),
  // Honeypot: kolom tersembunyi yang tidak diisi manusia. Jika terisi, kemungkinan bot.
  website: z.string().max(0, 'Pesan tidak dapat dikirim.').optional(),
});

// ---------------------------------------------------------------- Admin
export const loginSchema = z.object({
  username: text({ min: 1, max: 50, label: 'Username' }),
  // Password tidak di-trim/diubah sama sekali.
  password: z.string({ required_error: 'Password wajib diisi.' }).min(1, 'Password wajib diisi.').max(200),
});

export const changePasswordSchema = z.object({
  current_password: z.string({ required_error: 'Password saat ini wajib diisi.' }).min(1).max(200),
  new_password: z
    .string({ required_error: 'Password baru wajib diisi.' })
    .min(12, 'Password baru minimal 12 karakter.')
    .max(72, 'Password baru maksimal 72 karakter.'),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES, { errorMap: () => ({ message: 'Status pesanan tidak valid.' }) }),
  note: text({ max: 255, label: 'Catatan' }).nullish(),
});

export const updatePaymentStatusSchema = z.object({
  payment_status: z.enum(PAYMENT_STATUSES, { errorMap: () => ({ message: 'Status pembayaran tidak valid.' }) }),
  note: text({ max: 255, label: 'Catatan' }).nullish(),
});

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD.');

export const orderListQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  payment_status: z.enum(PAYMENT_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const reportQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

// ---------------------------------------------------------------- Lacak pesanan (pelanggan)
// Akses lacak pesanan: (a) token acak 256 bit dari tautan, atau (b) nomor pesanan + nomor WhatsApp pemesan.
export const trackOrderSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Tautan pelacakan tidak valid.').optional(),
    order_number: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^RB-\d{6}-[A-Z0-9]{5}$/, 'Nomor pesanan tidak valid. Contoh: RB-261009-K7P2M')
      .optional(),
    phone: indonesianMobile('Nomor WhatsApp').optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.token && !(value.order_number && value.phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['order_number'],
        message: 'Isi nomor pesanan dan nomor WhatsApp, atau buka dari tautan pelacakan.',
      });
    }
  });
