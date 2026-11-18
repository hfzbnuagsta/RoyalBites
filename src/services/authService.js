// Autentikasi admin: hash password (bcrypt), sesi login berbasis cookie, dan ganti password.
//
// Cara kerja sesi:
//  - Saat login, server membuat token acak 32 byte dan mengirimkannya sebagai cookie HttpOnly.
//  - Database HANYA menyimpan hash SHA-256 dari token itu. Jika database bocor, token tidak bisa dipakai.
//  - Setiap sesi punya csrf_token sendiri untuk melindungi dari serangan CSRF.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { AppError, notFound } from '../utils/errors.js';

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------- Password
const COMMON_PASSWORDS = new Set([
  'password1234',
  'passw0rd1234',
  '123456789012',
  'qwertyuiop12',
  'admin1234567',
  'royalbites123',
  'royalbites1234',
]);

/** Aturan password: panjang minimal 12, maksimal 72 byte (batas bcrypt), dan bukan password umum. */
export function assertPasswordPolicy(password, username = '') {
  const problems = [];
  if (password.length < 12) problems.push('minimal 12 karakter');
  if (Buffer.byteLength(password, 'utf8') > 72) problems.push('maksimal 72 byte');
  if (/^(.)\1+$/.test(password)) problems.push('tidak boleh satu karakter yang diulang');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('terlalu umum dan mudah ditebak');
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    problems.push('tidak boleh mengandung username');
  }
  if (problems.length > 0) {
    throw new AppError(400, 'WEAK_PASSWORD', `Password ${problems.join(', ')}.`, {
      fields: { password: `Password ${problems.join(', ')}.` },
    });
  }
}

export function hashPassword(password, cost) {
  return bcrypt.hash(password, cost);
}

// Hash palsu dengan "cost" yang sama. Dipakai agar login username tak dikenal sama lambatnya
// dengan username dikenal (mencegah penyerang menebak username lewat perbedaan waktu respons).
let dummyHashPromise = null;
function getDummyHash(cost) {
  dummyHashPromise ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), cost);
  return dummyHashPromise;
}

// ---------------------------------------------------------------- Pengguna admin
export function toPublicUser(row) {
  return { id: row.id, username: row.username, role: row.role };
}

export async function createAdminUser(db, config, { username, password, role }) {
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Username 3-50 karakter: huruf kecil, angka, titik, minus, atau underscore.', {
      fields: { username: 'Gunakan huruf kecil, angka, titik, minus, atau underscore (3-50 karakter).' },
    });
  }
  if (!['owner', 'staff'].includes(role)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Role harus "owner" atau "staff".');
  }
  assertPasswordPolicy(password, username);
  const passwordHash = await hashPassword(password, config.bcryptCost);
  try {
    const [result] = await db.execute('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)', [
      username,
      passwordHash,
      role,
    ]);
    return { id: result.insertId, username, role };
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      throw new AppError(409, 'USERNAME_TAKEN', `Username "${username}" sudah dipakai.`);
    }
    throw error;
  }
}

/** Memeriksa username+password. Mengembalikan data pengguna, atau null jika salah. */
export async function authenticate(db, config, username, password) {
  const [rows] = await db.execute(
    'SELECT id, username, password_hash, role, is_active FROM admin_users WHERE username = ?',
    [username],
  );
  const user = rows[0];
  // Selalu jalankan bcrypt.compare, walaupun user tidak ada (lihat getDummyHash).
  const hash = user ? user.password_hash : await getDummyHash(config.bcryptCost);
  const matches = await bcrypt.compare(password, hash);
  if (!user || !matches || !user.is_active) return null;
  await db.execute('UPDATE admin_users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  return toPublicUser(user);
}

// ---------------------------------------------------------------- Sesi
export async function createSession(db, config, user, { ip, userAgent }) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.session.ttlHours * MS_PER_HOUR);

  // Bersihkan sesi kedaluwarsa setiap kali ada login baru (tidak perlu cron job).
  await db.execute('DELETE FROM admin_sessions WHERE expires_at < ?', [now]);
  await db.execute(
    `INSERT INTO admin_sessions (id, admin_user_id, csrf_token, ip_address, user_agent, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sha256Hex(token), user.id, csrfToken, (ip || '').slice(0, 45) || null, (userAgent || '').slice(0, 255) || null, now, now, expiresAt],
  );
  return { token, csrfToken, expiresAt };
}

/** Mencari sesi yang masih berlaku. Mengembalikan { user, session } atau null. */
export async function findSession(db, config, token) {
  const now = new Date();
  const idleLimit = new Date(now.getTime() - config.session.idleMinutes * MS_PER_MINUTE);
  const [rows] = await db.execute(
    `SELECT s.id AS session_id, s.csrf_token, s.last_seen_at, u.id, u.username, u.role
       FROM admin_sessions s
       JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.id = ? AND s.expires_at > ? AND s.last_seen_at > ? AND u.is_active = 1`,
    [sha256Hex(token), now, idleLimit],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  // Perbarui "terakhir aktif" paling sering sekali per menit (hemat tulis ke database).
  if (now.getTime() - new Date(row.last_seen_at).getTime() > MS_PER_MINUTE) {
    await db.execute('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?', [now, row.session_id]);
  }
  return {
    user: toPublicUser(row),
    session: { id: row.session_id, csrfToken: row.csrf_token },
  };
}

export async function destroySession(db, token) {
  await db.execute('DELETE FROM admin_sessions WHERE id = ?', [sha256Hex(token)]);
}

export async function changePassword(db, config, user, sessionId, currentPassword, newPassword) {
  const [rows] = await db.execute('SELECT password_hash FROM admin_users WHERE id = ?', [user.id]);
  if (rows.length === 0) throw notFound('Akun tidak ditemukan.');

  const matches = await bcrypt.compare(currentPassword, rows[0].password_hash);
  if (!matches) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Password saat ini salah.', {
      fields: { current_password: 'Password saat ini salah.' },
    });
  }
  if (currentPassword === newPassword) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Password baru harus berbeda dari password saat ini.', {
      fields: { new_password: 'Password baru harus berbeda dari password saat ini.' },
    });
  }
  assertPasswordPolicy(newPassword, user.username);

  const newHash = await hashPassword(newPassword, config.bcryptCost);
  await db.execute('UPDATE admin_users SET password_hash = ? WHERE id = ?', [newHash, user.id]);
  // Keluarkan semua perangkat lain; sesi yang sedang dipakai tetap aktif.
  await db.execute('DELETE FROM admin_sessions WHERE admin_user_id = ? AND id <> ?', [user.id, sessionId]);
}
