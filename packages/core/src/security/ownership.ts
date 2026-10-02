import { logStage } from "../log";
import type { BankConfig, Entry } from "../model/types";

export function resolveOwnership(org: string | undefined, config: BankConfig): Entry["ownership"] {
  logStage("ownership", "in", { org });
  const ownership = !org
    ? "unknown"
    : config.orgs.client.includes(org)
      ? "client"
      : config.orgs.personal.includes(org)
        ? "personal"
        : "unknown";
  logStage("ownership", "out", { ownership });
  return ownership;
}

export function crossOrgBlocked(ownership: Entry["ownership"], entryOrg: string | undefined, targetOrg: string | undefined): boolean {
  if (ownership === "personal") return false;
  if (!entryOrg || !targetOrg) return true;
  return entryOrg !== targetOrg;
}
