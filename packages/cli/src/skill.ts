import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const targets = {
  claude: ".claude",
  copilot: ".copilot",
  agents: ".agents",
} as const;

const agentsBlock = [
  "## Codebank",
  "Search the bank before writing a reusable helper.",
  "Use `codebank search \"<need>\" --json`, then `codebank get <slug>`.",
  "Keep `@codebank` markers unchanged.",
  "Propose reusable code with `codebank propose`.",
].join("\n");

function defaultSkillSource(): string {
  const starts: string[] = [];
  try {
    starts.push(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // The test bundle is CommonJS, so import.meta.url is empty.
  }
  starts.push(process.cwd());
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      for (const candidate of [
        path.join(dir, "skills", "codebank", "SKILL.md"),
        path.join(dir, "SKILL.md"),
      ]) {
        if (fs.existsSync(candidate)) return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.join(process.cwd(), "skills", "codebank", "SKILL.md");
}

export function installSkill(options: {
  target: keyof typeof targets;
  agentsMd?: boolean;
  cwd?: string;
  homeDir?: string;
  source?: string;
}): string {
  const folder = targets[options.target];
  if (!folder) throw new Error("Target must be claude, copilot, or agents.");
  const source = options.source ?? defaultSkillSource();
  if (!fs.existsSync(source)) throw new Error(`Skill file not found at ${source}.`);
  const destination = path.join(options.homeDir ?? os.homedir(), folder, "skills", "codebank", "SKILL.md");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (options.agentsMd) {
    const agents = path.join(options.cwd ?? process.cwd(), "AGENTS.md");
    const current = fs.existsSync(agents) ? fs.readFileSync(agents, "utf8") : "";
    if (!current.includes("## Codebank")) {
      fs.writeFileSync(agents, `${current.trim() ? `${current.trim()}\n\n` : ""}${agentsBlock}\n`);
    }
  }
  return destination;
}
