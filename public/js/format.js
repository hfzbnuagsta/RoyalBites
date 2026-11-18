// Fungsi bantu kecil yang dipakai banyak modul.

/** 15000 -> "Rp15.000" */
export function formatRupiah(value) {
  return `Rp${Number(value).toLocaleString("id-ID")}`;
}

/** Membuat UUID v4 untuk "kunci idempotensi" pesanan (mencegah pesanan ganda saat klik berulang). */
export function newUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Cadangan untuk browser lama / halaman non-HTTPS.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Huruf kecil & tanpa aksen, untuk pencarian yang toleran ("Es Teh" cocok dengan "es teh"). */
export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/**
 * Nomor HP Indonesia -> 62xxxxxxxxxx, atau null jika tidak valid.
 * Aturannya SAMA dengan validasi di server (server tetap yang menentukan).
 */
export function normalizePhone(input) {
  const cleaned = String(input ?? "").trim().replace(/[\s\-.()]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return null;
  let digits = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  else if (digits.startsWith("8")) digits = `62${digits}`;
  return /^628\d{8,11}$/.test(digits) ? digits : null;
}

/** Hanya izinkan tautan http/https (mencegah "javascript:" dari data yang salah). */
export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Membuat elemen DOM dengan aman (teks selalu lewat textContent, bukan innerHTML). */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// ------------------------------------------------------------------ gambar pengganti
// Menu yang belum punya foto memakai ilustrasi per kategori (file lokal di /images/placeholders/).
// Tidak ada URL gambar dari internet yang dikarang. Cara mengganti: unggah foto di dashboard admin.
export const GENERIC_PLACEHOLDER = "/images/placeholder.svg";
const CATEGORY_PLACEHOLDERS = new Set(["makanan", "minuman", "jajanan", "paket"]);

export function placeholderFor(category) {
  return CATEGORY_PLACEHOLDERS.has(category) ? `/images/placeholders/${category}.svg` : GENERIC_PLACEHOLDER;
}

/**
 * Mengisi <img> dengan foto produk. Jika foto kosong/hilang/rusak, dipakai gambar pengganti kategori,
 * dan jika itu pun gagal, gambar pengganti umum (maksimal dua kali ganti supaya tidak berulang tanpa akhir).
 */
export function setProductImage(img, product) {
  const fallbacks = [placeholderFor(product.category), GENERIC_PLACEHOLDER];
  let step = 0;
  img.addEventListener("error", () => {
    if (step < fallbacks.length) {
      img.src = fallbacks[step];
      step += 1;
    }
  });
  img.src = product.image || fallbacks[step++];
}

/** Tanggal & jam dalam zona waktu perangkat pelanggan, mis. "19 Okt 2026, 17.36". */
export function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("id-ID", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
