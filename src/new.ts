const nav = document.getElementById("nh-nav");
const menu = document.getElementById("nh-menu");
const year = document.getElementById("nh-year");
const modal = document.getElementById("video");
const preorderForm = document.querySelector<HTMLFormElement>("#preorder-form");
const preorderNote = document.getElementById("preorder-note");

if (year) {
  year.textContent = String(new Date().getFullYear());
}

menu?.addEventListener("click", () => {
  const open = nav?.getAttribute("data-open") === "true";
  nav?.setAttribute("data-open", open ? "false" : "true");
  menu.setAttribute("aria-expanded", open ? "false" : "true");
  menu.setAttribute("aria-label", open ? "Open menu" : "Close menu");
});

nav?.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    nav.setAttribute("data-open", "false");
    menu?.setAttribute("aria-expanded", "false");
    menu?.setAttribute("aria-label", "Open menu");
  });
});

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href");
    if (!id || id === "#") return;
    const el = document.querySelector(id);
    if (!el) return;
    e.preventDefault();
    if (id === "#video") {
      openModal();
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

function openModal() {
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("data-open", "true");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("data-open", "false");
  document.body.style.overflow = "";
}

modal?.querySelectorAll("[data-close-modal]").forEach((el) => {
  el.addEventListener("click", () => {
    closeModal();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal && !modal.hidden) {
    closeModal();
  }
});

preorderForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!preorderForm.checkValidity()) {
    preorderForm.reportValidity();
    return;
  }
  const email = new FormData(preorderForm).get("email");
  if (preorderNote) {
    preorderNote.hidden = false;
    preorderNote.dataset.kind = "ok";
    preorderNote.textContent = `Thanks — we’ll notify ${String(email)} when pre-orders open.`;
  }
  preorderForm.reset();
});
