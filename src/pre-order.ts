import { pcSystemFromSearch } from "./lib/pc-systems";

function applySelectedSystem() {
  const system = pcSystemFromSearch();
  if (!system) return;

  const title = document.getElementById("po-title");
  if (title) {
    title.innerHTML = `Pre-order the <em>${system.name}</em>`;
  }

  const lede = document.getElementById("po-lede");
  if (lede) {
    lede.textContent = system.lede;
  }

  const visual = document.querySelector<HTMLImageElement>(".po-product__visual img");
  if (visual) {
    visual.alt = system.name;
  }

  const specsLink = document.querySelector<HTMLAnchorElement>(".po-specs-link a");
  if (specsLink) {
    specsLink.href = system.href;
    specsLink.innerHTML = `View ${system.name} specs <span aria-hidden="true">→</span>`;
  }

  const highlights = document.querySelector(".po-highlights");
  if (highlights) {
    highlights.setAttribute("aria-label", `${system.name} specifications`);
    highlights.innerHTML = system.specs
      .map((spec) => `<li><span>${spec}</span></li>`)
      .join("");
  }

  const selected = document.getElementById("po-selected");
  const selectedName = document.getElementById("po-selected-name");
  const selectedPrice = document.getElementById("po-selected-price");
  if (selected && selectedName && selectedPrice) {
    selected.hidden = false;
    selectedName.textContent = system.name;
    selectedPrice.textContent = `From ${system.price}`;
  }

  const formTitle = document.getElementById("po-form-title");
  if (formTitle) {
    formTitle.textContent = `Reserve ${system.name}`;
  }

  const input = document.getElementById("preorder-system") as HTMLInputElement | null;
  if (input) {
    input.value = system.key;
  }
}

applySelectedSystem();
