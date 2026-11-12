import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultSerializer } from 'node:v8';
import { rawOutputObserver } from '../../src/io/watchdog.js';
import { runLegacy } from '../fixtures/watchdog/legacy.js';

test('protocol-only frames never count as output, including split headers [C7,V10]', () => {
  const serializer = new DefaultSerializer();
  serializer.writeHeader();
  const header = serializer.releaseBuffer();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(3);
  const frame = Buffer.concat([header, length, Buffer.from([1, 2, 3])]);
  let count = 0;
  const observe = rawOutputObserver(() => count++);
  for (const byte of frame) observe(Buffer.from([byte]));
  assert.equal(count, 0);
  observe(Buffer.from('actual output'));
  assert.equal(count, 1);
});

test('coverage attributes descendant output to the correct worker [C7,V10]', t => runLegacy(t, 'coverage'));
