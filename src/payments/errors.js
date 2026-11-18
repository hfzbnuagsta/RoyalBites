// Error dari penyedia pembayaran. Pesan teknis tidak pernah ditampilkan ke pelanggan.
export class PaymentProviderError extends Error {
  /**
   * @param {string} message pesan teknis (hanya untuk log, tanpa kunci rahasia)
   * @param {{retryable?: boolean, httpStatus?: number|null, providerCode?: string|null}} [info]
   */
  constructor(message, { retryable = true, httpStatus = null, providerCode = null } = {}) {
    super(message);
    this.name = 'PaymentProviderError';
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
  }
}
