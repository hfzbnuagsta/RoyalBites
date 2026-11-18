// Membaca dan memvalidasi konfigurasi dari environment variable (.env).
// Semua pengaturan rahasia (password DB, dll.) hanya dibaca di sisi server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Mengubah string env menjadi integer; jika kosong/tidak valid pakai nilai default. */
function toInt(value, fallback, { min = -Infinity, max = Infinity, name = 'nilai' } = {}) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Konfigurasi ${name} tidak valid: "${value}" (harus bilangan bulat ${min}..${max})`);
  }
  return parsed;
}

function toBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** TRUST_PROXY: "false", "true", angka (jumlah proxy), atau string subnet Express. */
function parseTrustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const PAYMENT_PROVIDERS = ['', 'midtrans', 'mock'];

/**
 * Konfigurasi pembayaran QRIS (payment gateway).
 *   PAYMENT_PROVIDER kosong  -> QRIS tidak aktif (metode lama tetap jalan)
 *   PAYMENT_PROVIDER=midtrans -> gateway sungguhan (sandbox atau production sesuai PAYMENT_IS_PRODUCTION)
 *   PAYMENT_PROVIDER=mock     -> penyedia palsu untuk development/test. DITOLAK di production.
 * Kunci rahasia hanya dibaca di server dan tidak pernah dikirim ke browser.
 */
function loadPaymentConfig(env) {
  const provider = (env.PAYMENT_PROVIDER || '').trim().toLowerCase();
  const isProduction = toBool(env.PAYMENT_IS_PRODUCTION, false);
  return {
    provider,
    enabled: provider !== '',
    serverKey: env.PAYMENT_SERVER_KEY || '',
    // Tidak dipakai alur QRIS Core API (server-side). Disediakan bila kelak memakai Snap/JS gateway.
    clientKey: env.PAYMENT_CLIENT_KEY || '',
    merchantId: env.PAYMENT_MERCHANT_ID || '',
    isProduction,
    // Hanya untuk test (server tiruan lokal). Ditolak di production.
    apiBaseUrl: (env.PAYMENT_API_BASE_URL || '').replace(/\/+$/, ''),
    webhookUrl: env.PAYMENT_WEBHOOK_URL || '',
    qrisAcquirer: env.PAYMENT_QRIS_ACQUIRER || 'gopay',
    qrisExpiryMinutes: toInt(env.PAYMENT_QRIS_EXPIRY_MINUTES, 15, { min: 5, max: 1440, name: 'PAYMENT_QRIS_EXPIRY_MINUTES' }),
    // Waktu tunggu setelah batas bayar sebelum pesanan dibatalkan otomatis (menyerap keterlambatan notifikasi).
    graceSeconds: toInt(env.PAYMENT_EXPIRY_GRACE_SECONDS, 90, { min: 0, max: 3600, name: 'PAYMENT_EXPIRY_GRACE_SECONDS' }),
    sweepIntervalSeconds: toInt(env.PAYMENT_SWEEP_INTERVAL_SECONDS, 60, { min: 5, max: 3600, name: 'PAYMENT_SWEEP_INTERVAL_SECONDS' }),
    // Konfirmasi ulang status "lunas" ke API gateway sebelum menandai pesanan lunas (disarankan).
    verifyWithStatusApi: toBool(env.PAYMENT_VERIFY_STATUS_API, true),
    requestTimeoutMs: toInt(env.PAYMENT_REQUEST_TIMEOUT_MS, 10000, { min: 1000, max: 60000, name: 'PAYMENT_REQUEST_TIMEOUT_MS' }),
  };
}

/**
 * Membuat objek konfigurasi dari env.
 * Dibuat sebagai fungsi (bukan konstanta global) supaya mudah dipakai di test.
 */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const config = {
    nodeEnv,
    isProduction,
    port: toInt(env.PORT, 3000, { min: 0, max: 65535, name: 'PORT' }),
    // Development: hanya lokal. Production: semua interface (biasanya di belakang reverse proxy).
    host: env.HOST || (isProduction ? '0.0.0.0' : '127.0.0.1'),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    forceHttps: toBool(env.FORCE_HTTPS, false),
    corsOrigins: parseList(env.CORS_ORIGINS),
    appOrigins: parseList(env.APP_ORIGIN),
    db: {
      host: env.DB_HOST || '127.0.0.1',
      port: toInt(env.DB_PORT, 3306, { min: 1, max: 65535, name: 'DB_PORT' }),
      user: env.DB_USER || '',
      password: env.DB_PASSWORD || '',
      database: env.DB_NAME || '',
      connectionLimit: toInt(env.DB_CONNECTION_LIMIT, 10, { min: 1, max: 100, name: 'DB_CONNECTION_LIMIT' }),
    },
    session: {
      ttlHours: toInt(env.SESSION_TTL_HOURS, 8, { min: 1, max: 24 * 30, name: 'SESSION_TTL_HOURS' }),
      idleMinutes: toInt(env.SESSION_IDLE_MINUTES, 120, { min: 5, max: 24 * 60, name: 'SESSION_IDLE_MINUTES' }),
      // Cookie "Secure" hanya dikirim lewat HTTPS. Wajib aktif di production.
      secureCookie: toBool(env.COOKIE_SECURE, isProduction),
    },
    uploads: {
      dir: path.resolve(PROJECT_ROOT, env.UPLOAD_DIR || './uploads'),
      maxBytes: toInt(env.UPLOAD_MAX_MB, 2, { min: 1, max: 20, name: 'UPLOAD_MAX_MB' }) * 1024 * 1024,
    },
    // WIB = UTC+7 = 420 menit. Dipakai untuk filter tanggal laporan dan nomor pesanan.
    businessUtcOffsetMinutes: toInt(env.BUSINESS_UTC_OFFSET_MINUTES, 420, {
      min: -720,
      max: 840,
      name: 'BUSINESS_UTC_OFFSET_MINUTES',
    }),
    bcryptCost: toInt(env.BCRYPT_COST, 12, { min: 4, max: 15, name: 'BCRYPT_COST' }),
    rateLimit: {
      // Hanya boleh dimatikan untuk test otomatis. Di production wajib aktif (lihat assertRunnable).
      enabled: toBool(env.RATE_LIMIT_ENABLED, true),
      loginAttempts: toInt(env.RATE_LIMIT_LOGIN_ATTEMPTS, 10, { min: 1, max: 1000, name: 'RATE_LIMIT_LOGIN_ATTEMPTS' }),
    },
    payment: loadPaymentConfig(env),
    logLevel: env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info'),
    publicDir: path.join(PROJECT_ROOT, 'public'),
  };

  return config;
}

/** Memastikan konfigurasi minimum untuk menjalankan server sudah diisi. */
export function assertRunnable(config) {
  const missing = [];
  if (!config.db.user) missing.push('DB_USER');
  if (!config.db.database) missing.push('DB_NAME');
  if (missing.length > 0) {
    throw new Error(
      `Konfigurasi belum lengkap. Isi variabel berikut di file .env: ${missing.join(', ')}. ` +
        'Lihat .env.example untuk contohnya.',
    );
  }
  if (config.isProduction && !config.db.password) {
    throw new Error('DB_PASSWORD wajib diisi di production. Jangan memakai user database tanpa password.');
  }
  if (config.isProduction && !config.rateLimit.enabled) {
    throw new Error('RATE_LIMIT_ENABLED tidak boleh dimatikan di production.');
  }
  if (config.isProduction && !config.session.secureCookie) {
    throw new Error('COOKIE_SECURE tidak boleh dimatikan di production (cookie sesi admin harus Secure/HTTPS).');
  }
  assertPaymentConfig(config);
}

/** Aturan konfigurasi pembayaran. Pesan sengaja tidak memuat nilai kunci. */
export function assertPaymentConfig(config) {
  const payment = config.payment;
  if (!PAYMENT_PROVIDERS.includes(payment.provider)) {
    throw new Error(`PAYMENT_PROVIDER "${payment.provider}" tidak dikenal. Pilihan: midtrans, mock, atau kosong (QRIS nonaktif).`);
  }
  if (!payment.enabled) return;

  if (payment.provider === 'mock') {
    if (config.isProduction || payment.isProduction) {
      throw new Error('PAYMENT_PROVIDER=mock hanya untuk development/test dan DILARANG di production. Gunakan PAYMENT_PROVIDER=midtrans.');
    }
    return;
  }

  // midtrans
  if (!payment.serverKey) {
    throw new Error('PAYMENT_SERVER_KEY wajib diisi jika PAYMENT_PROVIDER=midtrans (ambil dari dashboard Midtrans: Settings > Access Keys).');
  }
  if (payment.isProduction && payment.serverKey.startsWith('SB-')) {
    throw new Error('PAYMENT_IS_PRODUCTION=true tetapi PAYMENT_SERVER_KEY adalah kunci sandbox (awalan "SB-"). Pakai kunci production.');
  }
  if (config.isProduction && payment.apiBaseUrl) {
    throw new Error('PAYMENT_API_BASE_URL hanya untuk test dan tidak boleh diisi di production.');
  }
}
