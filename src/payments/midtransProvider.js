// Klien Midtrans Core API untuk QRIS (server-side). Kunci rahasia (Server Key) hanya ada di server.
//
// Kontrak yang dipakai — diverifikasi dari dokumentasi resmi Midtrans (docs.midtrans.com):
//   * Autentikasi : HTTP Basic, username = Server Key, password kosong -> "Basic base64(ServerKey:)"
//   * Buat QRIS   : POST {base}/v2/charge  {payment_type:"qris", transaction_details:{order_id,gross_amount}, qris:{acquirer}}
//                   respons: status_code "201", transaction_id, transaction_status "pending",
//                   actions[] berisi {name:"generate-qr-code", method:"GET", url} untuk gambar QR (PNG)
//   * Cek status  : GET  {base}/v2/{order_id}/status
//   * Expire      : POST {base}/v2/{order_id}/expire
//   * Notifikasi  : signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
//   * Base URL    : sandbox https://api.sandbox.midtrans.com ; production https://api.midtrans.com
// BELUM diverifikasi terhadap akun Midtrans sungguhan (tidak ada kredensial di lingkungan pengembangan);
// lihat bagian "Keterbatasan" di README.
import { PaymentProviderError } from './errors.js';
import { verifyMidtransSignature } from './signature.js';

const SANDBOX_BASE_URL = 'https://api.sandbox.midtrans.com';
const PRODUCTION_BASE_URL = 'https://api.midtrans.com';
const OFFICIAL_HOSTS = ['api.sandbox.midtrans.com', 'api.midtrans.com'];
const MAX_QR_BYTES = 300 * 1024;

/** Menyeragamkan isi notifikasi / respons status Midtrans menjadi satu bentuk. */
export function normalizeStatusPayload(data) {
  return {
    found: true,
    orderId: data.order_id === undefined ? null : String(data.order_id),
    transactionId: data.transaction_id ? String(data.transaction_id) : null,
    transactionStatus: String(data.transaction_status ?? '').trim().toLowerCase(),
    statusCode: data.status_code === undefined ? null : String(data.status_code),
    fraudStatus: data.fraud_status ? String(data.fraud_status).trim().toLowerCase() : null,
    grossAmount: data.gross_amount === undefined || data.gross_amount === null ? null : String(data.gross_amount),
  };
}

export function createMidtransProvider(paymentConfig, { fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = paymentConfig.apiBaseUrl || (paymentConfig.isProduction ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL);
  const baseUrlParsed = new URL(baseUrl);
  const isCustomBase = !OFFICIAL_HOSTS.includes(baseUrlParsed.host);
  const authorization = `Basic ${Buffer.from(`${paymentConfig.serverKey}:`, 'utf8').toString('base64')}`;
  const timeoutMs = paymentConfig.requestTimeoutMs;

  /** URL gambar QR hanya boleh menunjuk ke host Midtrans (mencegah SSRF lewat respons yang dimanipulasi). */
  function assertAllowedQrUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new PaymentProviderError('URL QR dari Midtrans tidak valid.', { retryable: false });
    }
    const officialOk = url.protocol === 'https:' && OFFICIAL_HOSTS.includes(url.host);
    // Basis kustom (server tiruan untuk test) hanya diizinkan jika memang dikonfigurasi, dan tidak pernah di production.
    const customOk = isCustomBase && url.host === baseUrlParsed.host && ['http:', 'https:'].includes(url.protocol);
    if (!officialOk && !customOk) {
      throw new PaymentProviderError(`URL QR ditolak karena host tidak dikenal: ${url.host}`, { retryable: false });
    }
    return url;
  }

  async function call(method, pathName, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathName}`, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PaymentProviderError(`Tidak dapat menghubungi Midtrans (${error.name}).`, { retryable: true });
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new PaymentProviderError(
        'Midtrans menolak kredensial (HTTP 401/403). Periksa PAYMENT_SERVER_KEY dan pastikan modenya (sandbox/production) cocok.',
        { retryable: false, httpStatus: response.status },
      );
    }
    if (response.status >= 500) {
      throw new PaymentProviderError(`Midtrans sedang bermasalah (HTTP ${response.status}).`, { retryable: true, httpStatus: response.status });
    }
    return { httpStatus: response.status, data };
  }

  return {
    name: 'midtrans',
    mode: paymentConfig.isProduction ? 'live' : 'sandbox',
    capabilities: { statusApi: true },

    /** Membuat transaksi QRIS dinamis di Midtrans. */
    async createQris({ providerOrderId, amount, customerName, expiryMinutes }) {
      const { httpStatus, data } = await call('POST', '/v2/charge', {
        payment_type: 'qris',
        transaction_details: { order_id: providerOrderId, gross_amount: amount },
        qris: { acquirer: paymentConfig.qrisAcquirer },
        customer_details: { first_name: String(customerName).slice(0, 100) },
        custom_expiry: { expiry_duration: expiryMinutes, unit: 'minute' },
      });
      const code = String(data?.status_code ?? '');
      if (!data || !['200', '201'].includes(code)) {
        throw new PaymentProviderError(
          `Midtrans menolak pembuatan QRIS (status_code ${code || '?'}: ${String(data?.status_message ?? '').slice(0, 120)}).`,
          { retryable: false, httpStatus, providerCode: code || null },
        );
      }
      const status = String(data.transaction_status ?? '').toLowerCase();
      if (status !== 'pending' || !data.transaction_id || String(data.order_id) !== providerOrderId) {
        throw new PaymentProviderError('Respons pembuatan QRIS dari Midtrans tidak sesuai yang diharapkan.', { retryable: false, httpStatus });
      }
      if (Number(data.gross_amount) !== amount) {
        throw new PaymentProviderError('Nominal pada respons Midtrans tidak sama dengan nominal pesanan.', { retryable: false, httpStatus });
      }
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const action =
        actions.find((item) => item?.name === 'generate-qr-code') ?? actions.find((item) => item?.name === 'generate-qr-code-v2');
      if (!action?.url) {
        throw new PaymentProviderError('Respons Midtrans tidak berisi URL gambar QR.', { retryable: false, httpStatus });
      }
      const qrUrl = assertAllowedQrUrl(action.url).toString();
      return {
        transactionId: String(data.transaction_id),
        qrUrl,
        qrString: typeof data.qr_string === 'string' ? data.qr_string.slice(0, 2000) : null,
      };
    },

    /** Status transaksi dari API Midtrans (sumber kebenaran). */
    async getStatus(providerOrderId) {
      const { httpStatus, data } = await call('GET', `/v2/${encodeURIComponent(providerOrderId)}/status`);
      if (httpStatus === 404 || String(data?.status_code ?? '') === '404') return { found: false };
      if (!data || typeof data !== 'object') {
        throw new PaymentProviderError('Respons status dari Midtrans tidak dapat dibaca.', { retryable: true, httpStatus });
      }
      const normalized = normalizeStatusPayload(data);
      if (normalized.orderId !== providerOrderId) {
        throw new PaymentProviderError('Respons status Midtrans untuk order_id yang berbeda.', { retryable: true, httpStatus });
      }
      return normalized;
    },

    /** Menutup transaksi yang belum dibayar di sisi Midtrans (upaya terbaik; kegagalan tidak fatal). */
    async expire(providerOrderId) {
      const { data } = await call('POST', `/v2/${encodeURIComponent(providerOrderId)}/expire`);
      return { statusCode: data?.status_code ? String(data.status_code) : null };
    },

    /** Mengambil gambar QR asli dari Midtrans. */
    async fetchQrImage(qrUrl) {
      const url = assertAllowedQrUrl(qrUrl);
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      } catch (error) {
        throw new PaymentProviderError(`Gagal mengambil gambar QR (${error.name}).`, { retryable: true });
      }
      if (!response.ok) {
        throw new PaymentProviderError(`Gambar QR tidak dapat diambil (HTTP ${response.status}).`, { retryable: response.status >= 500, httpStatus: response.status });
      }
      const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/svg+xml'].includes(contentType)) {
        throw new PaymentProviderError('Respons QR bukan gambar.', { retryable: false });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_QR_BYTES) {
        throw new PaymentProviderError('Ukuran gambar QR tidak wajar.', { retryable: false });
      }
      return { contentType, buffer };
    },

    verifyNotification(body) {
      return verifyMidtransSignature(body, paymentConfig.serverKey);
    },
    normalizeNotification: normalizeStatusPayload,
  };
}
