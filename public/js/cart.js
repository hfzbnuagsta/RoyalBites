// Keranjang belanja (laci di sisi kanan): tampil, ubah jumlah, hapus, kosongkan.
// Harga yang tampil dihitung dari katalog hasil API. Server tetap menghitung ulang saat checkout.
import { formatRupiah, h, setProductImage } from "./format.js";
import {
  clearCart,
  getCartCount,
  getCartLines,
  getCartSubtotal,
  removeFromCart,
  setQuantity,
  store,
  subscribe,
  takeCartNotices,
} from "./state.js";
import { closeDialog, confirmAction, openDialog, refreshIcons, showToast } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

let notices = []; // pesan penyesuaian otomatis (mis. stok berkurang), tampil sampai laci ditutup
let onCheckout = () => {};

/** Mengapa tombol checkout tidak boleh ditekan (null = boleh). */
function checkoutBlocker(lines, subtotal) {
  if (lines.length === 0) return "Keranjang masih kosong.";
  if (!store.catalogLoaded || !store.config) return "Menu sedang dimuat.";
  if (!store.config.ordering.accepting_orders) return "Pemesanan online sedang ditutup.";
  if (lines.some((line) => line.problem)) return "Ada menu yang bermasalah. Hapus atau kurangi jumlahnya agar bisa lanjut.";
  const min = store.config.ordering.min_order_amount;
  if (min > 0 && subtotal < min) return `Minimum pemesanan ${formatRupiah(min)}. Tambah menu lagi.`;
  return null;
}

/** Dipakai checkout: alasan keranjang belum boleh di-checkout (null = boleh). */
export function getCheckoutBlocker() {
  const lines = getCartLines();
  return checkoutBlocker(lines, getCartSubtotal());
}

function createLine(line) {
  const { product, qty } = line;
  const name = product ? product.name : "Menu tidak tersedia";
  const thumb = h("img", { class: "cart-item-thumb", alt: "", width: 60, height: 60, loading: "lazy" });
  setProductImage(thumb, product ?? { image: null, category: null });

  return h(
    "div",
    { class: "cart-item", dataset: { id: line.id } },
    thumb,
    h(
      "div",
      { class: "cart-item-info" },
      h("h3", { text: name }),
      product ? h("p", { class: "unit", text: `${formatRupiah(product.price)} / porsi` }) : null,
      product ? h("p", { class: "line", text: formatRupiah(line.lineTotal) }) : null,
      line.problem ? h("p", { class: "cart-item-problem", role: "alert", text: line.problem }) : null,
    ),
    h(
      "button",
      { type: "button", class: "icon-btn cart-delete", "aria-label": `Hapus ${name} dari keranjang`, dataset: { action: "remove", id: line.id } },
      h("i", { "data-feather": "trash-2" }),
    ),
    h(
      "div",
      { class: "cart-item-actions" },
      h(
        "div",
        { class: "qty-stepper", role: "group", "aria-label": `Jumlah ${name}` },
        h("button", {
          type: "button",
          class: "quantity-btn",
          "aria-label": `Kurangi jumlah ${name}`,
          disabled: qty <= 1 ? true : null,
          dataset: { action: "minus", id: line.id },
          text: "−",
        }),
        h("output", { class: "quantity-number", text: String(qty) }),
        h("button", {
          type: "button",
          class: "quantity-btn",
          "aria-label": `Tambah jumlah ${name}`,
          dataset: { action: "plus", id: line.id },
          text: "+",
        }),
      ),
    ),
  );
}

function render() {
  const lines = getCartLines();
  const count = getCartCount();
  const subtotal = getCartSubtotal();

  // Lencana jumlah di ikon keranjang.
  const badge = $("#cart-count");
  badge.textContent = count > 99 ? "99+" : String(count);
  badge.hidden = count === 0;
  $("#cart-btn").setAttribute("aria-label", count > 0 ? `Buka keranjang belanja, ${count} item` : "Buka keranjang belanja");

  // Ingat tombol yang sedang fokus supaya fokus tidak hilang saat daftar digambar ulang.
  const active = document.activeElement;
  const focusKey = active?.closest?.("#cart-items") && active.dataset?.action ? { action: active.dataset.action, id: active.dataset.id } : null;

  const itemsBox = $("#cart-items");
  if (lines.length === 0) {
    itemsBox.replaceChildren(
      h(
        "div",
        { class: "empty-cart" },
        h("i", { "data-feather": "shopping-bag", "aria-hidden": "true" }),
        h("h3", { text: "Keranjang masih kosong" }),
        h("p", { text: "Pilih menu favoritmu lalu tekan “Tambah ke Keranjang”." }),
      ),
    );
  } else {
    itemsBox.replaceChildren(...lines.map(createLine));
  }

  // Pesan penyesuaian otomatis
  const notice = $("#cart-notice");
  notice.textContent = notices.join(" ");
  notice.hidden = notices.length === 0;

  // Total & tombol checkout
  $("#cart-total-price").textContent = formatRupiah(subtotal);
  const blocker = checkoutBlocker(lines, subtotal);
  $("#checkout-btn").disabled = blocker !== null;
  $("#clear-cart-btn").hidden = lines.length === 0;
  $("#cart-hint").textContent = blocker ?? "Ongkos kirim (jika diantar) dihitung saat checkout.";

  refreshIcons();

  if (focusKey) {
    const restored = itemsBox.querySelector(`[data-action="${focusKey.action}"][data-id="${focusKey.id}"]`);
    if (restored && !restored.disabled) restored.focus();
  }
}

async function handleItemClick(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const id = Number(button.dataset.id);
  const line = getCartLines().find((entry) => entry.id === id);
  if (!line) return;
  const name = line.product?.name ?? "menu ini";

  if (button.dataset.action === "plus") {
    const result = setQuantity(id, line.qty + 1);
    if (!result.ok) showToast(result.message ?? "Jumlah tidak bisa ditambah.", { error: true });
  } else if (button.dataset.action === "minus") {
    setQuantity(id, line.qty - 1);
  } else if (button.dataset.action === "remove") {
    const confirmed = await confirmAction({
      title: "Hapus dari keranjang?",
      message: `${name} akan dihapus dari keranjang.`,
      confirmLabel: "Ya, hapus",
    });
    if (!confirmed) return;
    removeFromCart(id);
    showToast(`${name} dihapus dari keranjang.`);
    // Item yang difokuskan sudah hilang: pindahkan fokus ke tempat yang aman.
    ($("#cart-items .cart-delete") ?? $("#close-cart")).focus();
  }
}

export function openCart() {
  openDialog($("#cart-drawer"));
}

export function closeCart() {
  closeDialog($("#cart-drawer"));
}

export function initCart({ onCheckoutClick }) {
  onCheckout = onCheckoutClick;

  $("#cart-btn").addEventListener("click", openCart);
  $("#close-cart").addEventListener("click", closeCart);
  $("#cart-items").addEventListener("click", handleItemClick);
  $("#checkout-btn").addEventListener("click", () => onCheckout());
  $("#clear-cart-btn").addEventListener("click", async () => {
    const confirmed = await confirmAction({
      title: "Kosongkan keranjang?",
      message: "Semua menu di keranjang akan dihapus.",
      confirmLabel: "Ya, kosongkan",
    });
    if (!confirmed) return;
    clearCart();
    notices = [];
    render();
    showToast("Keranjang dikosongkan.");
  });
  $("#cart-drawer").addEventListener("close", () => {
    notices = [];
    render();
  });

  subscribe(() => {
    const fresh = takeCartNotices();
    if (fresh.length > 0) {
      notices = [...new Set([...notices, ...fresh])];
      if (!$("#cart-drawer").open) showToast("Keranjang Anda disesuaikan dengan stok/menu terbaru.", { error: true });
    }
    render();
  });
  render();
}

/** Menampilkan pesan di keranjang (dipakai checkout saat server menolak sebagian isi keranjang). */
export function addCartNotices(messages) {
  notices = [...new Set([...notices, ...messages])];
  render();
}
