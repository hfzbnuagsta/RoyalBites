// Middleware autentikasi & otorisasi admin.
// Pengecekan izin dilakukan DI SERVER pada setiap endpoint — bukan sekadar menyembunyikan tombol di frontend.
import crypto from 'node:crypto';
import { findSession } from '../services/authService.js';
import { forbidden, unauthorized } from '../utils/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Nama cookie. Prefiks "__Host-" membuat browser menolak cookie yang tidak Secure / bukan dari host ini. */
export function sessionCookieName(config) {
  return config.session.secureCookie ? '__Host-rb_admin' : 'rb_admin';
}

export function sessionCookieOptions(config, expiresAt) {
  return {
    httpOnly: true, // tidak bisa dibaca JavaScript (melindungi dari pencurian lewat XSS)
    secure: config.session.secureCookie, // hanya dikirim lewat HTTPS
    sameSite: 'strict', // tidak dikirim pada request lintas situs (melindungi dari CSRF)
    path: '/',
    expires: expiresAt,
  };
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function createAuthMiddleware({ pool, config }) {
  const cookieName = sessionCookieName(config);

  /** Membaca cookie sesi (jika ada) dan mengisi req.admin + req.adminSession. */
  async function loadSession(req, res, next) {
    const token = readCookie(req.headers.cookie, cookieName);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const found = await findSession(pool, config, token);
      if (found) {
        req.admin = found.user;
        req.adminSession = found.session;
        req.adminToken = token;
      }
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!req.admin) return next(unauthorized());
    return next();
  }

  /** Contoh: requireRole('owner') — hanya pemilik. */
  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.admin) return next(unauthorized());
      if (!roles.includes(req.admin.role)) return next(forbidden());
      return next();
    };
  }

  /** Request yang mengubah data wajib membawa header X-CSRF-Token yang cocok dengan sesi. */
  function requireCsrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const sent = req.get('x-csrf-token') || '';
    const expected = req.adminSession?.csrfToken || '';
    const sentBuffer = Buffer.from(sent);
    const expectedBuffer = Buffer.from(expected);
    const valid =
      expected.length > 0 && sentBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(sentBuffer, expectedBuffer);
    if (!valid) {
      return next(forbidden('Token keamanan tidak valid. Muat ulang halaman lalu coba lagi.'));
    }
    return next();
  }

  return { cookieName, loadSession, requireAdmin, requireRole, requireCsrf };
}

/**
 * Pertahanan tambahan terhadap CSRF: tolak request pengubah data yang jelas berasal dari situs lain.
 * (Browser modern mengirim Origin / Sec-Fetch-Site secara otomatis.)
 */
export function createSameOriginGuard(config) {
  const allowedHosts = new Set();
  for (const origin of config.appOrigins) {
    try {
      allowedHosts.add(new URL(origin).host);
    } catch {
      // Abaikan nilai yang bukan URL; validasi konfigurasi ada di dokumentasi.
    }
  }

  return function sameOriginGuard(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') {
      return next(forbidden('Permintaan ditolak: berasal dari situs lain.'));
    }
    const origin = req.get('origin');
    if (!origin) return next(); // klien non-browser (curl, test); token CSRF tetap wajib
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(forbidden('Permintaan ditolak: asal tidak valid.'));
    }
    if (originHost === req.get('host') || allowedHosts.has(originHost)) return next();
    return next(forbidden('Permintaan ditolak: asal tidak dikenal.'));
  };
}
