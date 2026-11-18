// Membaca & menyimpan pengaturan bisnis (tabel `settings`), digabung dengan nilai default.
import { z } from 'zod';
import {
  SETTING_DEFINITIONS,
  SETTINGS_BY_KEY,
  decodeSettingValue,
  encodeSettingValue,
} from '../config/settingsSchema.js';
import { CATEGORIES, FULFILLMENT_METHODS, PAYMENT_METHODS } from '../config/constants.js';
import { AppError, badRequest } from '../utils/errors.js';
import { parseOrThrow } from '../utils/validation.js';

/** Semua pengaturan (nilai tersimpan + default), bertipe benar. Dipakai di server. */
export async function getAllSettings(db) {
  const [rows] = await db.query('SELECT setting_key, setting_value FROM settings');
  const stored = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  const result = {};
  for (const definition of SETTING_DEFINITIONS) {
    result[definition.key] = decodeSettingValue(definition, stored.get(definition.key));
  }
  return result;
}

/**
 * Pengaturan yang aman dibagikan ke pengunjung, plus metode pembayaran/pengiriman yang aktif.
 * @param {{mode: string, expiry_minutes: number}|null} qris info QRIS jika payment gateway terkonfigurasi di server
 */
export function buildPublicConfig(settings, { qris = null } = {}) {
  const paymentMethods = [];
  if (settings.payment_cod_enabled) {
    paymentMethods.push({ value: 'cod', label: PAYMENT_METHODS.cod });
  }
  // QRIS hanya ditawarkan jika gateway benar-benar terkonfigurasi DAN pemilik mengaktifkannya.
  if (qris && settings.payment_qris_enabled) {
    paymentMethods.push({
      value: 'qris',
      label: PAYMENT_METHODS.qris,
      mode: qris.mode, // 'live' | 'sandbox' | 'mock' — frontend menampilkan pemberitahuan jika bukan 'live'
      expiry_minutes: qris.expiry_minutes,
    });
  }
  if (settings.payment_transfer_enabled) {
    paymentMethods.push({
      value: 'bank_transfer',
      label: PAYMENT_METHODS.bank_transfer,
      instructions: settings.payment_transfer_instructions,
    });
  }

  const fulfillmentMethods = [{ value: 'pickup', label: FULFILLMENT_METHODS.pickup }];
  if (settings.delivery_enabled) {
    fulfillmentMethods.push({ value: 'delivery', label: FULFILLMENT_METHODS.delivery });
  }

  return {
    business: {
      name: settings.business_name,
      description: settings.business_description,
      logo_image: settings.logo_image || null,
      whatsapp_number: settings.whatsapp_number || null,
      address: settings.address || null,
      opening_hours: settings.opening_hours || null,
      social: {
        instagram: settings.social_instagram || null,
        facebook: settings.social_facebook || null,
        twitter: settings.social_twitter || null,
      },
    },
    ordering: {
      accepting_orders: settings.accepting_orders,
      min_order_amount: settings.min_order_amount,
      delivery_enabled: settings.delivery_enabled,
      delivery_area: settings.delivery_area || null,
      delivery_fee: settings.delivery_fee,
      fulfillment_methods: fulfillmentMethods,
      payment_methods: paymentMethods,
    },
    categories: CATEGORIES,
  };
}

/** Aturan antar-pengaturan yang tidak bisa dicek per-field. */
function assertConsistent(settings, { qrisAvailable }) {
  // QRIS hanya dihitung sebagai metode yang bisa dipakai jika gateway benar-benar terkonfigurasi di server.
  const qrisUsable = qrisAvailable && settings.payment_qris_enabled;
  if (!settings.payment_cod_enabled && !settings.payment_transfer_enabled && !qrisUsable) {
    throw badRequest('Aktifkan minimal satu metode pembayaran.', {
      fields: { payment_cod_enabled: 'Aktifkan minimal satu metode pembayaran.' },
    });
  }
  if (settings.payment_transfer_enabled && settings.payment_transfer_instructions.trim() === '') {
    throw badRequest('Isi petunjuk transfer (bank, nomor rekening, atas nama) sebelum mengaktifkan transfer.', {
      fields: { payment_transfer_instructions: 'Wajib diisi jika transfer manual diaktifkan.' },
    });
  }
}

/**
 * Menyimpan sebagian pengaturan. Hanya key yang dikenal yang diterima; sisanya ditolak.
 * @returns {Promise<object>} seluruh pengaturan terbaru
 */
export async function updateSettings(db, patch, { qrisAvailable = false } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw badRequest('Data pengaturan tidak valid.');
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) throw badRequest('Tidak ada pengaturan yang diubah.');

  const unknown = keys.filter((key) => !SETTINGS_BY_KEY.has(key));
  if (unknown.length > 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Ada pengaturan yang tidak dikenal.', {
      fields: Object.fromEntries(unknown.map((key) => [key, 'Pengaturan tidak dikenal.'])),
    });
  }

  const shape = Object.fromEntries(keys.map((key) => [key, SETTINGS_BY_KEY.get(key).schema]));
  const validated = parseOrThrow(z.object(shape).strict(), patch);

  const current = await getAllSettings(db);
  const merged = { ...current, ...validated };
  assertConsistent(merged, { qrisAvailable });

  // Satu perintah INSERT multi-baris = atomik: semua tersimpan atau tidak sama sekali.
  const rows = keys.map((key) => [key, encodeSettingValue(SETTINGS_BY_KEY.get(key), validated[key])]);
  await db.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES ?
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [rows],
  );
  return merged;
}

/** Metadata field untuk membangun form pengaturan di dashboard admin. */
export function describeSettings() {
  return SETTING_DEFINITIONS.map(({ key, group, label, type }) => ({ key, group, label, type }));
}
