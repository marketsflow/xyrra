import { applyEmailInlineImageWidth } from "../lib/email/email-inline-images";

function imageFromTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-xyrra-email-inline-image] img");
}

export function bindEmailImageResize(
  editor: HTMLElement,
  options: {
    onChange: () => void;
  },
) {
  const wrap = editor.closest(".xa-template-editor__body-wrap");
  if (!(wrap instanceof HTMLElement)) {
    return {
      select(_img: HTMLImageElement | null) {},
      sync() {},
      clear() {},
    };
  }

  const host = wrap;

  const overlay = document.createElement("div");
  overlay.className = "xa-image-resize";
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = `
    <span class="xa-image-resize__handle xa-image-resize__handle--nw" data-xa-resize="nw"></span>
    <span class="xa-image-resize__handle xa-image-resize__handle--ne" data-xa-resize="ne"></span>
    <span class="xa-image-resize__handle xa-image-resize__handle--sw" data-xa-resize="sw"></span>
    <span class="xa-image-resize__handle xa-image-resize__handle--se" data-xa-resize="se"></span>
    <span class="xa-image-resize__label" data-xa-resize-label></span>
  `;
  host.appendChild(overlay);

  let selected: HTMLImageElement | null = null;
  let drag: { west: boolean; startX: number; startWidth: number } | null = null;

  function clear() {
    selected = null;
    overlay.hidden = true;
  }

  function sync() {
    if (!selected?.isConnected) {
      clear();
      return;
    }

    const wrapRect = host.getBoundingClientRect();
    const imgRect = selected.getBoundingClientRect();
    overlay.hidden = false;
    overlay.style.left = `${imgRect.left - wrapRect.left + host.scrollLeft}px`;
    overlay.style.top = `${imgRect.top - wrapRect.top + host.scrollTop}px`;
    overlay.style.width = `${imgRect.width}px`;
    overlay.style.height = `${imgRect.height}px`;

    const label = overlay.querySelector("[data-xa-resize-label]");
    if (label) label.textContent = `${Math.round(imgRect.width)}px wide`;
  }

  function select(img: HTMLImageElement | null) {
    selected = img;
    sync();
  }

  editor.addEventListener("mousedown", (event) => {
    const img = imageFromTarget(event.target);
    if (!(img instanceof HTMLImageElement)) return;
    event.preventDefault();
    select(img);
  });

  document.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof Element)) return;
    if (overlay.contains(event.target) || imageFromTarget(event.target)) return;
    clear();
  });

  overlay.addEventListener("mousedown", (event) => {
    const handle = event.target instanceof HTMLElement ? event.target.dataset.xaResize : undefined;
    if (!handle || !selected) return;
    event.preventDefault();
    event.stopPropagation();
    drag = {
      west: handle === "nw" || handle === "sw",
      startX: event.clientX,
      startWidth: selected.getBoundingClientRect().width,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = drag.west ? "nwse-resize" : "nesw-resize";
  });

  window.addEventListener("mousemove", (event) => {
    if (!drag || !selected) return;
    event.preventDefault();
    const delta = event.clientX - drag.startX;
    applyEmailInlineImageWidth(selected, drag.startWidth + (drag.west ? -delta : delta));
    sync();
    options.onChange();
  });

  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    options.onChange();
  });

  window.addEventListener("scroll", sync, true);
  window.addEventListener("resize", sync);

  return { select, sync, clear };
}
