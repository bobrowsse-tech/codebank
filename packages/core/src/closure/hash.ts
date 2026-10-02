import { createHash } from "node:crypto";
import { normalize } from "./normalize";
import type { SourceFile } from "../model/types";

export function contentHash(files: SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relPath.localeCompare(right.relPath))) {
    hash.update(file.relPath);
    hash.update("\n");
    hash.update(normalize(file.content));
  }
  return hash.digest("hex").slice(0, 12);
}
