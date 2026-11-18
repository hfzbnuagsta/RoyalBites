// Definisi pengaturan bisnis yang bisa diubah pemilik lewat dashboard (tanpa mengedit kode).
// Nilai awal di sini sengaja NETRAL: informasi bisnis yang belum diketahui dibiarkan kosong,
// bukan dikarang. Pemilik mengisinya di dashboard admin -> Pengaturan.
import { z } from 'zod';
import { IMAGE_PATH_PATTERN } from './constants.js';
import { indonesianMobile, integer, text } from '../utils/validation.js';

const optionalPhone = z.union([z.literal('').transform(() => ''), indonesianMobile('Nomor WhatsApp')]);

const optionalUrl = (label) =>
  text({ max: 200, label }).refine(
    (value) => {
      if (value === '') return true;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: `${label} harus berupa alamat web lengkap, mis. https://instagram.com/royalbites` },
  );

const optionalImagePath = text({ max: 255, label: 'Logo' }).refine(
  (value) => value === '' || IMAGE_PATH_PATTERN.test(value),
  { message: 'Path gambar logo tidak valid.' },
);

/**
 * type: dipakai untuk menyimpan/membaca nilai dari tabel settings (semua disimpan sebagai teks).
 * isPublic: boleh dikirim ke pengunjung lewat GET /api/config.
 */
export const SETTING_DEFINITIONS = [
  {
    key: 'business_name',
    group: 'Identitas',
    label: 'Nama bisnis',
    type: 'string',
    isPublic: true,
    defaultValue: 'Royal Bites',
    schema: text({ min: 2, max: 60, label: 'Nama bisnis' }),
  },
  {
    key: 'business_description',
    group: 'Identitas',
    label: 'Deskripsi singkat (tampil di halaman utama)',
    type: 'string',
    isPublic: true,
    defaultValue:
      'Nikmati kelezatan kuliner Nusantara dengan sentuhan modern yang menggugah selera. Temukan cita rasa unik dari jajanan tradisional Indonesia yang melegenda.',
    schema: text({ min: 10, max: 300, label: 'Deskripsi' }),
  },
  {
    key: 'logo_image',
    group: 'Identitas',
    label: 'Logo (gambar, opsional)',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: optionalImagePath,
  },
  {
    key: 'whatsapp_number',
    group: 'Kontak',
    label: 'Nomor WhatsApp bisnis',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: optionalPhone,
  },
  {
    key: 'address',
    group: 'Kontak',
    label: 'Alamat toko',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: text({ max: 300, label: 'Alamat toko' }),
  },
  {
    key: 'opening_hours',
    group: 'Kontak',
    label: 'Jam operasional',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: text({ max: 300, label: 'Jam operasional' }),
  },
  {
    key: 'social_instagram',
    group: 'Media sosial',
    label: 'Instagram (URL lengkap)',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: optionalUrl('Link Instagram'),
  },
  {
    key: 'social_facebook',
    group: 'Media sosial',
    label: 'Facebook (URL lengkap)',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: optionalUrl('Link Facebook'),
  },
  {
    key: 'social_twitter',
    group: 'Media sosial',
    label: 'Twitter/X (URL lengkap)',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: optionalUrl('Link Twitter/X'),
  },
  {
    key: 'accepting_orders',
    group: 'Pemesanan',
    label: 'Terima pesanan online',
    type: 'boolean',
    isPublic: true,
    defaultValue: true,
    schema: z.boolean({ invalid_type_error: 'Nilai harus ya/tidak.' }),
  },
  {
    key: 'min_order_amount',
    group: 'Pemesanan',
    label: 'Minimum pemesanan (Rp, 0 = tanpa minimum)',
    type: 'integer',
    isPublic: true,
    defaultValue: 0,
    schema: integer({ min: 0, max: 10_000_000, label: 'Minimum pemesanan' }),
  },
  {
    key: 'low_stock_threshold',
    group: 'Pemesanan',
    label: 'Peringatan stok menipis jika stok <= (hanya untuk menu yang stoknya dihitung)',
    type: 'integer',
    isPublic: false,
    defaultValue: 5,
    schema: integer({ min: 0, max: 1000, label: 'Batas stok menipis' }),
  },
  {
    key: 'delivery_enabled',
    group: 'Pengiriman',
    label: 'Layani pengantaran',
    type: 'boolean',
    isPublic: true,
    defaultValue: false,
    schema: z.boolean({ invalid_type_error: 'Nilai harus ya/tidak.' }),
  },
  {
    key: 'delivery_area',
    group: 'Pengiriman',
    label: 'Area pengiriman',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: text({ max: 300, label: 'Area pengiriman' }),
  },
  {
    key: 'delivery_fee',
    group: 'Pengiriman',
    label: 'Ongkos kirim flat (Rp)',
    type: 'integer',
    isPublic: true,
    defaultValue: 0,
    schema: integer({ min: 0, max: 1_000_000, label: 'Ongkos kirim' }),
  },
  {
    key: 'payment_cod_enabled',
    group: 'Pembayaran',
    label: 'Terima bayar di tempat (tunai)',
    type: 'boolean',
    isPublic: true,
    defaultValue: true,
    schema: z.boolean({ invalid_type_error: 'Nilai harus ya/tidak.' }),
  },
  {
    key: 'payment_qris_enabled',
    group: 'Pembayaran',
    label: 'Terima QRIS (aktif hanya jika payment gateway sudah dikonfigurasi di server)',
    type: 'boolean',
    isPublic: true,
    defaultValue: true,
    schema: z.boolean({ invalid_type_error: 'Nilai harus ya/tidak.' }),
  },
  {
    key: 'payment_transfer_enabled',
    group: 'Pembayaran',
    label: 'Terima transfer manual',
    type: 'boolean',
    isPublic: true,
    defaultValue: false,
    schema: z.boolean({ invalid_type_error: 'Nilai harus ya/tidak.' }),
  },
  {
    key: 'payment_transfer_instructions',
    group: 'Pembayaran',
    label: 'Petunjuk transfer (nama bank, no. rekening, atas nama)',
    type: 'string',
    isPublic: true,
    defaultValue: '',
    schema: text({ max: 500, label: 'Petunjuk transfer' }),
  },
];

export const SETTINGS_BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

/** Mengubah nilai tersimpan (teks) menjadi tipe aslinya. */
export function decodeSettingValue(definition, raw) {
  if (raw === undefined || raw === null) return definition.defaultValue;
  if (definition.type === 'boolean') return raw === '1';
  if (definition.type === 'integer') {
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : definition.defaultValue;
  }
  return String(raw);
}

/** Mengubah nilai bertipe menjadi teks untuk disimpan di tabel settings. */
export function encodeSettingValue(definition, value) {
  if (definition.type === 'boolean') return value ? '1' : '0';
  return String(value);
}
