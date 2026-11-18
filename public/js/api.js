// Komunikasi dengan backend (REST API). Semua pemanggilan lewat fungsi `request` agar
// penanganan error seragam: setiap kegagalan menjadi ApiError dengan pesan yang ramah pengguna.

export class ApiError extends Error {
  constructor({ status = 0, code = "UNKNOWN", message, details }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(path, { method = "GET", body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new ApiError({ code: "TIMEOUT", message: "Server terlalu lama merespons. Periksa koneksi Anda lalu coba lagi." });
    }
    throw new ApiError({ code: "NETWORK", message: "Tidak dapat terhubung ke server. Periksa koneksi internet Anda lalu coba lagi." });
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Respons bukan JSON (mis. halaman error dari proxy)
  }

  if (!response.ok) {
    const error = data?.error;
    throw new ApiError({
      status: response.status,
      code: error?.code ?? "HTTP_ERROR",
      message: error?.message ?? "Terjadi kesalahan pada server. Silakan coba lagi.",
      details: error?.details,
    });
  }
  if (data === null) {
    throw new ApiError({ status: response.status, code: "BAD_RESPONSE", message: "Respons server tidak dapat dibaca." });
  }
  return data;
}

export const getConfig = () => request("/api/config");
export const getProducts = () => request("/api/products");
export const createOrder = (payload) => request("/api/orders", { method: "POST", body: payload });
export const sendContactMessage = (payload) => request("/api/contact", { method: "POST", body: payload });

// ------------------------------------------------------------------ lacak pesanan & pembayaran
// `lookup` berisi { token } ATAU { order_number, phone }. Selalu dikirim lewat body POST (bukan URL),
// supaya token rahasia tidak tercatat di log server maupun riwayat browser.
export const trackOrder = (lookup) => request("/api/orders/track", { method: "POST", body: lookup });
export const getTrackingQr = (lookup) => request("/api/orders/track/qr", { method: "POST", body: lookup });
export const retryPayment = (lookup) => request("/api/orders/track/retry-payment", { method: "POST", body: lookup, timeoutMs: 30000 });
export const checkPayment = (lookup) => request("/api/orders/track/check-payment", { method: "POST", body: lookup, timeoutMs: 30000 });
