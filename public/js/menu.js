// Katalog menu: tombol kategori, pencarian, kartu produk, dan dialog detail produk.
// Data produk SELALU berasal dari API (database), tidak ada daftar menu yang ditulis di HTML/JS.
import { formatRupiah, h, normalizeText, setProductImage } from "./format.js";
import { MAX_QTY_PER_ITEM, addToCart, maxQuantityFor, store, subscribe } from "./state.js";
import { closeDialog, openDialog, refreshIcons, showToast } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

// Filter yang sedang aktif.
// sort: "default" (urutan dari server), "price-asc", "price-desc", "name-asc".
const view = { category: "all", query: "", sort: "default" };

const SORTERS = {
  "price-asc": (a, b) => a.price - b.price || a.name.localeCompare(b.name, "id"),
  "price-desc": (a, b) => b.price - a.price || a.name.localeCompare(b.name, "id"),
  "name-asc": (a, b) => a.name.localeCompare(b.name, "id"),
};

// Untuk menghindari render ulang (dan animasi muncul ulang) saat hanya keranjang yang berubah.
let renderedProducts = null;
let renderedConfig = null;
let retryHandler = null;

const ordersOpen = () => store.config?.ordering.accepting_orders === true;

function categoryLabel(value) {
  return store.config?.categories.find((category) => category.value === value)?.label ?? value;
}

// ------------------------------------------------------------------ gambar
function productImage(product, className, width, height) {
  const img = h("img", {
    class: className,
    alt: product.image ? product.name : `${product.name} (foto belum tersedia)`,
    loading: "lazy",
    width,
    height,
  });
  // Foto asli -> ilustrasi kategori -> ilustrasi umum (lihat setProductImage).
  setProductImage(img, product);
  return img;
}

// ------------------------------------------------------------------ status (memuat / gagal / kosong)
const grid = () => $("#menu-grid");
const statusBox = () => $("#menu-status");

function clearStatus() {
  const box = statusBox();
  box.hidden = true;
  box.textContent = "";
}

function showStatus({ icon, title, message, actionLabel, onAction }) {
  const box = statusBox();
  box.textContent = "";
  box.append(
    h("i", { "data-feather": icon, "aria-hidden": "true" }),
    h("h3", { text: title }),
    h("p", { text: message }),
    actionLabel ? h("button", { type: "button", class: "btn-secondary", onclick: onAction, text: actionLabel }) : null,
  );
  box.hidden = false;
  refreshIcons();
}

/** Kerangka kartu sementara selama data dimuat. */
export function showMenuLoading() {
  clearStatus();
  $("#menu-count").textContent = "";
  const skeletons = Array.from({ length: 6 }, () =>
    h(
      "div",
      { class: "menu-card skeleton", "aria-hidden": "true" },
      h("span", { class: "sk sk-img" }),
      h("span", { class: "sk sk-line" }),
      h("span", { class: "sk sk-line short" }),
      h("span", { class: "sk sk-btn" }),
    ),
  );
  grid().replaceChildren(...skeletons);
  statusBox().hidden = false;
  statusBox().textContent = "Memuat menu…";
  statusBox().classList.add("loading-text");
}

export function showMenuError(message) {
  grid().replaceChildren();
  $("#menu-count").textContent = "";
  statusBox().classList.remove("loading-text");
  showStatus({
    icon: "wifi-off",
    title: "Menu belum bisa dimuat",
    message,
    actionLabel: "Coba lagi",
    onAction: () => retryHandler?.(),
  });
}

// ------------------------------------------------------------------ kategori
function renderCategories() {
  const container = $("#category-buttons");
  const present = new Set(store.products.map((product) => product.category));
  const categories = (store.config?.categories ?? []).filter((category) => present.has(category.value));
  if (view.category !== "all" && !present.has(view.category)) view.category = "all";

  const buttons = [{ value: "all", label: "All Menu" }, ...categories].map((category) =>
    h("button", {
      type: "button",
      class: `category-btn${view.category === category.value ? " active" : ""}`,
      "aria-pressed": String(view.category === category.value),
      dataset: { category: category.value },
      text: category.label,
    }),
  );
  container.replaceChildren(...buttons);
}

// ------------------------------------------------------------------ kartu produk
function statusText(product) {
  if (product.availability === "sold_out") return { text: "Habis", tone: "danger" };
  if (product.availability === "unavailable") return { text: "Tidak tersedia", tone: "danger" };
  if (product.stock !== null && product.stock <= 5) return { text: `Sisa ${product.stock}`, tone: "warn" };
  return { text: "Tersedia", tone: "ok" };
}

function badgeFor(product) {
  if (product.availability === "sold_out") return { text: "Habis", danger: true };
  if (product.availability === "unavailable") return { text: "Tidak tersedia", danger: true };
  if (product.stock !== null && product.stock <= 5) return { text: `Sisa ${product.stock}`, danger: false };
  return null;
}

function createCard(product) {
  const available = product.availability === "available";
  const canOrder = available && ordersOpen();
  const badge = badgeFor(product);

  let buttonLabel = "Tambah ke Keranjang";
  if (!available) buttonLabel = product.availability === "sold_out" ? "Stok Habis" : "Tidak Tersedia";
  else if (!ordersOpen()) buttonLabel = "Pemesanan Ditutup";

  return h(
    "article",
    { class: `menu-card${available ? "" : " is-unavailable"}`, dataset: { id: product.id } },
    h(
      "button",
      { type: "button", class: "menu-card-media", "aria-label": `Lihat detail ${product.name}`, dataset: { detail: product.id } },
      productImage(product, "menu-card-img", 400, 300),
      badge ? h("span", { class: `status-badge${badge.danger ? " danger" : ""}`, text: badge.text }) : null,
    ),
    h(
      "div",
      { class: "menu-card-meta" },
      h("span", { class: "menu-card-category", text: categoryLabel(product.category) }),
      h("span", { class: `menu-card-status ${statusText(product).tone}`, text: statusText(product).text }),
    ),
    h("h3", { class: "menu-card-title", text: product.name }),
    h("p", { class: "menu-card-description", text: product.description }),
    h("p", { class: "menu-card-price", text: formatRupiah(product.price) }),
    h(
      "div",
      { class: "menu-card-actions" },
      h("button", {
        type: "button",
        class: "add-to-cart-btn",
        disabled: canOrder ? null : true,
        dataset: { add: product.id },
        "aria-label": `${buttonLabel}: ${product.name}`,
        text: buttonLabel,
      }),
    ),
  );
}

/** Produk yang lolos filter kategori + pencarian (nama, deskripsi, atau nama kategori). */
function filteredProducts() {
  const query = normalizeText(view.query);
  const matches = store.products.filter((product) => {
    if (view.category !== "all" && product.category !== view.category) return false;
    if (!query) return true;
    const haystack = normalizeText(`${product.name} ${product.description} ${categoryLabel(product.category)}`);
    return query.split(/\s+/).every((word) => haystack.includes(word));
  });
  const sorter = SORTERS[view.sort];
  return sorter ? [...matches].sort(sorter) : matches; // salinan: urutan asli dari server tidak berubah
}

function renderGrid() {
  const products = filteredProducts();
  const total = store.products.length;
  statusBox().classList.remove("loading-text");

  if (total === 0) {
    grid().replaceChildren();
    $("#menu-count").textContent = "";
    showStatus({ icon: "coffee", title: "Menu belum tersedia", message: "Belum ada menu yang ditampilkan. Silakan kembali lagi nanti." });
    return;
  }

  if (products.length === 0) {
    grid().replaceChildren();
    $("#menu-count").textContent = "";
    showStatus({
      icon: "search",
      title: "Menu tidak ditemukan",
      message: view.query ? `Tidak ada menu yang cocok dengan “${view.query}”.` : "Tidak ada menu pada kategori ini.",
      actionLabel: "Tampilkan semua menu",
      onAction: resetFilters,
    });
    return;
  }

  clearStatus();
  grid().replaceChildren(...products.map(createCard));
  $("#menu-count").textContent =
    products.length === total ? `Menampilkan ${total} menu` : `Menampilkan ${products.length} dari ${total} menu`;
}

function render() {
  renderedProducts = store.products;
  renderedConfig = store.config;
  renderCategories();
  renderGrid();
}

function resetFilters() {
  view.category = "all";
  view.query = "";
  $("#search-input").value = "";
  render();
}

// ------------------------------------------------------------------ urutan
function initSort() {
  const select = $("#sort-select");
  select.value = view.sort;
  select.addEventListener("change", () => {
    view.sort = SORTERS[select.value] ? select.value : "default";
    if (store.catalogLoaded) renderGrid();
  });
}

// ------------------------------------------------------------------ pencarian
function initSearch() {
  const button = $("#search-btn");
  const panel = $("#search-panel");
  const input = $("#search-input");

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) input.focus();
  }

  button.addEventListener("click", () => setOpen(panel.hidden));
  $("#close-search").addEventListener("click", () => {
    setOpen(false);
    button.focus();
  });
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    $("#menu").scrollIntoView({ behavior: "smooth" });
  });
  input.addEventListener("input", () => {
    view.query = input.value.trim();
    if (store.catalogLoaded) renderGrid();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setOpen(false);
      button.focus();
    }
  });
}

// ------------------------------------------------------------------ detail produk
const detail = { id: null, qty: 1 };

function syncDetail() {
  const product = store.productsById.get(detail.id);
  if (!product) return;
  const max = maxQuantityFor(product);
  const canOrder = max > 0 && ordersOpen();
  $("#pd-qty").textContent = String(detail.qty);
  $("#pd-minus").disabled = detail.qty <= 1;
  $("#pd-plus").disabled = !canOrder || detail.qty >= max;
  const add = $("#pd-add");
  add.disabled = !canOrder;
  if (!canOrder) add.textContent = max === 0 ? "Tidak bisa dipesan" : "Pemesanan Ditutup";
  else add.textContent = `Tambah ${detail.qty} ke Keranjang`;
}

export function openProductDetail(id) {
  const product = store.productsById.get(id);
  if (!product) return;
  detail.id = id;
  detail.qty = 1;

  // Gambar detail dibuat ulang setiap dibuka supaya pendengar "error" tidak menumpuk.
  const image = h("img", {
    id: "pd-image",
    class: "pd-image",
    alt: product.image ? product.name : `${product.name} (foto belum tersedia)`,
    width: 400,
    height: 300,
  });
  setProductImage(image, product);
  $("#pd-image").replaceWith(image);
  $("#pd-category").textContent = categoryLabel(product.category);
  $("#product-dialog-title").textContent = product.name;
  $("#pd-description").textContent = product.description || "Belum ada deskripsi untuk menu ini.";
  $("#pd-price").textContent = formatRupiah(product.price);

  let availability = "Tersedia";
  if (product.availability === "sold_out") availability = "Stok habis";
  else if (product.availability === "unavailable") availability = "Sedang tidak tersedia";
  else if (product.stock !== null) availability = `Stok tersisa ${product.stock}`;
  $("#pd-availability").textContent = availability;

  syncDetail();
  openDialog($("#product-dialog"));
}

function initDetailDialog() {
  $("#pd-minus").addEventListener("click", () => {
    detail.qty = Math.max(1, detail.qty - 1);
    syncDetail();
  });
  $("#pd-plus").addEventListener("click", () => {
    const max = maxQuantityFor(store.productsById.get(detail.id));
    if (detail.qty >= max) {
      showToast(max >= MAX_QTY_PER_ITEM ? `Maksimal ${MAX_QTY_PER_ITEM} per menu.` : `Stok hanya ${max}.`, { error: true });
      return;
    }
    detail.qty += 1;
    syncDetail();
  });
  $("#pd-add").addEventListener("click", () => {
    const product = store.productsById.get(detail.id);
    const result = addToCart(detail.id, detail.qty);
    if (!result.ok) {
      showToast(result.message ?? "Tidak bisa menambah ke keranjang.", { error: true });
      return;
    }
    showToast(result.message ?? `${product.name} ditambahkan ke keranjang.`);
    closeDialog($("#product-dialog"));
  });
}

// ------------------------------------------------------------------ inisialisasi
/** @param {{onRetry: () => void}} options  fungsi yang dipanggil tombol "Coba lagi". */
export function initMenu({ onRetry }) {
  retryHandler = onRetry;

  $("#category-buttons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    view.category = button.dataset.category;
    render();
    $(`#category-buttons [data-category="${view.category}"]`)?.focus();
  });

  // Satu pendengar untuk seluruh grid (event delegation): lebih hemat daripada satu per tombol.
  grid().addEventListener("click", (event) => {
    const detailButton = event.target.closest("[data-detail]");
    if (detailButton) {
      openProductDetail(Number(detailButton.dataset.detail));
      return;
    }
    const addButton = event.target.closest("[data-add]");
    if (!addButton) return;
    const product = store.productsById.get(Number(addButton.dataset.add));
    const result = addToCart(Number(addButton.dataset.add), 1);
    if (result.ok) showToast(result.message ?? `${product.name} ditambahkan ke keranjang.`);
    else showToast(result.message ?? "Tidak bisa menambah ke keranjang.", { error: true });
  });

  initSearch();
  initSort();
  initDetailDialog();

  // Render ulang hanya jika katalog/konfigurasi berubah (bukan karena isi keranjang).
  subscribe(() => {
    if (!store.catalogLoaded || !store.config) return;
    if (store.products !== renderedProducts || store.config !== renderedConfig) render();
  });
}
