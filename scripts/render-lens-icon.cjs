/**
 * 将 media/lens.svg 的 24×24 线条图标光栅化为 Marketplace 要求的 128×128 PNG。
 * 纯 Node/zlib 实现，不依赖 ImageMagick 或原生图像库。
 * 用法：node scripts/render-lens-icon.cjs [输出路径，默认 media/icon.png]
 */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const OUT = 128;
const SUPER = 4;
const HALF = 1.6 / 2;
const COLOR = [47, 125, 246];

/** 计算点到线段的距离，端点使用圆形笔帽。 */
function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

/** 判断超采样像素是否落在任一描边路径上，全程使用 24×24 视图坐标。 */
function covered(x, y) {
  const toView = (v) => ((v + 0.5) * 24) / (OUT * SUPER);
  const p = { x: toView(x), y: toView(y) };
  const circleDistance = Math.abs(Math.hypot(p.x - 10, p.y - 10) - 6.5);
  const paths = [
    [[15, 15], [21, 21]],
    [[7, 8], [5, 10]], [[5, 10], [7, 12]],
    [[13, 8], [15, 10]], [[15, 10], [13, 12]],
    [[11, 7], [9, 17]],
  ];
  if (circleDistance <= HALF) return true;
  return paths.some(([a, b]) => segmentDistance(p.x, p.y, a[0], a[1], b[0], b[1]) <= HALF);
}

/** 生成 RGBA 像素，4 倍超采样后缩小，获得边缘抗锯齿。 */
function rasterize() {
  const result = Buffer.alloc(OUT * OUT * 4);
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      let coverage = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          if (covered(x * SUPER + sx, y * SUPER + sy)) coverage++;
        }
      }
      const alpha = Math.round((255 * coverage) / (SUPER * SUPER));
      const i = (y * OUT + x) * 4;
      result[i] = COLOR[0]; result[i + 1] = COLOR[1]; result[i + 2] = COLOR[2]; result[i + 3] = alpha;
    }
  }
  return result;
}

/** 写入最小合法 PNG 块（长度与 CRC 均为大端）。 */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

/** 编码 128×128 RGBA PNG。 */
function encodePng(pixels) {
  const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
  for (let y = 0; y < OUT; y++) {
    raw.set(Buffer.concat([Buffer.from([0]), pixels.subarray(y * OUT * 4, (y + 1) * OUT * 4)]), y * (OUT * 4 + 1));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(output, encodePng(rasterize()));
console.log(`wrote ${output}`);
