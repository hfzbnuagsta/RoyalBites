// Data bersama: konfigurasi bisnis, katalog produk, dan keranjang.
// Keranjang HANYA menyimpan {id, qty}. Nama & harga selalu diambil dari katalog (hasil API),
// jadi mengubah localStorage di browser tidak bisa mengubah harga.
import { getConfig, getProducts } from "./api.js";

const CART_KEY = "royalBites.cart.v2";
export const MAX_QTY_PER_ITEM = 99;

// ------------------------------------------------------------------ pengamat sederhana
const listeners = new Set();
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify() {
  for (const listener of listeners) listener();
}

// ------------------------------------------------------------------ katalog & konfigurasi
export const store = {
  config: null,
  products: [],
  productsById: new Map(),
  catalogLoaded: false,
};

export async function loadConfig() {
  store.config = await getConfig();
  notify();
  return store.config;
}

/** Mengambil ulang katalog dari server (harga & stok terbaru). */
export async function loadCatalog() {
  const { products } = await getProducts();
  store.products = products;
  store.productsById = new Map(products.map((product) => [product.id, product]));
  store.catalogLoaded = true;
  reconcileCartWithCatalog();
  notify();
  return products;
}

/** Jumlah maksimum yang boleh dipesan untuk sebuah produk. */
export function maxQuantityFor(product) {
  if (!product) return 0;
  if (product.availability !== "available") return 0;
  return product.stock === null ? MAX_QTY_PER_ITEM : Math.min(MAX_QTY_PER_ITEM, product.stock);
}

// ------------------------------------------------------------------ keranjang
function readStoredCart() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const items = [];
    for (const entry of parsed) {
      const id = Number(entry?.id);
      const qty = Number(entry?.qty);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(qty) || qty < 1 || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, qty: Math.min(qty, MAX_QTY_PER_ITEM) });
    }
    return items;
  } catch {
    return []; // localStorage dimatikan / data rusak => mulai dari keranjang kosong
  }
}

let cartItems = readStoredCart();

function persistCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cartItems));
  } catch {
    // Mode privat / penyimpanan penuh: keranjang tetap bekerja selama halaman terbuka.
  }
}

/** Pesan perubahan otomatis (produk dihapus, stok berkurang) untuk ditampilkan ke pelanggan. */
let pendingNotices = [];
export function takeCartNotices() {
  const notices = pendingNotices;
  pendingNotices = [];
  return notices;
}

/** Menyesuaikan keranjang dengan katalog terbaru. */
function reconcileCartWithCatalog() {
  if (!store.catalogLoaded) return;
  const next = [];
  for (const item of cartItems) {
    const product = store.productsById.get(item.id);
    if (!product) {
      pendingNotices.push("Satu menu di keranjang sudah tidak tersedia dan dihapus.");
      continue;
    }
    if (product.availability === "available" && product.stock !== null && item.qty > product.stock) {
      pendingNotices.push(`Stok ${product.name} tinggal ${product.stock}, jumlah di keranjang disesuaikan.`);
      next.push({ id: item.id, qty: product.stock });
    } else {
      next.push(item);
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(cartItems);
  cartItems = next;
  if (changed) persistCart();
}

export function getCartItems() {
  return cartItems.map((item) => ({ ...item }));
}

export function getCartCount() {
  return cartItems.reduce((sum, item) => sum + item.qty, 0);
}

/** Baris keranjang lengkap dengan data produk, total, dan masalah (jika ada). */
export function getCartLines() {
  return cartItems.map((item) => {
    const product = store.productsById.get(item.id) ?? null;
    let problem = null;
    if (store.catalogLoaded) {
      if (!product) problem = "Menu ini sudah tidak tersedia.";
      else if (product.availability === "sold_out") problem = "Stok habis.";
      else if (product.availability === "unavailable") problem = "Sedang tidak tersedia.";
      else if (product.stock !== null && item.qty > product.stock) problem = `Stok tinggal ${product.stock}.`;
    }
    return { id: item.id, qty: item.qty, product, problem, lineTotal: product ? product.price * item.qty : 0 };
  });
}

export function getCartSubtotal() {
  return getCartLines().reduce((sum, line) => sum + line.lineTotal, 0);
}

/**
 * Menambah produk ke keranjang.
 * @returns {{ok: boolean, message?: string}}
 */
export function addToCart(productId, quantity = 1) {
  const product = store.productsById.get(productId);
  if (!product) return { ok: false, message: "Menu tidak ditemukan." };
  const max = maxQuantityFor(product);
  if (max === 0) {
    return { ok: false, message: product.availability === "sold_out" ? `${product.name} sedang habis.` : `${product.name} sedang tidak tersedia.` };
  }
  const existing = cartItems.find((item) => item.id === productId);
  const current = existing ? existing.qty : 0;
  if (current + quantity > max) {
    const reason = product.stock !== null ? `Stok ${product.name} tinggal ${product.stock}.` : `Maksimal ${MAX_QTY_PER_ITEM} per menu.`;
    if (current >= max) return { ok: false, message: reason };
    quantity = max - current;
    if (existing) existing.qty += quantity;
    else cartItems.push({ id: productId, qty: quantity });
    persistCart();
    notify();
    return { ok: true, message: `${reason} Jumlah disesuaikan.` };
  }
  if (existing) existing.qty += quantity;
  else cartItems.push({ id: productId, qty: quantity });
  persistCart();
  notify();
  return { ok: true };
}

export function setQuantity(productId, quantity) {
  const item = cartItems.find((entry) => entry.id === productId);
  if (!item) return { ok: false };
  const product = store.productsById.get(productId);
  const max = product ? Math.max(maxQuantityFor(product), 1) : MAX_QTY_PER_ITEM;
  if (quantity > max) {
    return { ok: false, message: product?.stock !== null && product ? `Stok ${product.name} tinggal ${product.stock}.` : `Maksimal ${MAX_QTY_PER_ITEM} per menu.` };
  }
  item.qty = Math.max(1, quantity);
  persistCart();
  notify();
  return { ok: true };
}

export function removeFromCart(productId) {
  cartItems = cartItems.filter((item) => item.id !== productId);
  persistCart();
  notify();
}

export function clearCart() {
  cartItems = [];
  persistCart();
  notify();
}

/** Menerapkan koreksi dari server (hasil CART_INVALID): hapus/kurangi item bermasalah. */
export function applyServerProblems(problems) {
  const messages = [];
  for (const problem of problems) {
    const item = cartItems.find((entry) => entry.id === problem.product_id);
    if (!item) continue;
    if (problem.code === "INSUFFICIENT_STOCK" && problem.available > 0) {
      item.qty = problem.available;
      messages.push(problem.message || `Stok ${problem.name} tinggal ${problem.available}.`);
    } else {
      cartItems = cartItems.filter((entry) => entry.id !== problem.product_id);
      messages.push(problem.message || "Satu menu sudah tidak tersedia dan dihapus dari keranjang.");
    }
  }
  persistCart();
  notify();
  return messages;
}
