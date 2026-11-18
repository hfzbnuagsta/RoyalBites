// Pembatasan jumlah request (rate limiting) pada endpoint yang rawan disalahgunakan.
// Penghitung disimpan di memori proses: cukup untuk satu server. Jika kelak memakai banyak server,
// pindahkan ke penyimpanan bersama (mis. Redis).
import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/errors.js';

function createLimiter({ windowMs, limit, message, skipSuccessfulRequests = false }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests,
    // Satukan format error dengan error lain di aplikasi ini.
    handler: (req, res, next) => next(new AppError(429, 'RATE_LIMITED', message)),
  });
}

const passThrough = (req, res, next) => next();

/** Membuat semua limiter. Jika dimatikan (khusus test), semuanya menjadi middleware kosong. */
export function createRateLimiters(config) {
  if (!config.rateLimit.enabled) {
    return { api: passThrough, login: passThrough, order: passThrough, contact: passThrough, trackLookup: passThrough, payment: passThrough, webhook: passThrough };
  }
  const minutes = (n) => n * 60 * 1000;
  return {
    // Batas umum untuk seluruh /api per alamat IP.
    api: createLimiter({
      windowMs: minutes(1),
      limit: 300,
      message: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.',
    }),
    // Login: hanya percobaan GAGAL yang dihitung. Batas ketat untuk menghambat tebak-tebakan password.
    login: createLimiter({
      windowMs: minutes(15),
      limit: config.rateLimit.loginAttempts,
      skipSuccessfulRequests: true,
      message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
    }),
    order: createLimiter({
      windowMs: minutes(15),
      limit: 30,
      message: 'Terlalu banyak percobaan memesan. Coba lagi dalam beberapa menit.',
    }),
    // Pelacakan dengan nomor pesanan + nomor WhatsApp (bisa ditebak): hanya percobaan GAGAL yang dihitung.
    trackLookup: createLimiter({
      windowMs: minutes(15),
      limit: 15,
      skipSuccessfulRequests: true,
      message: 'Terlalu banyak percobaan melacak pesanan. Coba lagi dalam 15 menit.',
    }),
    // Tindakan yang memanggil gateway (muat QR, buat ulang QRIS, cek status).
    payment: createLimiter({
      windowMs: minutes(15),
      limit: 90,
      message: 'Terlalu banyak permintaan pembayaran. Coba lagi dalam beberapa menit.',
    }),
    // Webhook gateway: longgar karena IP gateway banyak dan retry mereka harus tetap diterima.
    webhook: createLimiter({
      windowMs: minutes(1),
      limit: 600,
      message: 'Terlalu banyak notifikasi.',
    }),
    contact: createLimiter({
      windowMs: minutes(60),
      limit: 10,
      message: 'Terlalu banyak pesan terkirim. Coba lagi nanti.',
    }),
  };
}
