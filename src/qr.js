/** Fixed version-6/L byte-mode QR symbols for device pairing links [H1,H17]. */
import { Refused } from './refused.js';

/** Multiply in QR's GF(256), with the primitive polynomial x^8+x^4+x^3+x^2+1. */
function multiply(a, b) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) value ^= a;
    b >>>= 1;
    a <<= 1;
    if (a & 256) a ^= 0x11d;
  }
  return value;
}

/** Produce the eighteen Reed-Solomon check bytes required by each version-6/L block. */
function parity(data) {
  let generator = [1];
  let root = 1;
  for (let degree = 0; degree < 18; degree++) {
    const next = Array(generator.length + 1).fill(0);
    generator.forEach((value, index) => { next[index] ^= value; next[index + 1] ^= multiply(value, root); });
    generator = next;
    root = multiply(root, 2);
  }
  const check = Array(18).fill(0);
  for (const value of data) {
    const leading = value ^ check.shift();
    check.push(0);
    generator.slice(1).forEach((coefficient, index) => { check[index] ^= multiply(coefficient, leading); });
  }
  return check;
}

/** Encode a bounded pairing URL without fetching an image or sending its key to any service. */
export function qrModules(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 134) throw new Refused('PAIR_LINK_LONG', 'the pairing address is too long for the printed QR code; open the printed link');
  const bits = [0, 1, 0, 0];
  /** Append one big-endian field to the byte-mode segment. */
  const append = (value, width) => { for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1); };
  append(bytes.length, 8);
  for (const value of bytes) append(value, 8);
  for (let count = 0; count < 4 && bits.length < 1088; count++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let start = 0; start < bits.length; start += 8) data.push(bits.slice(start, start + 8).reduce((value, bit) => value * 2 + bit, 0));
  while (data.length < 136) data.push(data.length % 2 === Math.ceil(bits.length / 8) % 2 ? 0xec : 0x11);
  const blocks = [data.slice(0, 68), data.slice(68)];
  const checks = blocks.map(parity);
  const codewords = [];
  for (let index = 0; index < 68; index++) for (const block of blocks) codewords.push(block[index]);
  for (let index = 0; index < 18; index++) for (const check of checks) codewords.push(check[index]);
  const size = 41;
  const matrix = Array.from({ length: size }, () => Array(size).fill(null));
  /** Mark one reserved module, clipping finder separators at the outer edges. */
  const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) matrix[y][x] = Boolean(dark); };
  for (let index = 0; index < size; index++) { set(6, index, index % 2 === 0); set(index, 6, index % 2 === 0); }
  for (const [x, y] of [[3, 3], [37, 3], [3, 37]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      set(x + dx, y + dy, distance !== 2 && distance !== 4);
    }
  }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(34 + dx, 34 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  let remainder = 8; // L error correction (01), mask 0 (000).
  for (let index = 0; index < 10; index++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const format = ((8 << 10) | remainder) ^ 0x5412;
  /** Read a format bit in its least-significant-first placement order. */
  const formatBit = (index) => (format >>> index) & 1;
  for (let index = 0; index < 6; index++) set(8, index, formatBit(index));
  set(8, 7, formatBit(6)); set(8, 8, formatBit(7)); set(7, 8, formatBit(8));
  for (let index = 9; index < 15; index++) set(14 - index, 8, formatBit(index));
  for (let index = 0; index < 8; index++) set(size - 1 - index, 8, formatBit(index));
  for (let index = 8; index < 15; index++) set(8, size - 15 + index, formatBit(index));
  set(8, size - 8, true);
  let cursor = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset++) {
        const x = right - offset;
        if (matrix[y][x] !== null) continue;
        const bit = cursor < codewords.length * 8 ? (codewords[cursor >>> 3] >>> (7 - (cursor & 7))) & 1 : 0;
        matrix[y][x] = Boolean(bit ^ ((x + y) % 2 === 0));
        cursor++;
      }
    }
  }
  return matrix;
}

/** Print square modules with a four-module white quiet zone, two rows per terminal character. */
export function terminalQr(text) {
  const modules = qrModules(text);
  /** A module outside the symbol is part of its scanner-visible white quiet zone. */
  const dark = (x, y) => Boolean(modules[y]?.[x]);
  const lines = [];
  for (let y = -4; y < 45; y += 2) {
    let line = '';
    for (let x = -4; x < 45; x++) line += [' ', '▀', '▄', '█'][Number(dark(x, y)) + 2 * Number(dark(x, y + 1))];
    lines.push('\x1b[30;47m' + line + '\x1b[0m');
  }
  return lines.join('\n');
}
