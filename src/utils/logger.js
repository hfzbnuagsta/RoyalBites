// Logger sederhana berformat JSON per baris.
// Aturan keamanan:
//  - JANGAN pernah mencatat body request, cookie, password, atau token.
//  - Error database dicatat tanpa SQL/parameter karena bisa memuat data pelanggan.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Nama field yang nilainya selalu disamarkan jika tidak sengaja ikut dicatat.
const REDACT_KEYS = new Set([
  'password',
  'current_password',
  'new_password',
  'password_hash',
  'token',
  'csrf_token',
  'cookie',
  'authorization',
  'customer_phone',
  'delivery_address',
]);

function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACT_KEYS.has(key.toLowerCase()) ? '[DISAMARKAN]' : redact(val, depth + 1);
  }
  return out;
}

/**
 * Mengubah Error menjadi objek aman untuk log (tanpa `sql`, `values`, dan parameter query).
 * Catatan: baris pertama `err.stack` memuat pesan error asli. Pada error MySQL pesan itu bisa berisi
 * data pelanggan (mis. "Duplicate entry '62812...' for key ..."), jadi pesannya diganti sebelum dicatat.
 */
export function serializeError(err) {
  if (!err || typeof err !== 'object') return { message: String(err) };
  const safeMessage = err.sqlMessage ? 'Kesalahan database' : err.message;
  const firstFrame = typeof err.stack === 'string' ? err.stack.indexOf('\n    at ') : -1;
  return {
    name: err.name,
    message: safeMessage,
    code: err.code,
    errno: err.errno,
    sqlState: err.sqlState,
    stack: firstFrame === -1 ? undefined : `${err.name}: ${safeMessage}${err.stack.slice(firstFrame)}`,
  };
}

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, message, fields) {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...redact(fields),
    });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
