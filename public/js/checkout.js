// Checkout: formulir pemesanan -> kirim ke server -> tampilkan hasil.
// Prinsip penting:
//  1. "Berhasil" HANYA ditampilkan setelah server membalas 201/200 berisi nomor pesanan (artinya sudah
//     tersimpan di database). Tidak ada keberhasilan palsu.
//  2. Harga di layar hanya perkiraan. Server menghitung ulang semuanya dari database.
//  3. Kunci idempotensi (UUID) mencegah pesanan ganda saat tombol ditekan berulang atau saat koneksi putus
//     lalu dicoba lagi: permintaan yang sama selalu menghasilkan SATU pesanan.
//  4. QRIS: pelanggan dialihkan ke halaman lacak (/track.html#token) untuk memindai kode QR dari gateway.
//     "Lunas" hanya ditampilkan di sana setelah server mengonfirmasinya, bukan di sini.
import { ApiError, createOrder } from "./api.js";
import { addCartNotices, closeCart, getCheckoutBlocker, openCart } from "./cart.js";
import { formatRupiah, h, newUuid, normalizePhone } from "./format.js";
import { buildWhatsappLink } from "./whatsapp.js";
import {
  applyServerProblems,
  clearCart,
  getCartItems,
  getCartLines,
  getCartSubtotal,
  loadCatalog,
  loadConfig,
  store,
} from "./state.js";
import { closeDialog, openDialog, refreshIcons, showToast } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

// Pemetaan nama field dari server -> elemen di formulir.
const FIELD_MAP = {
  customer_name: { input: "#co-name", error: "#co-name-error" },
  customer_phone: { input: "#co-phone", error: "#co-phone-error" },
  delivery_address: { input: "#co-address", error: "#co-address-error" },
  customer_notes: { input: "#co-notes", error: "#co-notes-error" },
  fulfillment_method: { input: "#co-fulfillment-options input", error: "#co-fulfillment-error" },
  payment_method: { input: "#co-payment-options input", error: "#co-payment-error" },
};

let submitting = false;
let opening = false;
let idempotencyKey = null;
let keyFingerprint = "";

// ------------------------------------------------------------------ pilihan (radio)
function renderChoices(containerSelector, name, options, currentValue) {
  const container = $(containerSelector);
  const selected = options.some((option) => option.value === currentValue) ? currentValue : options[0]?.value;
  container.replaceChildren(
    ...options.map((option) =>
      h(
        "label",
        { class: "choice" },
        h("input", { type: "radio", name, value: option.value, checked: option.value === selected ? true : null }),
        h("span", { text: option.label }),
      ),
    ),
  );
}

const selectedValue = (name) => document.querySelector(`#checkout-form input[name="${name}"]:checked`)?.value ?? "";

function buildChoices() {
  const { ordering } = store.config;
  renderChoices("#co-fulfillment-options", "fulfillment_method", ordering.fulfillment_methods, selectedValue("fulfillment_method"));
  renderChoices("#co-payment-options", "payment_method", ordering.payment_methods, selectedValue("payment_method"));
}

/** Penjelasan singkat QRIS + peringatan jelas jika bukan mode produksi (uang tidak sungguhan). */
function qrisInstructions(method) {
  const lines = [
    `Kode QRIS dibuat setelah pesanan dikirim dan berlaku ${method.expiry_minutes} menit. Pindai dengan aplikasi bank atau e-wallet apa pun.`,
  ];
  if (method.mode === "sandbox") lines.push("MODE UJI COBA (sandbox): pembayaran ini tidak memakai uang sungguhan.");
  if (method.mode === "mock") lines.push("MODE SIMULASI: bukan pembayaran sungguhan.");
  return lines.join("\n");
}

// ------------------------------------------------------------------ ringkasan & total
function currentTotals() {
  const subtotal = getCartSubtotal();
  const isDelivery = selectedValue("fulfillment_method") === "delivery";
  const fee = isDelivery ? store.config.ordering.delivery_fee : 0;
  return { subtotal, fee, isDelivery, total: subtotal + fee };
}

function updateDerived() {
  const { ordering } = store.config;
  const { subtotal, fee, isDelivery, total } = currentTotals();

  // Alamat hanya relevan untuk pengantaran.
  $("#co-address-field").hidden = !isDelivery;
  const hint = $("#co-delivery-hint");
  const hintParts = [];
  if (isDelivery) {
    if (ordering.delivery_area) hintParts.push(`Area pengantaran: ${ordering.delivery_area}.`);
    hintParts.push(`Ongkos kirim ${formatRupiah(ordering.delivery_fee)}.`);
  }
  hint.textContent = hintParts.join(" ");
  hint.hidden = hintParts.length === 0;

  // Petunjuk pembayaran (mis. nomor rekening) untuk metode yang dipilih.
  const method = ordering.payment_methods.find((entry) => entry.value === selectedValue("payment_method"));
  const instructions = method?.value === "qris" ? qrisInstructions(method) : (method?.instructions ?? "");
  const info = $("#co-payment-info");
  info.textContent = instructions;
  info.hidden = !instructions;

  // Daftar item
  $("#co-summary-items").replaceChildren(
    ...getCartLines().map((line) =>
      h(
        "li",
        {},
        h("span", { text: `${line.qty}× ${line.product?.name ?? "Menu tidak tersedia"}` }),
        h("span", { text: formatRupiah(line.lineTotal) }),
      ),
    ),
  );
  $("#co-subtotal").textContent = formatRupiah(subtotal);
  $("#co-fee-row").hidden = !isDelivery;
  $("#co-fee").textContent = formatRupiah(fee);
  $("#co-total").textContent = formatRupiah(total);
}

// ------------------------------------------------------------------ pesan error
function clearErrors() {
  for (const { input, error } of Object.values(FIELD_MAP)) {
    const errorEl = $(error);
    errorEl.textContent = "";
    errorEl.closest(".field")?.classList.remove("has-error");
    for (const el of document.querySelectorAll(input)) el.removeAttribute("aria-invalid");
  }
  const alert = $("#checkout-alert");
  alert.hidden = true;
  alert.textContent = "";
}

function setFieldError(key, message) {
  const target = FIELD_MAP[key];
  if (!target) return false;
  const errorEl = $(target.error);
  errorEl.textContent = message;
  errorEl.closest(".field")?.classList.add("has-error");
  for (const el of document.querySelectorAll(target.input)) el.setAttribute("aria-invalid", "true");
  return true;
}

function showAlert(message, details = []) {
  const alert = $("#checkout-alert");
  alert.replaceChildren(h("p", { text: message }), details.length > 0 ? h("ul", {}, details.map((text) => h("li", { text }))) : null);
  alert.hidden = false;
  alert.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function focusFirstError() {
  const first = $("#checkout-form .field.has-error");
  first?.querySelector("input, textarea")?.focus();
}

// ------------------------------------------------------------------ validasi (kenyamanan; server tetap memvalidasi)
function collectAndValidate() {
  const errors = {};
  const name = $("#co-name").value.trim();
  const phoneRaw = $("#co-phone").value;
  const phone = normalizePhone(phoneRaw);
  const fulfillment = selectedValue("fulfillment_method");
  const payment = selectedValue("payment_method");
  const address = $("#co-address").value.trim();
  const notes = $("#co-notes").value.trim();

  if (name.length < 2) errors.customer_name = "Nama minimal 2 karakter.";
  if (!phone) errors.customer_phone = "Nomor WhatsApp tidak valid. Contoh: 081234567890";
  if (!fulfillment) errors.fulfillment_method = "Pilih cara pengambilan.";
  if (fulfillment === "delivery" && address.length < 10) errors.delivery_address = "Alamat pengantaran wajib diisi lengkap (minimal 10 karakter).";
  if (notes.length > 500) errors.customer_notes = "Catatan maksimal 500 karakter.";
  if (!payment) errors.payment_method = "Pilih metode pembayaran.";

  const { total, isDelivery } = currentTotals();
  const payload = {
    items: getCartItems().map((item) => ({ product_id: item.id, quantity: item.qty })),
    customer_name: name,
    customer_phone: phone ?? phoneRaw,
    fulfillment_method: fulfillment,
    delivery_address: isDelivery ? address : null,
    customer_notes: notes || null,
    payment_method: payment,
    expected_total: total,
  };
  return { errors, payload };
}

// ------------------------------------------------------------------ pengiriman ke server
function setSubmitting(value) {
  submitting = value;
  const button = $("#co-submit");
  button.disabled = value;
  button.textContent = value ? "Menyimpan pesanan…" : "Buat Pesanan";
  $("#checkout-form").setAttribute("aria-busy", String(value));
}

async function refreshData() {
  try {
    await Promise.all([loadConfig(), loadCatalog()]);
  } catch {
    // Jika gagal, biarkan data lama; server tetap memvalidasi.
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  if (submitting) return; // klik berulang diabaikan selama permintaan berjalan

  clearErrors();
  const { errors, payload } = collectAndValidate();
  const errorKeys = Object.keys(errors);
  if (errorKeys.length > 0) {
    for (const key of errorKeys) setFieldError(key, errors[key]);
    showAlert("Periksa kembali isian yang ditandai.");
    focusFirstError();
    return;
  }

  // Kunci baru HANYA dibuat jika isi pesanan berubah. Mencoba ulang pesanan yang sama memakai kunci yang sama,
  // sehingga server tidak membuat pesanan ganda.
  const fingerprint = JSON.stringify(payload);
  if (!idempotencyKey || fingerprint !== keyFingerprint) {
    idempotencyKey = newUuid();
    keyFingerprint = fingerprint;
  }

  setSubmitting(true);
  try {
    const { order, tracking_token: trackingToken } = await createOrder({ ...payload, idempotency_key: idempotencyKey });
    showSuccess(order, trackingToken);
    clearCart();
    idempotencyKey = null;
    keyFingerprint = "";
    // QRIS: lanjut ke halaman lacak untuk memindai kode QR. Token ada di fragment URL (#), bukan di query,
    // sehingga tidak ikut terkirim ke server sebagai bagian URL dan tidak tercatat di log.
    if (order.payment_method === "qris" && trackingToken) {
      $("#co-submit").disabled = true;
      window.location.assign(trackingUrl(trackingToken));
    }
  } catch (error) {
    await handleError(error);
  } finally {
    setSubmitting(false);
  }
}

async function handleError(error) {
  if (!(error instanceof ApiError)) {
    showAlert("Terjadi kesalahan tak terduga. Pesanan belum dapat dipastikan tersimpan, silakan coba lagi.");
    return;
  }
  const details = error.details ?? {};

  switch (error.code) {
    case "VALIDATION_ERROR": {
      const leftovers = [];
      for (const [key, message] of Object.entries(details.fields ?? {})) {
        if (!setFieldError(key, message)) leftovers.push(message);
      }
      showAlert("Periksa kembali isian yang ditandai.", leftovers);
      focusFirstError();
      return;
    }
    case "CART_INVALID": {
      // Server menolak sebagian isi keranjang (stok habis/berubah, menu dihapus). Sesuaikan keranjang.
      const messages = applyServerProblems(details.problems ?? []);
      await refreshData();
      addCartNotices(messages);
      if (getCartItems().length === 0) {
        closeDialog($("#checkout-dialog"));
        showToast("Menu di keranjang sudah tidak tersedia. Keranjang dikosongkan.", { error: true });
        return;
      }
      updateDerived();
      showAlert(
        "Keranjang Anda sudah disesuaikan dengan stok terbaru. Periksa ringkasan lalu tekan “Buat Pesanan” lagi.",
        messages,
      );
      return;
    }
    case "PRICE_CHANGED":
      await refreshData();
      updateDerived();
      showAlert(error.message);
      return;
    case "ORDERS_CLOSED":
      await refreshData();
      $("#co-submit").disabled = true;
      showAlert(error.message);
      return;
    case "MIN_ORDER_NOT_MET":
      showAlert(error.message);
      return;
    case "IDEMPOTENCY_KEY_REUSED":
      idempotencyKey = null;
      showAlert(error.message);
      return;
    case "NETWORK":
    case "TIMEOUT":
      // Kunci idempotensi dipertahankan: jika pesanan sebenarnya sudah tersimpan, mencoba lagi tidak membuat pesanan ganda.
      showAlert(
        "Koneksi terputus saat mengirim pesanan, jadi kami belum bisa memastikan pesanan tersimpan. Tekan “Buat Pesanan” sekali lagi — pesanan yang sama tidak akan tercatat dua kali.",
      );
      return;
    default:
      showAlert(error.message);
  }
}

// ------------------------------------------------------------------ tampilan berhasil
const trackingUrl = (token) => `/track.html#${token}`;

function showSuccess(order, trackingToken) {
  $("#checkout-form").hidden = true;
  $("#checkout-success").hidden = false;

  $("#success-name").textContent = order.customer_name;
  $("#success-number").textContent = order.order_number;
  $("#success-items").replaceChildren(
    ...order.items.map((item) =>
      h("li", {}, h("span", { text: `${item.quantity}× ${item.name}` }), h("span", { text: formatRupiah(item.line_total) })),
    ),
  );
  $("#success-subtotal").textContent = formatRupiah(order.subtotal);
  const isDelivery = order.fulfillment_method === "delivery";
  $("#success-fee-row").hidden = !isDelivery;
  $("#success-fee").textContent = formatRupiah(order.delivery_fee);
  $("#success-total").textContent = formatRupiah(order.total);

  // Informasi pembayaran sesuai metode yang dipilih.
  const method = store.config.ordering.payment_methods.find((entry) => entry.value === order.payment_method);
  let paymentText = "";
  if (order.payment_method === "cod") {
    paymentText = `Pembayaran: tunai saat pesanan ${isDelivery ? "diterima" : "diambil"}.`;
  } else if (order.payment_method === "qris") {
    paymentText = `Pembayaran: QRIS sebesar ${formatRupiah(order.total)}. Status pembayaran akan ditampilkan di halaman lacak pesanan.`;
  } else {
    paymentText = `Pembayaran: transfer manual sebesar ${formatRupiah(order.total)}.\n${method?.instructions ?? ""}`.trim();
  }
  $("#success-payment").textContent = paymentText;

  // Tautan lacak membawa token rahasia pembuat pesanan (hanya dikirim server sekali ini).
  const track = $("#success-track");
  track.hidden = !trackingToken;
  if (trackingToken) {
    track.href = trackingUrl(trackingToken);
    track.textContent = order.payment_method === "qris" ? "Bayar & Lacak Pesanan" : "Lacak Pesanan";
  }

  const link = buildWhatsappLink(store.config, order);
  const whatsapp = $("#success-whatsapp");
  whatsapp.hidden = !link;
  if (link) whatsapp.href = link;

  refreshIcons();
  $("#success-title").focus();
}

async function copyOrderNumber() {
  const number = $("#success-number").textContent;
  try {
    await navigator.clipboard.writeText(number);
    showToast("Nomor pesanan disalin.");
  } catch {
    // Clipboard tidak tersedia: pilih teksnya agar bisa disalin manual.
    const range = document.createRange();
    range.selectNodeContents($("#success-number"));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    showToast("Nomor pesanan dipilih. Salin dengan Ctrl+C.");
  }
}

// ------------------------------------------------------------------ membuka checkout
function resetToForm() {
  $("#checkout-form").hidden = false;
  $("#checkout-success").hidden = true;
}

export async function openCheckout() {
  if (opening) return;
  opening = true;
  try {
    closeCart();
    await refreshData(); // pakai harga & stok terbaru sebelum pelanggan mengisi formulir

    const blocker = getCheckoutBlocker();
    if (blocker) {
      openCart();
      showToast(blocker, { error: true });
      return;
    }

    resetToForm();
    clearErrors();
    buildChoices();
    updateDerived();
    setSubmitting(false);
    openDialog($("#checkout-dialog"));
    $("#co-name").focus();
  } finally {
    opening = false;
  }
}

export function initCheckout() {
  const dialog = $("#checkout-dialog");
  const form = $("#checkout-form");

  form.addEventListener("submit", handleSubmit);
  form.addEventListener("change", (event) => {
    if (event.target.matches('input[type="radio"]')) updateDerived();
  });
  // Hapus pesan error sebuah field saat pengguna mulai memperbaikinya.
  form.addEventListener("input", (event) => {
    const field = event.target.closest(".field");
    if (field?.classList.contains("has-error")) {
      field.classList.remove("has-error");
      field.querySelector(".field-error").textContent = "";
      event.target.removeAttribute("aria-invalid");
    }
  });
  $("#copy-order-number").addEventListener("click", copyOrderNumber);

  // Jangan biarkan dialog tertutup (Esc / klik latar) saat pesanan sedang dikirim:
  // pelanggan harus melihat hasilnya.
  dialog.addEventListener("cancel", (event) => {
    if (submitting) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    if (submitting) {
      openDialog(dialog);
      return;
    }
    if (!$("#checkout-success").hidden) {
      form.reset();
      resetToForm();
    }
  });
}
