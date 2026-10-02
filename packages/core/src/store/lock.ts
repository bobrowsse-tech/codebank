import fs from "node:fs";
import { tuning } from "../tuning";

export async function withLock<T>(lockPath: string, fn: () => Promise<T> | T): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      clearStale(lockPath);
      if (Date.now() - started > tuning.lockStaleMs + 2_000) {
        throw new Error("Codebank lock is held. Retry when the other write finishes.");
      }
      await delay(20);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // The stale-lock path may already have removed it.
    }
  }
}

function clearStale(lockPath: string): void {
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > tuning.lockStaleMs) fs.unlinkSync(lockPath);
  } catch {
    // Another writer removed it between the stat and the unlink.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
