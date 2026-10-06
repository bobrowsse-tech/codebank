import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const width = 1280;
const height = 640;
const pixels = Buffer.alloc(width * height * 4);
const background = [31, 31, 31, 255];
const ink = [232, 232, 232, 255];
const muted = [168, 168, 168, 255];
const panel = [43, 43, 43, 255];

fill(0, 0, width, height, background);
stampIcon(96, 176, 2);

function stampIcon(originX, originY, scale) {
  const mark = Buffer.alloc(128 * 128 * 4, 0);
  const paintMark = (x, y, color) => {
    if (x < 0 || y < 0 || x >= 128 || y >= 128) return;
    const offset = (y * 128 + x) * 4;
    mark[offset] = color[0];
    mark[offset + 1] = color[1];
    mark[offset + 2] = color[2];
    mark[offset + 3] = color[3];
  };
  const fillMark = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) paintMark(x, y, color);
    }
  };
  const fillRoundMark = (x0, y0, x1, y1, radius, color) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (insideRound(x, y, x0, y0, x1, y1, radius)) paintMark(x, y, color);
      }
    }
  };
  fillRoundMark(26, 24, 102, 50, 6, ink);
  fillRoundMark(32, 30, 96, 44, 4, panel);
  fillMark(54, 34, 74, 40, ink);
  fillRoundMark(32, 46, 96, 106, 6, ink);
  fillRoundMark(36, 50, 92, 102, 4, panel);
  fillRoundMark(50, 68, 78, 80, 3, ink);
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const offset = (y * 128 + x) * 4;
      if (mark[offset + 3] === 0) continue;
      fill(originX + x * scale, originY + y * scale, originX + (x + 1) * scale, originY + (y + 1) * scale, [
        mark[offset],
        mark[offset + 1],
        mark[offset + 2],
        255,
      ]);
    }
  }
}

const glyphs = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  b: ["10000", "10000", "11110", "10001", "10001", "10001", "11110"],
  c: ["00000", "00000", "01110", "10000", "10000", "10001", "01110"],
  d: ["00001", "00001", "01111", "10001", "10001", "10001", "01111"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
  h: ["10000", "10000", "10110", "11001", "10001", "10001", "10001"],
  i: ["00000", "00100", "00000", "00100", "00100", "00100", "00100"],
  k: ["10000", "10000", "10010", "10100", "11000", "10100", "10010"],
  l: ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  n: ["00000", "00000", "10110", "11001", "10001", "10001", "10001"],
  o: ["00000", "00000", "01110", "10001", "10001", "10001", "01110"],
  r: ["00000", "00000", "10110", "11001", "10000", "10000", "10000"],
  s: ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
  t: ["00100", "00100", "11111", "00100", "00100", "00101", "00010"],
  u: ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  w: ["00000", "00000", "10001", "10001", "10101", "10101", "01010"],
  y: ["00000", "00000", "10001", "10001", "01111", "00001", "01110"],
};

text("Codebank", 440, 188, 12, ink);
text("Bank reusable code.", 442, 320, 4, muted);
text("Recall it anywhere.", 442, 360, 4, muted);
text("VS Code    CLI    MCP", 442, 430, 4, ink);

const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  const row = y * (width * 4 + 1);
  raw[row] = 0;
  pixels.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr(width, height)),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

const target = path.join(process.cwd(), ".github/social-preview.png");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, png);

function text(value, x, y, scale, color) {
  let cursor = x;
  for (const character of value) {
    const rows = glyphs[character];
    if (!rows) throw new Error(`missing glyph ${character}`);
    rows.forEach((row, rowIndex) => {
      [...row].forEach((bit, column) => {
        if (bit === "1") fill(cursor + column * scale, y + rowIndex * scale, cursor + (column + 1) * scale, y + (rowIndex + 1) * scale, color);
      });
    });
    cursor += 6 * scale;
  }
}

function paint(x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
  pixels[offset + 3] = color[3];
}

function fill(x0, y0, x1, y1, color) {
  const left = Math.max(0, x0);
  const top = Math.max(0, y0);
  const right = Math.min(width, x1);
  const bottom = Math.min(height, y1);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) paint(x, y, color);
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

function ihdr(pngWidth, pngHeight) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(pngWidth, 0);
  data.writeUInt32BE(pngHeight, 4);
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
