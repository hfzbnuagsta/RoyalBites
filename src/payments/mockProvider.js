// Penyedia pembayaran PALSU untuk development/test saja.
//
// PERINGATAN: ini BUKAN QRIS yang sah. Gambar yang dihasilkan hanya berupa label "MOCK" dan tidak bisa
// dipindai/dibayar. Mode ini ditolak saat NODE_ENV=production (lihat assertPaymentConfig) dan
// frontend selalu menampilkan pemberitahuan "mode uji" saat mode ini aktif.
// Pembayaran "terjadi" hanya jika ada notifikasi bertanda tangan yang dikirim ke webhook,
// misalnya lewat:  npm run mock:pay -- <nomor pesanan>
import crypto from 'node:crypto';
import { normalizeStatusPayload } from './midtransProvider.js';
import { verifyMidtransSignature } from './signature.js';

export const MOCK_DEFAULT_SERVER_KEY = 'mock-server-key-bukan-rahasia';

const escapeXml = (text) => text.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function createMockProvider(paymentConfig) {
  const serverKey = paymentConfig.serverKey || MOCK_DEFAULT_SERVER_KEY;
  return {
    name: 'mock',
    mode: 'mock',
    serverKey, // hanya mock yang mengekspos ini (dipakai skrip simulasi); kunci asli tidak pernah diekspos
    capabilities: { statusApi: false },

    async createQris({ providerOrderId }) {
      return { transactionId: `mock-${crypto.randomUUID()}`, qrUrl: `mock://${providerOrderId}`, qrString: null };
    },

    async getStatus() {
      throw new Error('Mode MOCK tidak punya API status.');
    },

    async expire() {
      return { statusCode: null };
    },

    async fetchQrImage(qrUrl) {
      const label = escapeXml(String(qrUrl).replace('mock://', ''));
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" role="img" aria-label="QRIS contoh (mode uji), bukan kode pembayaran asli">' +
        '<rect width="300" height="300" fill="#ffffff"/><rect x="10" y="10" width="280" height="280" fill="none" stroke="#b00020" stroke-width="6" stroke-dasharray="14 8"/>' +
        '<text x="150" y="120" text-anchor="middle" font-family="Arial,sans-serif" font-size="46" font-weight="700" fill="#b00020">MOCK</text>' +
        '<text x="150" y="160" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="#222">BUKAN QRIS SAH</text>' +
        '<text x="150" y="190" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#222">Tidak bisa dipindai / dibayar</text>' +
        `<text x="150" y="250" text-anchor="middle" font-family="monospace" font-size="12" fill="#555">${label}</text></svg>`;
      return { contentType: 'image/svg+xml', buffer: Buffer.from(svg, 'utf8') };
    },

    verifyNotification(body) {
      return verifyMidtransSignature(body, serverKey);
    },
    normalizeNotification: normalizeStatusPayload,
  };
}
