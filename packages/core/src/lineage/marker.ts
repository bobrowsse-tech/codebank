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

export function markerBody(source: string, slug: string): string | undefined {
  const marker = parseMarkers(source).find((item) => item.slug === slug);
  if (!marker) return undefined;
  const bodyStart = marker.end < source.length && source[marker.end] === "\n" ? marker.end + 1 : marker.end;
  const end = endMarkerSpan(source, marker.end);
  return source.slice(bodyStart, end ? end.start : source.length);
}

export function endMarkerSpan(source: string, from: number): { start: number; end: number } | undefined {
  let offset = from < source.length && source[from] === "\n" ? from + 1 : from;
  for (const line of source.slice(offset).split("\n")) {
    if (isEndMarkerLine(line)) return { start: offset, end: offset + line.length };
    offset += line.length + 1;
  }
  return undefined;
}

export function occursOnce(source: string, needle: string): boolean {
  if (!needle) return false;
  const start = source.indexOf(needle);
  return start !== -1 && source.indexOf(needle, start + needle.length) === -1;
}

export function stripMarkers(source: string): string {
  return source
    .split("\n")
    .filter((line) => !((isMarkerLine(line) && MARKER.test(line)) || isEndMarkerLine(line)))
    .join("\n");
}

function isEndMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("//")) return trimmed.slice(2).trim() === "@codebank-end";
  if (trimmed.startsWith("# ")) return trimmed.slice(1).trim() === "@codebank-end";
  if (trimmed.startsWith("/*") && trimmed.endsWith("*/")) return trimmed.slice(2, -2).trim() === "@codebank-end";
  if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) return trimmed.slice(4, -3).trim() === "@codebank-end";
  return false;
}

function isMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("# ") || trimmed.startsWith("/*") || trimmed.startsWith("<!--");
}
