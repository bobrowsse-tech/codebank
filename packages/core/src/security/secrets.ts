import { createHash } from "node:crypto";
import { logStage } from "../log";

export interface SecretFinding {
  kind: string;
  severity: "block" | "warn";
  hash: string;
  line: number;
}

export function scanSecrets(source: string): SecretFinding[] {
  logStage("secrets", "in", { chars: source.length });
  const findings: SecretFinding[] = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) add(findings, "private-key", "block", line, lineNo);
    if (/\bAKIA[0-9A-Z]{16}\b/.test(line)) add(findings, "aws-access-key", "block", line, lineNo);
    if (/gh[pousr]_[A-Za-z0-9_]{36,}/.test(line)) add(findings, "github-token", "block", line, lineNo);
    if (/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(line)) add(findings, "jwt", "block", line, lineNo);
    if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(line)) add(findings, "url-credential", "block", line, lineNo);
    const assignment = line.match(/\b([A-Za-z0-9_]*(?:key|secret|token|password)[A-Za-z0-9_]*)\b\s*[:=]\s*['"]([^'"]{8,})['"]/i);
    if (assignment) add(findings, "assigned-secret", "block", assignment[2], lineNo);
    for (const quoted of line.matchAll(/['"]([^'"]{32,})['"]/g)) {
      const value = quoted[1];
      if (shannon(value) > 4.2) add(findings, "high-entropy", "block", value, lineNo);
    }
    if (/\b(?:localhost|intranet|\.internal|\.local|\.corp|\.lan)\b/i.test(line) || /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}\b/.test(line)) {
      add(findings, "internal-host", "warn", line, lineNo);
    }
  });
  logStage("secrets", "out", { blocks: findings.filter((finding) => finding.severity === "block").length });
  return findings;
}

function add(findings: SecretFinding[], kind: string, severity: "block" | "warn", value: string, line: number): void {
  const hash = createHash("sha256").update(`${kind}\n${value}`).digest("hex").slice(0, 16);
  if (findings.some((finding) => finding.hash === hash)) return;
  findings.push({ kind, severity, hash, line });
}

function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}
