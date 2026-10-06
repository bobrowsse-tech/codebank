import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const size = 128;
const pixels = Buffer.alloc(size * size * 4, 0);
const background = [31, 31, 31, 255];
const ink = [204, 204, 204, 255];
const panel = [43, 43, 43, 255];

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) paint(x, y, background);
}

fillRound(26, 24, 102, 50, 6, ink);
fillRound(32, 30, 96, 44, 4, panel);
fill(54, 34, 74, 40, ink);
fillRound(32, 46, 96, 106, 6, ink);
fillRound(36, 50, 92, 102, 4, panel);
fillRound(50, 68, 78, 80, 3, ink);

const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) {
  const row = y * (size * 4 + 1);
  raw[row] = 0;
  pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr(size, size)),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = path.join(process.cwd(), "packages/vscode/media/icon.png");
fs.writeFileSync(target, png);

function paint(x, y, color) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const offset = (y * size + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function fill(x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) paint(x, y, color);
  }
}

function fillRound(x0, y0, x1, y1, radius, color) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (insideRound(x, y, x0, y0, x1, y1, radius)) paint(x, y, color);
    }
  }
}

function insideRound(x, y, x0, y0, x1, y1, radius) {
  const left = x < x0 + radius;
  const right = x >= x1 - radius;
  const top = y < y0 + radius;
  const bottom = y >= y1 - radius;
  if (!left && !right && !top && !bottom) return true;
  if ((left || right) && (top || bottom)) {
    const cx = left ? x0 + radius : x1 - radius - 1;
    const cy = top ? y0 + radius : y1 - radius - 1;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  return true;
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc ^ 0xffffffff;
}
