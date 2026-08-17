import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "extension", "icons");
const sizes = [16, 32, 48, 128];
const colors = {
  red: [220, 55, 47],
  yellow: [245, 180, 0],
  green: [24, 166, 88],
  blue: [50, 104, 225],
};

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function png(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]), rgba.subarray(y * width * 4, (y + 1) * width * 4));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function blend(pixel, color, alpha) {
  const inverse = 1 - alpha;
  pixel[0] = Math.round(pixel[0] * inverse + color[0] * alpha);
  pixel[1] = Math.round(pixel[1] * inverse + color[1] * alpha);
  pixel[2] = Math.round(pixel[2] * inverse + color[2] * alpha);
  pixel[3] = Math.round(255 * (alpha + (pixel[3] / 255) * inverse));
}

function render(size, colorName, faceColor) {
  const scale = 4;
  const width = size * scale;
  const pixels = new Uint8Array(width * width * 4);
  const center = width / 2;
  const radius = width * 0.43;
  const foreground = colorName === "yellow" ? [35, 40, 50] : [255, 255, 255];
  const set = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= width) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
    const pixel = pixels.subarray(offset, offset + 4);
    blend(pixel, color, alpha);
  };
  const circle = (cx, cy, r, color) => {
    const minimumX = Math.floor(cx - r - 1);
    const maximumX = Math.ceil(cx + r + 1);
    const minimumY = Math.floor(cy - r - 1);
    const maximumY = Math.ceil(cy + r + 1);
    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const alpha = Math.max(0, Math.min(1, r + 0.75 - distance));
        if (alpha) set(x, y, color, alpha);
      }
    }
  };
  const stroke = (points, thickness, color) => {
    for (const [x, y] of points) circle(x, y, thickness / 2, color);
  };

  circle(center, center, radius + width * 0.025, faceColor.map((channel) => Math.round(channel * 0.72)));
  circle(center, center - width * 0.008, radius, faceColor);
  circle(center - radius * 0.35, center - radius * 0.22, radius * 0.105, foreground);
  circle(center + radius * 0.35, center - radius * 0.22, radius * 0.105, foreground);

  const smile = [];
  for (let step = 0; step <= 64; step += 1) {
    const angle = Math.PI * (0.16 + (0.68 * step) / 64);
    smile.push([
      center + Math.cos(angle) * radius * 0.49,
      center + radius * 0.03 + Math.sin(angle) * radius * 0.5,
    ]);
  }
  stroke(smile, Math.max(scale * 1.6, radius * 0.105), foreground);

  const downsampled = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const source = (((y * scale + sy) * width) + x * scale + sx) * 4;
          for (let channel = 0; channel < 4; channel += 1) totals[channel] += pixels[source + channel];
        }
      }
      const target = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        downsampled[target + channel] = Math.round(totals[channel] / (scale * scale));
      }
    }
  }
  return png(size, size, downsampled);
}

mkdirSync(output, { recursive: true });
for (const [colorName, faceColor] of Object.entries(colors)) {
  for (const size of sizes) {
    writeFileSync(resolve(output, `smile-${colorName}-${size}.png`), render(size, colorName, faceColor));
  }
}

console.log(`Generated ${Object.keys(colors).length * sizes.length} npc-moneyhand smile icons.`);
