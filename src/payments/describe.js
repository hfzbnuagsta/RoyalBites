// Ringkasan konfigurasi pembayaran untuk dashboard admin. TIDAK memuat kunci rahasia apa pun.
export const WEBHOOK_PATH = '/api/payments/midtrans/notification';

export function describePaymentConfig(config, provider) {
  const settings = config.payment;
  const webhookUrl = settings.webhookUrl || (config.appOrigins[0] ? `${config.appOrigins[0]}${WEBHOOK_PATH}` : null);
  const warnings = [];

  if (!provider) {
    warnings.push('QRIS belum aktif: isi PAYMENT_PROVIDER dan kunci gateway di file .env server, lalu restart. Lihat README bagian "Pembayaran QRIS".');
  } else {
    if (provider.mode === 'mock') warnings.push('MODE MOCK: hanya untuk uji coba. Kode QR bukan QRIS sah dan tidak bisa dibayar.');
    if (provider.mode === 'sandbox') warnings.push('MODE SANDBOX: pembayaran hanya simulasi di Midtrans, tidak ada uang sungguhan.');
    if (!webhookUrl) {
      warnings.push('PAYMENT_WEBHOOK_URL / APP_ORIGIN belum diisi: daftarkan URL notifikasi di dashboard Midtrans agar pesanan otomatis lunas.');
    } else if (!webhookUrl.startsWith('https://') && provider.mode === 'live') {
      warnings.push('URL notifikasi untuk mode live harus HTTPS.');
    }
  }
  return {
    configured: Boolean(provider),
    provider: provider?.name ?? null,
    mode: provider?.mode ?? null,
    webhook_url: webhookUrl,
    webhook_path: WEBHOOK_PATH,
    expiry_minutes: settings.qrisExpiryMinutes,
    verify_with_status_api: settings.verifyWithStatusApi,
    warnings,
  };
}
