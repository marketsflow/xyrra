import {
  isValidEmail,
  mapEmailListMemberRow,
  type EmailListMember,
} from "../lib/email/email-lists";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayName(value: string | null) {
  if (!value?.trim()) {
    return '<span class="xa-muted">—</span>';
  }
  return escapeHtml(value);
}

export function bindEmailListMembers(options: {
  membersBodyId: string;
  memberCountId?: string;
  emptyMessage?: string;
  onRemove?: (memberId: string) => Promise<void> | void;
}) {
  let members: EmailListMember[] = [];

  function render() {
    const tbody = document.getElementById(options.membersBodyId);
    const countEl = options.memberCountId
      ? document.getElementById(options.memberCountId)
      : null;

    if (countEl) {
      countEl.textContent = `${members.length} member${members.length === 1 ? "" : "s"}`;
    }

    if (!tbody) return;

    if (members.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="xa-users__empty">${escapeHtml(options.emptyMessage ?? "No members added yet.")}</td></tr>`;
      return;
    }

    tbody.innerHTML = members
      .map(
        (member) => `
          <tr>
            <td>${displayName(member.name)}</td>
            <td>${escapeHtml(member.email)}</td>
            <td>
              <button type="button" class="xa-admin__signout xa-email-list__remove" data-member-id="${escapeHtml(member.id)}">
                Remove
              </button>
            </td>
          </tr>
        `,
      )
      .join("");

    tbody.querySelectorAll<HTMLButtonElement>("[data-member-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const memberId = button.dataset.memberId;
        if (!memberId) return;
        void options.onRemove?.(memberId);
      });
    });
  }

  return {
    setMembers(nextMembers: EmailListMember[]) {
      members = nextMembers;
      render();
    },
    getMembers() {
      return members;
    },
    addMember(member: EmailListMember) {
      members = [...members, member];
      render();
    },
    removeMember(memberId: string) {
      members = members.filter((member) => member.id !== memberId);
      render();
    },
    render,
  };
}

export function readMemberForm(form: HTMLFormElement) {
  const nameInput = form.querySelector<HTMLInputElement>('input[name="member-name"]');
  const emailInput = form.querySelector<HTMLInputElement>('input[name="member-email"]');
  return {
    name: nameInput?.value.trim() ?? "",
    email: emailInput?.value.trim() ?? "",
    clear() {
      if (nameInput) nameInput.value = "";
      if (emailInput) emailInput.value = "";
      emailInput?.focus();
    },
  };
}

export function validateMemberInput(email: string, existingEmails: string[]) {
  if (!email) {
    return "Email is required.";
  }
  if (!isValidEmail(email)) {
    return "Enter a valid email address.";
  }
  const normalized = email.toLowerCase();
  if (existingEmails.some((value) => value.toLowerCase() === normalized)) {
    return "This email is already on the list.";
  }
  return null;
}

export function mapMemberRows(rows: Record<string, unknown>[]) {
  return rows.map(mapEmailListMemberRow);
}
