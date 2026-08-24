export type EmailList = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  memberCount?: number;
};

export type EmailListMember = {
  id: string;
  listId: string;
  name: string | null;
  email: string;
  oldUserId: string | null;
  createdAt: string;
};

export function mapEmailListRow(row: Record<string, unknown>): EmailList {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    memberCount:
      typeof row.member_count === "number"
        ? row.member_count
        : row.email_list_members && Array.isArray(row.email_list_members)
          ? row.email_list_members.length
          : undefined,
  };
}

export function mapEmailListMemberRow(row: Record<string, unknown>): EmailListMember {
  return {
    id: String(row.id),
    listId: String(row.list_id),
    name: row.name ? String(row.name) : null,
    email: String(row.email ?? ""),
    oldUserId: row.old_user_id ? String(row.old_user_id) : null,
    createdAt: String(row.created_at ?? ""),
  };
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
