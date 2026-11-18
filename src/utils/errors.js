// Error terstruktur yang aman ditampilkan ke pengguna.
// Semua error lain (bug, error database) dianggap internal dan TIDAK dibocorkan detailnya.

export class AppError extends Error {
  /**
   * @param {number} status  HTTP status code (400, 401, 403, 404, 409, ...)
   * @param {string} code    kode mesin yang stabil, mis. "VALIDATION_ERROR"
   * @param {string} message pesan berbahasa Indonesia untuk pengguna
   * @param {object} [details] data tambahan yang aman (mis. daftar field yang salah)
   */
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Silakan login terlebih dahulu.') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Anda tidak memiliki izin untuk tindakan ini.') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Data tidak ditemukan.') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (code, message, details) => new AppError(409, code, message, details);
