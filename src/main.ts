const nav = document.getElementById("site-nav");
const toggle = document.getElementById("nav-toggle");

toggle?.addEventListener("click", () => {
  const open = nav?.getAttribute("data-open") === "true";
  nav?.setAttribute("data-open", open ? "false" : "true");
  toggle.setAttribute("aria-expanded", open ? "false" : "true");
});

nav?.querySelectorAll("a").forEach((a) => {
  a.addEventListener("click", () => {
    nav.setAttribute("data-open", "false");
    toggle?.setAttribute("aria-expanded", "false");
  });
});

document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href");
    if (!id || id === "#") return;
    const el = document.querySelector(id);
    if (el) {
      e.preventDefault();
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});
