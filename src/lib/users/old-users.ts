export type OldUser = {
  id: string;
  oldId: number | null;
  name: string | null;
  fName: string | null;
  lName: string | null;
  email: string | null;
  created: string;
};

export function mapOldUserRow(row: Record<string, unknown>): OldUser {
  return {
    id: String(row.id),
    oldId: row.old_id === null || row.old_id === undefined ? null : Number(row.old_id),
    name: row.name ? String(row.name) : null,
    fName: row.f_name ? String(row.f_name) : null,
    lName: row.l_name ? String(row.l_name) : null,
    email: row.email ? String(row.email) : null,
    created: String(row.created ?? ""),
  };
}

export function oldUserDisplayName(user: OldUser) {
  if (user.name?.trim()) {
    return user.name.trim();
  }

  const fullName = [user.fName, user.lName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  if (fullName) {
    return fullName;
  }

  return user.email?.trim() || "Unknown user";
}
