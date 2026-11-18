// Formulir kontak: pesan benar-benar dikirim ke server dan disimpan di database (dibaca admin di dashboard).
import { ApiError, sendContactMessage } from "./api.js";
import { normalizePhone } from "./format.js";

const $ = (selector) => document.querySelector(selector);
const FIELDS = ["name", "email", "phone", "message"];

let sending = false;

function clearErrors() {
  for (const field of FIELDS) {
    $(`#contact-${field}-error`).textContent = "";
    $(`#contact-${field}`).removeAttribute("aria-invalid");
  }
}

function setError(field, message) {
  const errorEl = $(`#contact-${field}-error`);
  if (!errorEl) return false;
  errorEl.textContent = message;
  $(`#contact-${field}`).setAttribute("aria-invalid", "true");
  return true;
}

function setFeedback(message, ok) {
  const feedback = $("#contact-feedback");
  feedback.textContent = message;
  feedback.classList.toggle("ok", ok === true);
  feedback.classList.toggle("err", ok === false);
}

async function handleSubmit(event) {
  event.preventDefault();
  if (sending) return;
  clearErrors();
  setFeedback("", null);

  const name = $("#contact-name").value.trim();
  const email = $("#contact-email").value.trim();
  const phoneRaw = $("#contact-phone").value.trim();
  const message = $("#contact-message").value.trim();

  const errors = {};
  if (name.length < 2) errors.name = "Nama minimal 2 karakter.";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Format email tidak valid.";
  if (phoneRaw && !normalizePhone(phoneRaw)) errors.phone = "Nomor tidak valid. Contoh: 081234567890";
  if (message.length < 5) errors.message = "Pesan minimal 5 karakter.";

  const keys = Object.keys(errors);
  if (keys.length > 0) {
    for (const key of keys) setError(key, errors[key]);
    $(`#contact-${keys[0]}`).focus();
    return;
  }

  sending = true;
  const button = $("#contact-submit");
  button.disabled = true;
  button.textContent = "Mengirim…";
  try {
    await sendContactMessage({
      name,
      email,
      phone: phoneRaw,
      message,
      website: $("#contact-website").value, // jebakan bot: manusia membiarkannya kosong
    });
    $("#contact-form").reset();
    setFeedback("Pesan terkirim. Terima kasih, kami akan segera membalasnya.", true);
  } catch (error) {
    if (error instanceof ApiError && error.code === "VALIDATION_ERROR" && error.details?.fields) {
      let shown = false;
      for (const [key, text] of Object.entries(error.details.fields)) shown = setError(key, text) || shown;
      setFeedback(shown ? "Periksa kembali isian yang ditandai." : error.message, false);
    } else {
      setFeedback(error.message ?? "Pesan gagal dikirim. Silakan coba lagi.", false);
    }
  } finally {
    sending = false;
    button.disabled = false;
    button.textContent = "Kirim Pesan";
  }
}

export function initContact() {
  $("#contact-form").addEventListener("submit", handleSubmit);
}
