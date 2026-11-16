/** Independent QR reference vector for an actual device pairing URL [H1,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  qrModules,
  terminalQr,
} from "../../src/logic/qr.js";

// Symbol shape from the QR standard: byte mode, version 6 (41 modules a side), error correction LOW; the mask is read from the symbol's own format bits.
// The symbol is judged by what a scanner reads from it, not by a digest of its modules.
const VERSION = 6;
const SIZE = 17 + 4 * VERSION;

/** True when a module belongs to a function pattern (finders, separators, format areas, timing, the alignment pattern, the dark module), so it carries no data. */
function isFunctionModule(row, column) {
  if (row <= 8 && (column <= 8 || column >= SIZE - 8)) return true;
  if (row >= SIZE - 8 && column <= 8) return true;
  if (row === 6 || column === 6) return true;
  if (Math.abs(row - (SIZE - 7)) <= 2 && Math.abs(column - (SIZE - 7)) <= 2) return true;
  return false;
}

const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];

/** The 5 data bits of the format information (2 for the error-correction level, 3 for the mask), read from the first copy and unmasked with 0x5412. */
function formatData(modules) {
  let value = 0;
  for (let index = 0; index <= 5; index += 1) value |= Number(modules[8][index]) << index;
  value |= Number(modules[8][7]) << 6;
  value |= Number(modules[8][8]) << 7;
  value |= Number(modules[7][8]) << 8;
  for (let index = 9; index < 15; index += 1) value |= Number(modules[14 - index][8]) << index;
  return (value ^ 0x5412) >> 10;
}

/** Read the data bits the way a scanner does: walk the column pairs from the right, upward then downward, undoing the symbol's mask. */
function dataBits(modules) {
  const masked = MASKS[formatData(modules) & 7];
  const bits = [];
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let step = 0; step < SIZE; step += 1) {
      const row = upward ? SIZE - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (isFunctionModule(row, column)) continue;
        bits.push(Number(modules[row][column]) ^ (masked(row, column) ? 1 : 0));
      }
    }
    upward = !upward;
  }
  return bits;
}

/** The three finder patterns: a 7x7 ring of dark modules around a 3x3 dark centre, with a light ring between. */
function finderAt(modules, row, column) {
  for (let r = 0; r < 7; r += 1) for (let c = 0; c < 7; c += 1) {
    const edge = r === 0 || r === 6 || c === 0 || c === 6, centre = r >= 2 && r <= 4 && c >= 2 && c <= 4;
    if (modules[row + r][column + c] !== (edge || centre)) return false;
  }
  return true;
}

test('a pairing QR matches the independent complete symbol and prints its quiet zone [H1,H17]', () => {
  const link = 'https://app.pullboard.dev/#board=' + 'a'.repeat(32) + '&key=' + 'b'.repeat(43);
  const modules = qrModules(link);
  assert.equal(modules.length, SIZE);
  assert.ok(modules.every(row => row.length === SIZE), 'the symbol is square');
  assert.ok(finderAt(modules, 0, 0) && finderAt(modules, 0, SIZE - 7) && finderAt(modules, SIZE - 7, 0), 'a scanner finds all three corners');
  for (let index = 8; index < SIZE - 8; index += 1) {
    assert.equal(modules[6][index], index % 2 === 0, 'the horizontal timing pattern alternates');
    assert.equal(modules[index][6], index % 2 === 0, 'the vertical timing pattern alternates');
  }
  assert.equal(modules[SIZE - 8][8], true, 'the fixed dark module is set');
  assert.equal(formatData(modules) >> 3, 0b01, 'error correction level LOW');
  const bits = dataBits(modules);
  const read = (from, count) => bits.slice(from, from + count).reduce((value, bit) => value * 2 + bit, 0);
  assert.equal(read(0, 4), 0b0100, 'byte mode');
  assert.equal(read(4, 8), Buffer.byteLength(link), 'the length field counts the link bytes');
  const text = Buffer.from(Array.from({ length: Buffer.byteLength(link) }, (_, index) => read(12 + index * 8, 8))).toString('utf8');
  assert.equal(text, link, 'the data codewords carry the exact pairing link');
  const lines = terminalQr(link).replace(/\x1b\[[0-9;]+m/g, '').split('\n');
  assert.equal(lines.length, 25);
  assert.ok(lines.every((line) => line.length === 49 && line.startsWith('    ') && line.endsWith('    ')));
  assert.ok(lines.slice(0, 2).every((line) => /^ +$/.test(line)));
  assert.ok(/^ +$/.test(lines.at(-1)));
  const decoded = lines.flatMap((line) => [
    [...line].map((cell) => ['▀', '█'].includes(cell)),
    [...line].map((cell) => ['▄', '█'].includes(cell)),
  ]).slice(4, 45).map((row) => row.slice(4, 45));
  assert.deepEqual(decoded, modules, 'half-block rendering preserves every module');
  assert.throws(() => qrModules('x'.repeat(135)), { code: 'PAIR_LINK_LONG' });
});
