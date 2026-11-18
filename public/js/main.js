// Titik masuk halaman pelanggan: menyiapkan semua modul lalu memuat data dari API.
import { initCart } from "./cart.js";
import { initCheckout, openCheckout } from "./checkout.js";
import { initContact } from "./contact.js";
import { initMenu, showMenuError, showMenuLoading } from "./menu.js";
import { applyConfig, initNavigation } from "./site.js";
import { loadCatalog, loadConfig, store, subscribe } from "./state.js";
import { initDialogs, refreshIcons } from "./ui.js";

let loading = false;
let appliedConfig = null;

/** Memuat konfigurasi bisnis + katalog dari server. Aman dipanggil berulang (mis. tombol "Coba lagi"). */
async function loadEverything() {
  if (loading) return;
  loading = true;
  showMenuLoading();
  try {
    await Promise.all([loadConfig(), loadCatalog()]);
  } catch (error) {
    showMenuError(error.message ?? "Terjadi kesalahan saat memuat menu.");
  } finally {
    loading = false;
  }
}

function init() {
  initDialogs();
  initNavigation();
  initMenu({ onRetry: loadEverything });
  initCart({ onCheckoutClick: openCheckout });
  initCheckout();
  initContact();

  // Terapkan konfigurasi bisnis ke halaman setiap kali berubah.
  subscribe(() => {
    if (store.config && store.config !== appliedConfig) {
      appliedConfig = store.config;
      applyConfig(store.config);
    }
  });

  // Gambar "Tentang Kami" berasal dari situs lain; jika gagal dimuat, pakai foto lokal.
  const aboutImage = document.querySelector("#about-img");
  const useFallback = () => {
    if (!aboutImage.src.endsWith("/images/hero.jpeg")) aboutImage.src = "/images/hero.jpeg";
  };
  aboutImage.addEventListener("error", useFallback);
  if (aboutImage.complete && aboutImage.naturalWidth === 0) useFallback();

  // Saat pelanggan kembali ke tab ini setelah lama, ambil harga & stok terbaru.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt > 2 * 60 * 1000 && store.catalogLoaded) {
      hiddenAt = 0;
      loadCatalog().catch(() => {}); // gagal diam-diam: data lama tetap tampil
    }
  });

  refreshIcons();
  loadEverything();
}

init();
