/** Exact Git batch framing protects annotated source-tag custody [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tagObjectBodies } from '../index.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
/** Encode the actual Git batch wire format using byte lengths, not JavaScript character lengths. */
function frame(object, body, type = 'tag') {
  const bytes = Buffer.from(body);
  return Buffer.concat([Buffer.from(`${object} ${type} ${bytes.length}\n`), bytes, Buffer.from('\n')]);
}

test('tag batch preserves ordered exact UTF-8 annotations and final body newlines [C7]', () => {
  const first = 'object ' + B + '\ntype commit\ntag première\n\nmessage 🧭\n';
  const second = 'object ' + A + '\ntype tag\ntag nested\n\nembedded\nheader-looking text\n';
  const result = tagObjectBodies([A, B], Buffer.concat([frame(A, first), frame(B, second)]));
  assert.deepEqual([...result], [[A, first], [B, second]]);
  assert.deepEqual([...tagObjectBodies([], Buffer.alloc(0))], []);
  const sha256 = 'c'.repeat(64);
  assert.equal(tagObjectBodies([sha256], frame(sha256, first)).get(sha256), first);
});

test('tag batch refuses wrong identity, missing objects, wrong type, order and extra frames [C7]', () => {
  for (const bytes of [frame(B, 'one'), Buffer.from(`${A} missing\n`), frame(A, 'one', 'commit'),
    Buffer.concat([frame(B, 'two'), frame(A, 'one')]), Buffer.concat([frame(A, 'one'), frame(B, 'two')]),
    Buffer.concat([frame(A, 'one'), Buffer.from('\n')])]) {
    assert.throws(() => tagObjectBodies([A], bytes));
  }
  assert.throws(() => tagObjectBodies([], frame(A, 'unexpected')));
  assert.throws(() => tagObjectBodies([A, A], Buffer.concat([frame(A, 'one'), frame(A, 'two')])));
  assert.throws(() => tagObjectBodies([A], 'not raw bytes'));
});

test('tag batch refuses truncated bodies, invalid sizes and nonexact framing [C7]', () => {
  for (const bytes of [Buffer.from(`${A} tag 3\nab`), Buffer.from(`${A} tag 3\nabc`),
    Buffer.from(`${A} tag 3\nabcX`), Buffer.from(`${A} tag 2\n🧭\n`),
    Buffer.from(`${A} tag -1\n\n`), Buffer.from(`${A} tag 01\na\n`),
    Buffer.from(`${A} tag 9007199254740992\n\n`), Buffer.from(`${A} tag 134217729\n\n`),
    Buffer.from(`${A} tag 1\r\nx\n`), Buffer.from(`${A} tag ${'9'.repeat(100)}\n\n`)]) {
    assert.throws(() => tagObjectBodies([A], bytes));
  }
});
