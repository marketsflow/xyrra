export const ADMIN_PANEL_ROLES = new Set(["admin", "editor"]);

export function isAdminPanelRole(role: string | null | undefined): boolean {
  return ADMIN_PANEL_ROLES.has(String(role ?? "user").trim());
}

export function roleLabel(role: string): string {
  if (role === "admin") return "Administrator";
  if (role === "editor") return "Editor";
  return role;
}
