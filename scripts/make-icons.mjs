// Rasterizes the app icon (same shape as public/icon.svg) to PNG without extra dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function render(size) {
  const ss = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const inShape = (x, y) => {
    // Parallelogram (120,384) (214,128) (392,128) (298,384) in a 512 box.
    if (y < 128 || y > 384) return false;
    const t = (384 - y) / 256;
    return x >= 120 + 94 * t && x <= 298 + 94 * t;
  };
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 512;
          const y = ((py + (sy + 0.5) / ss) / size) * 512;
          if (inShape(x, y)) {
            const t = (x + y) / 1024;
            r += 0x0a + (0xbf - 0x0a) * t;
            g += 0x84 + (0x5a - 0x84) * t;
            b += 0xff + (0xf2 - 0xff) * t;
          } else {
            r += 0x0b; g += 0x0d; b += 0x12;
          }
        }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const n = ss * ss;
      raw[o] = r / n; raw[o + 1] = g / n; raw[o + 2] = b / n; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), render(size));
console.log('icons written');
