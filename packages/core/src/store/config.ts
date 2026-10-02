import fs from "node:fs";
import path from "node:path";
import { logStage } from "../log";
import { defaultConfig, parseConfig } from "../model/validate";
import type { BankConfig } from "../model/types";
import { atomicWriteJson, readJson } from "./atomic";
import { bankPaths } from "./paths";

export function ensureHome(home: string): BankConfig {
  const paths = bankPaths(home);
  fs.mkdirSync(paths.entries, { recursive: true });
  fs.mkdirSync(paths.inbox, { recursive: true });
  fs.mkdirSync(paths.lineage, { recursive: true });
  fs.mkdirSync(path.dirname(paths.usage), { recursive: true });
  fs.mkdirSync(path.dirname(paths.index), { recursive: true });
  if (!fs.existsSync(paths.config)) {
    const config = defaultConfig();
    atomicWriteJson(paths.config, config);
    logStage("config", "out", { created: paths.config });
    return config;
  }
  return loadConfig(home);
}

export function loadConfig(home: string): BankConfig {
  const file = bankPaths(home).config;
  logStage("config", "in", { file });
  const config = parseConfig(readJson(file), file);
  logStage("config", "out", { consented: config.model.consented, recall: config.recall.enabled });
  return config;
}

export function saveConfig(home: string, config: BankConfig): void {
  atomicWriteJson(bankPaths(home).config, config);
  logStage("config", "out", { saved: true });
}
