import { roleLabel } from "../lib/auth/admin-access";
import type { AdminSession } from "./auth-guard";

export type AdminNavId = "dashboard" | "users" | "email-templates" | "email-lists" | "email-outreach";

export function initAdminShell(session: AdminSession, activeNav: AdminNavId) {
  const emailEl = document.getElementById("xa-admin-email");
  const roleEl = document.getElementById("xa-admin-role");

  if (emailEl) {
    emailEl.textContent = session.user.email?.trim() || session.user.id.slice(0, 8);
  }

  if (roleEl) {
    roleEl.textContent = roleLabel(session.role);
  }

  document.querySelectorAll<HTMLElement>("[data-xa-nav]").forEach((link) => {
    const isActive = link.dataset.xaNav === activeNav;
    link.classList.toggle("xa-admin__nav-link--active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  const signOutBtn = document.getElementById("xa-admin-signout");
  signOutBtn?.addEventListener("click", () => {
    void (async () => {
      await session.supabase.auth.signOut();
      window.location.replace("/admin/login/");
    })();
  });
}
