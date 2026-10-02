import fs from "node:fs";
import path from "node:path";

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function atomicWrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function atomicWriteJson(file: string, value: unknown): void {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}
