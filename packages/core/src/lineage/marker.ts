const MARKER = /@codebank\s+([a-z0-9][a-z0-9-]{0,47})\s+v(\d+)\s+([a-f0-9]{12})\b/;

export interface ParsedMarker {
  slug: string;
  version: number;
  hash: string;
  start: number;
  end: number;
}

export function parseMarkers(source: string): ParsedMarker[] {
  const found: ParsedMarker[] = [];
  let offset = 0;
  for (const line of source.split("\n")) {
    if (isMarkerLine(line)) {
      const match = line.match(MARKER);
      if (match) {
        found.push({ slug: match[1], version: Number(match[2]), hash: match[3], start: offset, end: offset + line.length });
      }
    }
    offset += line.length + 1;
  }
  return found;
}

export function stripMarkers(source: string): string {
  return source
    .split("\n")
    .filter((line) => !(isMarkerLine(line) && (MARKER.test(line) || /@codebank-end\b/.test(line))))
    .join("\n");
}

function isMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("# ") || trimmed.startsWith("/*") || trimmed.startsWith("<!--");
}
