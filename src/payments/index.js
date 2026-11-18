// Memilih penyedia pembayaran dari konfigurasi.
import { createMidtransProvider } from './midtransProvider.js';
import { createMockProvider } from './mockProvider.js';

/** @returns {object|null} null = QRIS tidak aktif (PAYMENT_PROVIDER kosong) */
export function createPaymentProvider(paymentConfig) {
  if (!paymentConfig.enabled) return null;
  if (paymentConfig.provider === 'midtrans') return createMidtransProvider(paymentConfig);
  if (paymentConfig.provider === 'mock') return createMockProvider(paymentConfig);
  throw new Error(`PAYMENT_PROVIDER "${paymentConfig.provider}" tidak dikenal.`);
}
