const CONSENT_KEY = "xyrra-cookie-consent";

function hasChoice() {
  try {
    const choice = localStorage.getItem(CONSENT_KEY);
    return choice === "accepted" || choice === "denied";
  } catch {
    return false;
  }
}

function mountCookieNotice() {
  if (document.querySelector(".mh-cookies") || hasChoice()) return;

  const notice = document.createElement("section");
  notice.className = "mh-cookies";
  notice.setAttribute("aria-label", "Cookies");
  notice.innerHTML = `
    <p>
      Your browser assigns cookies for this site. A cookie is a small file stored in the browser.
      On a later visit the browser sends that cookie back, so the site can recognise this browser
      and keep tracking data such as which pages were opened and that you returned.
    </p>
    <div class="mh-cookies__actions">
      <button type="button" data-choice="accepted">Accept cookies</button>
      <button type="button" data-choice="denied">Deny cookies</button>
      <a href="/private-policy/">Privacy</a>
    </div>
  `;

  notice.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const choice = button.getAttribute("data-choice") === "denied" ? "denied" : "accepted";
      try {
        localStorage.setItem(CONSENT_KEY, choice);
      } catch {
        /* The notice still closes for this view if storage is blocked. */
      }
      notice.remove();
    });
  });

  document.body.append(notice);
}

mountCookieNotice();
