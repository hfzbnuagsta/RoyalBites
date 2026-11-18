// Penanganan error terpusat. Aturan utama: pelanggan TIDAK PERNAH melihat stack trace,
// query SQL, atau detail database. Detail lengkap hanya masuk ke log server.
import { AppError } from '../utils/errors.js';
import { serializeError } from '../utils/logger.js';

// Kode error koneksi/otentikasi database => dari sisi pengguna "layanan sedang bermasalah".
const DATABASE_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
  'ER_SERVER_SHUTDOWN',
]);

export function notFoundHandler(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', 'Alamat yang diminta tidak ditemukan.'));
}

function send(res, status, code, message, details) {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

export function createErrorHandler(logger) {
  // Express mengenali error handler dari jumlah parameternya (4), jadi `next` harus tetap ada.
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    if (err instanceof AppError) {
      return send(res, err.status, err.code, err.message, err.details);
    }

    // Kesalahan dari body-parser (JSON rusak / terlalu besar).
    if (err?.type === 'entity.parse.failed') {
      return send(res, 400, 'INVALID_JSON', 'Format data yang dikirim tidak valid (JSON rusak).');
    }
    if (err?.type === 'entity.too.large') {
      return send(res, 413, 'PAYLOAD_TOO_LARGE', 'Data yang dikirim terlalu besar.');
    }
    // Kesalahan dari multer (upload).
    if (err?.name === 'MulterError') {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return send(res, 413, 'FILE_TOO_LARGE', 'Ukuran gambar terlalu besar.');
      }
      return send(res, 400, 'UPLOAD_ERROR', 'Upload tidak valid. Kirim satu file gambar pada field "image".');
    }

    logger.error('unhandled_error', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      error: serializeError(err),
    });

    if (DATABASE_UNAVAILABLE_CODES.has(err?.code)) {
      return send(res, 503, 'SERVICE_UNAVAILABLE', 'Layanan sedang bermasalah. Silakan coba lagi beberapa saat lagi.');
    }
    return send(res, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan pada server. Silakan coba lagi.');
  };
}
