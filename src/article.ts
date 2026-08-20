/** Article page — TOC scroll spy and share helpers */

const tocLinks = document.querySelectorAll<HTMLAnchorElement>(".article-toc__list a");
const sections = Array.from(document.querySelectorAll<HTMLElement>(".article-section[id]"));

function setActiveToc(id: string) {
  tocLinks.forEach((link) => {
    const href = link.getAttribute("href");
    link.classList.toggle("is-active", href === `#${id}`);
  });
}

if (sections.length > 0 && tocLinks.length > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible[0]?.target.id) {
        setActiveToc(visible[0].target.id);
      }
    },
    {
      rootMargin: "-20% 0px -55% 0px",
      threshold: [0, 0.25, 0.5],
    }
  );

  sections.forEach((section) => observer.observe(section));
}

document.querySelectorAll<HTMLButtonElement>("[data-copy-link]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const url = window.location.href.split("#")[0];
    try {
      await navigator.clipboard.writeText(url);
      const label = btn.getAttribute("aria-label");
      btn.setAttribute("aria-label", "Link copied");
      setTimeout(() => {
        if (label) btn.setAttribute("aria-label", label);
      }, 2000);
    } catch {
      /* clipboard unavailable */
    }
  });
});
