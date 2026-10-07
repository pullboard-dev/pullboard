/** Independent QR reference vector for an actual device pairing URL [H1,H17]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { qrModules, terminalQr } from '../src/qr.js';

// Reference: Project Nayuki byte-mode, version 6, LOW, mask 0, no ECC boost.
// https://github.com/nayuki/QR-Code-generator/blob/master/python/qrcodegen.py
// Reference source SHA256: 9f4ed1dd201dcb92b1bc0d6e14f46c754bcff0ce48580c5d7e8ace8f6926c8ef
// Only this independent vector is needed at runtime; no external generator or image service.
test('a pairing QR matches the independent complete symbol and prints its quiet zone [H1,H17]', () => {
  const link = 'https://app.pullboard.dev/#board=' + 'a'.repeat(32) + '&key=' + 'b'.repeat(43);
  const modules = qrModules(link);
  const bits = modules.flat().map(Number).join('');
  assert.equal(createHash('sha256').update(bits).digest('hex'), '70689b83f53e6813762b77ad38f85359a99ce51b6b290173ef520335fa86fb37');
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
