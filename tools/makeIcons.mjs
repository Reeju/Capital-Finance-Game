// Draws the app icon into PNGs with a tiny pure-JS rasteriser (no image dependency).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
function crc(buf) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = t[(x ^ b) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); }
function png(size, pad) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= size || y >= size) return; const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, 15, 23, 36);
  const s = (size * (1 - 2 * pad)) / 512, o = size * pad;
  const disc = (cx, cy, r, col) => { for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, ...col); };
  const pts = [[96, 368], [196, 256], [268, 316], [416, 144]].map(([x, y]) => [o + x * s, o + y * s]);
  for (let i = 0; i < pts.length - 1; i++) { const [x0, y0] = pts[i], [x1, y1] = pts[i + 1]; const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)); for (let k = 0; k <= n; k++) disc(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 20 * s, [242, 193, 78]); }
  disc(pts[3][0], pts[3][1], 34 * s, [242, 193, 78]);
  disc(pts[0][0], pts[0][1], 22 * s, [127, 209, 174]);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(`${out}/icon-192.png`, png(192, 0.1));
writeFileSync(`${out}/icon-512.png`, png(512, 0.1));
writeFileSync(`${out}/apple-touch-icon.png`, png(180, 0.1));
