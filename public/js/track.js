// Halaman "Lacak Pesanan": status pesanan + pembayaran QRIS.
//
// Prinsip keamanan & kejujuran:
//  1. Akses memakai token acak di FRAGMENT URL (#...) yang dikirim lewat body POST, atau nomor pesanan + nomor
//     WhatsApp. Token tidak pernah masuk query string, sehingga tidak ikut tercatat di log server/referrer.
//  2. "Lunas" hanya ditampilkan jika SERVER melaporkan payment_status = paid (yang pada gilirannya hanya terjadi
//     setelah notifikasi gateway yang tanda tangannya valid + konfirmasi status). Browser tidak pernah menentukan lunas.
//  3. Memuat ulang halaman hanya MEMBACA status. Tidak ada pesanan atau pembayaran baru yang dibuat kecuali pelanggan
//     menekan tombol "Buat Kode QRIS Baru" (dan server memastikan hanya ada satu pembayaran menunggu per pesanan).
//  4. Gambar QR berasal dari gateway (diambil server dan dikirim sebagai data URI). Tidak ada QR buatan sendiri.
import { ApiError, checkPayment, getConfig, getTrackingQr, retryPayment, trackOrder } from "./api.js";
import { formatDateTime, formatRupiah, h } from "./format.js";
import { initNavigation } from "./site.js";
import { refreshIcons, showToast } from "./ui.js";
import { buildWhatsappLink } from "./whatsapp.js";

const $ = (selector) => document.querySelector(selector);

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const POLL_FAST_MS = 5000; // saat menunggu pembayaran
const POLL_SLOW_MS = 30000; // saat pesanan masih berjalan
const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled"]);
const FULFILLMENT_TEXT = { pickup: "Ambil sendiri di toko", delivery: "Diantar" };
// Nama ramah untuk kode status pada riwayat (jenis "status" = status pesanan, "payment" = status pembayaran).
const EVENT_TITLE = { created: "Pesanan dibuat", status: "Status pesanan", payment: "Pembayaran" };
const ORDER_STATUS_TEXT = {
  pending: "Menunggu konfirmasi",
  confirmed: "Dikonfirmasi",
  preparing: "Sedang disiapkan",
  ready: "Siap diambil/diantar",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};
const PAYMENT_STATUS_TEXT = {
  unpaid: "Belum dibayar",
  pending: "Menunggu pembayaran",
  paid: "Lunas",
  failed: "Gagal",
  expired: "Kedaluwarsa",
  cancelled: "Dibatalkan",
  refunded: "Dikembalikan",
};

const state = {
  lookup: null, // { token } atau { order_number, phone }
  view: null, // respons terakhir dari server
  config: null,
  loadSeq: 0, // untuk mengabaikan respons lama yang datang terlambat
  pollTimer: null,
  countdownTimer: null,
  expiryReloaded: false,
  qr: { key: null, dataUri: null, loading: false, error: null },
  busy: { retry: false, check: false },
  firstLoadDone: false,
};

// ------------------------------------------------------------------ tampilan dasar
const SECTIONS = ["#track-loading", "#track-error", "#track-lookup", "#track-result"];
function showOnly(selector) {
  for (const id of SECTIONS) $(id).hidden = id !== selector;
}

function fillBrand(name) {
  const words = name.trim().split(/\s+/);
  const last = words.pop();
  const box = $("#logo-text");
  box.textContent = "";
  if (words.length > 0) box.append(`${words.join(" ")} `);
  box.append(h("span", { text: last }));
  document.title = `Lacak Pesanan — ${name}`;
}

function showError({ title, message, canRetry = true, canLookup = false }) {
  stopTimers();
  $("#track-error-title").textContent = title;
  $("#track-error-message").textContent = message;
  $("#track-error-retry").hidden = !canRetry;
  $("#track-error-lookup").hidden = !canLookup;
  showOnly("#track-error");
  refreshIcons();
}

function showLookup(message) {
  stopTimers();
  const alert = $("#lookup-alert");
  alert.textContent = message ?? "";
  alert.hidden = !message;
  showOnly("#track-lookup");
  $("#lookup-number").focus();
}

function paymentMethodLabel(value) {
  return state.config?.ordering.payment_methods.find((entry) => entry.value === value)?.label ?? value;
}

// ------------------------------------------------------------------ pemuatan data
function stopTimers() {
  clearTimeout(state.pollTimer);
  clearInterval(state.countdownTimer);
  state.pollTimer = null;
  state.countdownTimer = null;
}

/** Interval pembaruan otomatis (null = berhenti). */
function pollInterval(view) {
  const { order, payment } = view;
  if (order.payment_method === "qris" && order.payment_status === "pending" && payment) return POLL_FAST_MS;
  if (TERMINAL_ORDER_STATUSES.has(order.order_status)) return null;
  return POLL_SLOW_MS;
}

function schedulePoll() {
  clearTimeout(state.pollTimer);
  const interval = state.view ? pollInterval(state.view) : null;
  if (interval === null) return;
  state.pollTimer = setTimeout(() => {
    // Tab yang tidak terlihat tidak perlu membebani server; akan memuat ulang saat tab terlihat lagi.
    if (document.hidden) return;
    load({ silent: true });
  }, interval);
}

function applyView(view) {
  state.view = view;
  state.firstLoadDone = true;
  render();
  schedulePoll();
}

async function load({ silent = false } = {}) {
  if (!state.lookup) return;
  const seq = ++state.loadSeq;
  if (!silent) {
    stopTimers();
    showOnly("#track-loading");
  }
  try {
    const view = await trackOrder(state.lookup);
    if (seq !== state.loadSeq) return;
    $("#pay-feedback").textContent = "";
    applyView(view);
  } catch (error) {
    if (seq !== state.loadSeq) return;
    handleLoadError(error, silent);
  }
}

function handleLoadError(error, silent) {
  if (silent && state.view) {
    // Gangguan sementara saat pembaruan otomatis: tampilan lama dipertahankan dan dicoba lagi.
    setFeedback("Koneksi terganggu. Mencoba memperbarui lagi…", "err");
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => load({ silent: true }), POLL_FAST_MS * 2);
    return;
  }
  const code = error instanceof ApiError ? error.code : "UNKNOWN";
  if (code === "NOT_FOUND") {
    showError({
      title: "Pesanan tidak ditemukan",
      message: "Tautan pelacakan tidak valid atau pesanan tidak ada. Anda bisa mencarinya dengan nomor pesanan dan nomor WhatsApp.",
      canRetry: false,
      canLookup: true,
    });
    return;
  }
  if (code === "RATE_LIMITED") {
    showError({ title: "Terlalu banyak permintaan", message: error.message, canRetry: true });
    return;
  }
  showError({
    title: "Pesanan belum bisa dimuat",
    message: error instanceof ApiError ? error.message : "Terjadi kesalahan tak terduga. Silakan coba lagi.",
    canRetry: true,
    canLookup: Boolean(state.lookup?.token),
  });
}

function setFeedback(message, tone = "") {
  const box = $("#pay-feedback");
  box.textContent = message;
  box.classList.toggle("err", tone === "err");
  box.classList.toggle("ok", tone === "ok");
}

// ------------------------------------------------------------------ render
/** Mengisi "pil" status: warna mengikuti kode status, teks memakai label dari server. */
function setPill(element, status, label) {
  element.className = `pill pill-${status}`;
  element.textContent = label ?? status;
}

function render() {
  const { view } = state;
  const { order } = view;
  showOnly("#track-result");

  $("#track-number").textContent = order.order_number;
  const meta = [
    `Dibuat ${formatDateTime(order.created_at)}`,
    FULFILLMENT_TEXT[order.fulfillment_method] ?? order.fulfillment_method,
    paymentMethodLabel(order.payment_method),
  ].filter(Boolean);
  $("#track-meta").textContent = `${order.customer_name} · ${meta.join(" · ")}`;

  setPill($("#pay-status-pill"), order.payment_status, view.labels.payment_status);
  setPill($("#order-status-pill"), `order-${order.order_status}`, view.labels.order_status);

  renderPayPanel();
  renderSummary();
  renderTimeline();
  renderWhatsapp();
  refreshIcons();
}

function renderSummary() {
  const { order } = state.view;
  $("#track-items").replaceChildren(
    ...order.items.map((item) =>
      h("li", {}, h("span", { text: `${item.quantity}× ${item.name}` }), h("span", { text: formatRupiah(item.line_total) })),
    ),
  );
  $("#track-subtotal").textContent = formatRupiah(order.subtotal);
  const isDelivery = order.fulfillment_method === "delivery";
  $("#track-fee-row").hidden = !isDelivery;
  $("#track-fee").textContent = formatRupiah(order.delivery_fee);
  $("#track-discount-row").hidden = !(order.discount > 0);
  $("#track-discount").textContent = `−${formatRupiah(order.discount)}`;
  $("#track-total").textContent = formatRupiah(order.total);
  $("#track-fulfillment").textContent = isDelivery
    ? `Diantar ke: ${order.delivery_address}`
    : "Ambil sendiri di toko.";
  if (order.cancel_reason) $("#track-fulfillment").textContent += `\nAlasan pembatalan: ${order.cancel_reason}`;
}

function renderTimeline() {
  const { timeline } = state.view;
  $("#track-timeline").replaceChildren(
    ...timeline.map((entry) =>
      h("li", {}, h("span", { class: "timeline-time", text: formatDateTime(entry.at) }), h("span", { class: "timeline-text", text: describeEvent(entry) })),
    ),
  );
  $("#timeline-title").closest("section").hidden = timeline.length === 0;
}

function describeEvent(entry) {
  if (entry.type === "created") return EVENT_TITLE.created;
  const names = entry.type === "payment" ? PAYMENT_STATUS_TEXT : ORDER_STATUS_TEXT;
  return `${EVENT_TITLE[entry.type] ?? "Pembaruan"}: ${names[entry.to] ?? entry.to}`;
}

function renderWhatsapp() {
  const link = state.config ? buildWhatsappLink(state.config, state.view.order) : null;
  const button = $("#track-whatsapp");
  button.hidden = !link;
  if (link) button.href = link;
}

// ------------------------------------------------------------------ panel pembayaran QRIS
function renderPayPanel() {
  const { order, payment } = state.view;
  const panel = $("#pay-panel");
  if (order.payment_method !== "qris") {
    panel.hidden = true;
    clearInterval(state.countdownTimer);
    return;
  }
  panel.hidden = false;

  // Peringatan jika bukan mode produksi: pelanggan tidak boleh mengira ini uang sungguhan.
  const notice = $("#mode-notice");
  const mode = payment?.mode;
  notice.hidden = !(mode === "sandbox" || mode === "mock");
  notice.textContent =
    mode === "mock"
      ? "MODE SIMULASI: pembayaran ini bukan pembayaran sungguhan dan tidak memakai penyedia pembayaran asli."
      : mode === "sandbox"
        ? "MODE UJI COBA (sandbox): pembayaran ini tidak memakai uang sungguhan."
        : "";

  const body = $("#pay-body");
  clearInterval(state.countdownTimer);

  switch (order.payment_status) {
    case "pending":
      body.replaceChildren(...pendingBlock());
      startCountdown();
      loadQr();
      break;
    case "paid":
      body.replaceChildren(paidBlock());
      break;
    case "expired":
      body.replaceChildren(
        messageBlock({
          icon: "clock",
          tone: "warn",
          title: "Waktu pembayaran habis",
          text: "Pesanan ini dibatalkan otomatis karena belum dibayar. Jika Anda sudah terlanjur membayar, hubungi kami dengan nomor pesanan di atas. Untuk memesan lagi, silakan buat pesanan baru.",
        }),
      );
      break;
    case "failed":
    case "cancelled":
      body.replaceChildren(failedBlock());
      break;
    case "refunded":
      body.replaceChildren(
        messageBlock({ icon: "rotate-ccw", tone: "info", title: "Pembayaran dikembalikan", text: "Dana pembayaran ini sudah dikembalikan oleh pihak toko." }),
      );
      break;
    default:
      body.replaceChildren(noPaymentBlock());
  }
}

function messageBlock({ icon, tone, title, text, extra = [] }) {
  return h(
    "div",
    { class: `pay-message ${tone}` },
    h("i", { "data-feather": icon, "aria-hidden": "true" }),
    h("div", {}, h("h3", { text: title }), h("p", { text }), ...extra),
  );
}

function paidBlock() {
  const { order, payment } = state.view;
  const paidAt = payment?.paid_at ?? order.paid_at;
  if (order.order_status === "cancelled") {
    // Pembayaran masuk setelah pesanan dibatalkan (mis. terlambat bayar): jangan menjanjikan pesanan diproses.
    return messageBlock({
      icon: "alert-triangle",
      tone: "warn",
      title: "Pembayaran diterima, tetapi pesanan sudah dibatalkan",
      text: "Pembayaran Anda masuk setelah pesanan dibatalkan. Hubungi kami lewat WhatsApp dengan nomor pesanan ini agar kami bantu pengembalian dana atau pesanan ulang.",
    });
  }
  return messageBlock({
    icon: "check-circle",
    tone: "ok",
    title: "Pembayaran diterima",
    text: `Pembayaran ${formatRupiah(order.total)} sudah dikonfirmasi${paidAt ? ` pada ${formatDateTime(paidAt)}` : ""}. Pesanan Anda akan diproses oleh toko.`,
  });
}

function failedBlock() {
  const { order, payment } = state.view;
  const canRetry = payment?.can_retry === true;
  const text = order.payment_status === "cancelled" ? "Pembayaran QRIS ini dibatalkan." : "Pembayaran QRIS ini tidak berhasil.";
  const extra = [];
  if (canRetry) {
    extra.push(
      h("button", { type: "button", id: "pay-retry", class: "btn", onclick: handleRetry, text: state.busy.retry ? "Membuat kode…" : "Buat Kode QRIS Baru", disabled: state.busy.retry ? true : null }),
    );
  }
  return messageBlock({
    icon: "x-circle",
    tone: "danger",
    title: "Pembayaran belum berhasil",
    text: canRetry
      ? `${text} Pesanan Anda masih tersimpan; buat kode QRIS baru untuk mencoba lagi sebelum batas waktu habis.`
      : `${text} Pesanan ini sudah tidak bisa dibayar. Silakan buat pesanan baru atau hubungi kami.`,
    extra,
  });
}

/** Pesanan QRIS yang belum punya pembayaran (mis. gateway sempat tidak bisa dihubungi saat checkout). */
function noPaymentBlock() {
  const { order } = state.view;
  const open = order.order_status === "pending";
  return messageBlock({
    icon: "alert-circle",
    tone: "warn",
    title: "Kode QRIS belum dibuat",
    text: open
      ? "Pembuatan kode QRIS belum berhasil. Pesanan Anda tetap tersimpan; tekan tombol di bawah untuk membuat kode QRIS."
      : "Pesanan ini sudah tidak bisa dibayar.",
    extra: open
      ? [h("button", { type: "button", id: "pay-retry", class: "btn", onclick: handleRetry, text: state.busy.retry ? "Membuat kode…" : "Buat Kode QRIS", disabled: state.busy.retry ? true : null })]
      : [],
  });
}

function pendingBlock() {
  const { order, payment } = state.view;
  const expires = payment?.expires_at ? new Date(payment.expires_at) : null;
  return [
    h("p", { class: "pay-amount-label", text: "Total yang harus dibayar" }),
    h("p", { class: "pay-amount", text: formatRupiah(payment?.amount ?? order.total) }),
    h("div", { id: "qr-box", class: "qr-box", "aria-live": "polite" }),
    h("p", { class: "pay-steps", text: "Buka aplikasi bank atau e-wallet Anda, pilih Bayar/Scan QRIS, lalu pindai kode di atas. Jumlah akan terisi otomatis." }),
    expires
      ? h(
          "p",
          { class: "pay-expiry" },
          `Bayar sebelum ${formatDateTime(expires)} · `,
          h("strong", { id: "pay-countdown", dataset: { expires: String(expires.getTime()) }, text: "" }),
        )
      : null,
    h("p", { class: "field-hint", text: "Halaman ini memperbarui status otomatis setiap beberapa detik. Anda tidak perlu menekan apa pun setelah membayar." }),
    h("div", { class: "form-actions pay-actions" }, h("button", { type: "button", id: "pay-check", class: "btn-secondary", onclick: handleCheck, text: state.busy.check ? "Memeriksa…" : "Saya sudah bayar — cek status", disabled: state.busy.check ? true : null })),
  ];
}

// ------------------------------------------------------------------ hitung mundur
function startCountdown() {
  const element = $("#pay-countdown");
  if (!element) return;
  const expiresAt = Number(element.dataset.expires);
  state.expiryReloaded = false;

  const tick = () => {
    const box = $("#pay-countdown");
    if (!box) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      box.textContent = "waktu habis, memeriksa status…";
      clearInterval(state.countdownTimer);
      // Satu kali muat ulang: server yang menentukan apakah pembayaran benar-benar kedaluwarsa.
      if (!state.expiryReloaded) {
        state.expiryReloaded = true;
        setTimeout(() => load({ silent: true }), 2500);
      }
      return;
    }
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    box.textContent = `sisa ${minutes}:${seconds}`;
  };
  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------------ gambar QR dari gateway
function qrKey() {
  const { order, payment } = state.view;
  return `${order.order_number}|${payment?.expires_at ?? ""}|${payment?.amount ?? ""}`;
}

function drawQr() {
  const box = $("#qr-box");
  if (!box) return;
  const { payment } = state.view;
  if (!payment?.qr_ready) {
    box.replaceChildren(h("p", { class: "qr-placeholder", text: "Kode QR sedang disiapkan…" }));
    return;
  }
  if (state.qr.dataUri && state.qr.key === qrKey()) {
    box.replaceChildren(
      h("img", {
        class: "qr-img",
        src: state.qr.dataUri,
        alt: `Kode QRIS untuk pembayaran pesanan ${state.view.order.order_number}`,
        width: 260,
        height: 260,
      }),
    );
    return;
  }
  if (state.qr.error && state.qr.key === qrKey()) {
    box.replaceChildren(
      h("p", { class: "qr-placeholder", text: state.qr.error }),
      h("button", { type: "button", class: "btn-secondary", text: "Muat ulang kode QR", onclick: () => { state.qr = { key: null, dataUri: null, loading: false, error: null }; loadQr(); } }),
    );
    return;
  }
  box.replaceChildren(h("p", { class: "qr-placeholder", text: "Memuat kode QR…" }));
}

async function loadQr() {
  const { payment } = state.view;
  const key = qrKey();
  if (!payment?.qr_ready) {
    drawQr();
    return;
  }
  if ((state.qr.key === key && (state.qr.dataUri || state.qr.loading)) || (state.qr.key === key && state.qr.error)) {
    drawQr();
    return;
  }
  state.qr = { key, dataUri: null, loading: true, error: null };
  drawQr();
  try {
    const { data_uri: dataUri } = await getTrackingQr(state.lookup);
    // Hanya data:image/* yang dipakai sebagai gambar.
    if (typeof dataUri !== "string" || !/^data:image\/(png|jpeg|gif|svg\+xml);base64,/.test(dataUri)) {
      throw new ApiError({ code: "BAD_RESPONSE", message: "Gambar QR dari server tidak valid." });
    }
    if (state.qr.key === key) state.qr = { key, dataUri, loading: false, error: null };
  } catch (error) {
    if (error instanceof ApiError && error.code === "QR_NOT_ACTIVE") {
      // Kode sudah tidak aktif (dibayar/kedaluwarsa di antara dua polling): ambil status terbaru.
      state.qr = { key, dataUri: null, loading: false, error: "Kode QRIS ini sudah tidak aktif." };
      load({ silent: true });
    } else if (state.qr.key === key) {
      state.qr = { key, dataUri: null, loading: false, error: error instanceof ApiError ? error.message : "Kode QR belum bisa dimuat." };
    }
  }
  drawQr();
}

// ------------------------------------------------------------------ tindakan pelanggan
async function handleRetry() {
  if (state.busy.retry) return;
  state.busy.retry = true;
  setFeedback("");
  renderPayPanel();
  try {
    // Server memastikan hanya ada SATU pembayaran menunggu per pesanan, jadi tekan berulang tidak menggandakan.
    applyView(await retryPayment(state.lookup));
    state.qr = { key: null, dataUri: null, loading: false, error: null };
    setFeedback("Kode QRIS baru dibuat.", "ok");
  } catch (error) {
    setFeedback(error instanceof ApiError ? error.message : "Gagal membuat kode QRIS. Coba lagi.", "err");
  } finally {
    state.busy.retry = false;
    if (state.view) renderPayPanel();
  }
}

async function handleCheck() {
  if (state.busy.check) return;
  state.busy.check = true;
  setFeedback("");
  renderPayPanel();
  try {
    const { check, ...view } = await checkPayment(state.lookup);
    applyView(view);
    if (view.order.payment_status === "paid") setFeedback("Pembayaran sudah diterima.", "ok");
    else if (check?.reason === "throttled") setFeedback("Status baru saja diperiksa. Tunggu beberapa detik lalu coba lagi.");
    else if (check?.reason === "unsupported") setFeedback("Pemeriksaan manual tidak tersedia. Status akan diperbarui otomatis setelah pembayaran terkonfirmasi.");
    else if (check?.checked && check.found === false) setFeedback("Belum ada pembayaran yang tercatat di penyedia pembayaran. Jika Anda baru membayar, tunggu sebentar.");
    else if (view.order.payment_status === "pending") setFeedback("Pembayaran belum diterima. Status diperiksa ke penyedia pembayaran barusan.");
  } catch (error) {
    setFeedback(error instanceof ApiError ? error.message : "Gagal memeriksa status. Coba lagi.", "err");
  } finally {
    state.busy.check = false;
    if (state.view) renderPayPanel();
  }
}

async function copyNumber() {
  const number = $("#track-number").textContent;
  try {
    await navigator.clipboard.writeText(number);
    showToast("Nomor pesanan disalin.");
  } catch {
    showToast("Tidak bisa menyalin otomatis. Salin nomor pesanan secara manual.", { error: true });
  }
}

// ------------------------------------------------------------------ formulir cari manual
function showLookupErrors(fields = {}) {
  const map = { order_number: ["#lookup-number", "#lookup-number-error"], phone: ["#lookup-phone", "#lookup-phone-error"] };
  for (const [key, [input, error]] of Object.entries(map)) {
    $(error).textContent = fields[key] ?? "";
    $(error).closest(".field").classList.toggle("has-error", Boolean(fields[key]));
    if (fields[key]) $(input).setAttribute("aria-invalid", "true");
    else $(input).removeAttribute("aria-invalid");
  }
}

async function handleLookupSubmit(event) {
  event.preventDefault();
  const button = $("#lookup-submit");
  if (button.disabled) return;
  const orderNumber = $("#lookup-number").value.trim().toUpperCase();
  const phone = $("#lookup-phone").value.trim();
  const errors = {};
  if (!/^RB-\d{6}-[A-Z0-9]{5}$/.test(orderNumber)) errors.order_number = "Nomor pesanan tidak valid. Contoh: RB-261009-K7P2M";
  if (!phone) errors.phone = "Isi nomor WhatsApp yang dipakai saat memesan.";
  showLookupErrors(errors);
  $("#lookup-alert").hidden = true;
  if (Object.keys(errors).length > 0) return;

  button.disabled = true;
  button.textContent = "Mencari…";
  const seq = ++state.loadSeq;
  try {
    const view = await trackOrder({ order_number: orderNumber, phone });
    if (seq !== state.loadSeq) return;
    state.lookup = { order_number: orderNumber, phone }; // hanya di memori halaman ini (tidak disimpan di browser)
    state.qr = { key: null, dataUri: null, loading: false, error: null };
    applyView(view);
  } catch (error) {
    if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
      showLookupErrors(error.details?.fields ?? {});
    }
    const alert = $("#lookup-alert");
    alert.textContent = error instanceof ApiError ? error.message : "Terjadi kesalahan tak terduga. Silakan coba lagi.";
    alert.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Lacak Pesanan";
  }
}

// ------------------------------------------------------------------ inisialisasi
function readTokenFromHash() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { token: null, invalid: false };
  return TOKEN_PATTERN.test(raw) ? { token: raw, invalid: false } : { token: null, invalid: true };
}

async function init() {
  initNavigation();
  $("#track-copy").addEventListener("click", copyNumber);
  $("#lookup-form").addEventListener("submit", handleLookupSubmit);
  $("#track-error-retry").addEventListener("click", () => load());
  $("#track-error-lookup").addEventListener("click", () => showLookup());

  // Muat ulang segera saat tab kembali terlihat (polling dihentikan selama tab tersembunyi).
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.view && state.lookup) load({ silent: true });
  });
  // Tautan diganti manual (mis. tempel token lain) tanpa memuat ulang halaman.
  window.addEventListener("hashchange", () => {
    const { token } = readTokenFromHash();
    if (token) {
      state.lookup = { token };
      state.qr = { key: null, dataUri: null, loading: false, error: null };
      load();
    }
  });

  // Konfigurasi bisnis (nama, nomor WhatsApp) tidak wajib: halaman tetap berfungsi tanpanya.
  const configPromise = getConfig()
    .then((config) => {
      state.config = config;
      fillBrand(config.business.name);
      if (config.business.logo_image) {
        const logo = $("#logo-img");
        logo.src = config.business.logo_image;
        logo.hidden = false;
      }
      if (state.view) render();
    })
    .catch(() => {});

  const { token, invalid } = readTokenFromHash();
  if (token) {
    state.lookup = { token };
    await load();
  } else {
    showLookup(invalid ? "Tautan pelacakan tidak valid. Cari dengan nomor pesanan dan nomor WhatsApp Anda." : null);
  }
  await configPromise;
  refreshIcons();
}

init();
