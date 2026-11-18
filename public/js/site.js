// Bagian "halaman": menerapkan konfigurasi bisnis ke HTML, navigasi mobile, dan penanda menu aktif.
import { formatRupiah, h, safeHttpUrl } from "./format.js";
import { refreshIcons } from "./ui.js";

const $ = (selector) => document.querySelector(selector);

/** "Royal Bites" -> <Royal <span>Bites</span>>  (kata terakhir diberi warna aksen seperti desain asli). */
function fillBrand(container, name) {
  const words = name.trim().split(/\s+/);
  const last = words.pop();
  container.textContent = "";
  if (words.length > 0) container.append(`${words.join(" ")} `);
  container.append(h("span", { text: last }));
}

function setInfoCard(id, value) {
  const card = $(id);
  const hasValue = Boolean(value);
  card.hidden = !hasValue;
  if (hasValue) card.querySelector("p").textContent = value;
  return hasValue;
}

/** Menerapkan data dari GET /api/config ke halaman. */
export function applyConfig(config) {
  const { business, ordering } = config;

  fillBrand($("#logo-text"), business.name);
  fillBrand($("#hero-title"), business.name);
  document.title = `${business.name} — Kuliner Nusantara`;
  $("#hero-description").textContent = business.description;

  const logo = $("#logo-img");
  if (business.logo_image) {
    logo.src = business.logo_image;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }

  // ---- Blok informasi kontak (yang kosong tidak ditampilkan; tidak ada data karangan)
  const hasAddress = setInfoCard("#info-address", business.address);
  const hasHours = setInfoCard("#info-hours", business.opening_hours);
  let hasWhatsapp = false;
  const whatsappCard = $("#info-whatsapp");
  if (business.whatsapp_number) {
    const link = whatsappCard.querySelector("a");
    link.href = `https://wa.me/${business.whatsapp_number}`;
    link.textContent = `+${business.whatsapp_number}`;
    hasWhatsapp = true;
  }
  whatsappCard.hidden = !hasWhatsapp;

  let deliveryText = "";
  if (ordering.delivery_enabled) {
    deliveryText = [ordering.delivery_area, `Ongkos kirim ${formatRupiah(ordering.delivery_fee)}`].filter(Boolean).join(" · ");
  } else {
    deliveryText = "";
  }
  const hasDelivery = setInfoCard("#info-delivery", deliveryText);
  $("#contact-info").hidden = !(hasAddress || hasHours || hasWhatsapp || hasDelivery);

  // ---- Tautan media sosial di footer (hanya yang diisi pemilik)
  const socials = $("#footer-socials");
  socials.textContent = "";
  const networks = [
    ["instagram", "Instagram"],
    ["facebook", "Facebook"],
    ["twitter", "Twitter / X"],
  ];
  for (const [key, label] of networks) {
    const url = business.social[key] ? safeHttpUrl(business.social[key]) : null;
    if (!url) continue;
    socials.append(
      h("a", { href: url, target: "_blank", rel: "noopener noreferrer", "aria-label": `${label} ${business.name}` }, h("i", { "data-feather": key })),
    );
  }
  socials.hidden = socials.children.length === 0;

  // ---- Banner jika pemesanan online ditutup
  const banner = $("#order-banner");
  banner.hidden = ordering.accepting_orders;
  banner.textContent = ordering.accepting_orders
    ? ""
    : "Pemesanan online sedang ditutup. Anda tetap bisa melihat menu, dan silakan hubungi kami untuk memesan.";

  refreshIcons();
}

// ------------------------------------------------------------------ Navigasi mobile
export function initNavigation() {
  const nav = $("#navbar-nav");
  const hamburger = $("#hamburger-menu");
  const overlay = $("#page-overlay");
  const mobileQuery = window.matchMedia("(max-width: 758px)");

  function setOpen(open) {
    nav.classList.toggle("active", open);
    overlay.hidden = !open;
    hamburger.setAttribute("aria-expanded", String(open));
    hamburger.setAttribute("aria-label", open ? "Tutup menu navigasi" : "Buka menu navigasi");
  }

  hamburger.addEventListener("click", () => setOpen(!nav.classList.contains("active")));
  overlay.addEventListener("click", () => setOpen(false));
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("active")) {
      setOpen(false);
      hamburger.focus();
    }
  });
  // Jika layar diperlebar, pastikan keadaan "terbuka" tidak tertinggal.
  mobileQuery.addEventListener("change", (event) => {
    if (!event.matches) setOpen(false);
  });

  // ---- Penanda menu aktif saat scroll
  const links = [...document.querySelectorAll(".nav-link")].filter((link) => link.getAttribute("href").startsWith("#"));
  const sections = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of links) {
          const active = link.getAttribute("href") === `#${entry.target.id}`;
          link.classList.toggle("active", active);
          if (active) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        }
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  sections.forEach((section) => observer.observe(section));
}
