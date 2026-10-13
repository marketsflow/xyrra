import { requireAdminSession, setAdminLoading } from "./auth-guard";
import { initAdminShell } from "./shell";

async function init() {
  const session = await requireAdminSession();
  if (!session) return;

  initAdminShell(session, "virtual-trades");
  setAdminLoading(false);
}

void init();
