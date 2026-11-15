import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crashLine } from '../../../src/io/static/checks.js';
import { staticFailures } from '../../../src/io/static/checks.js';

// The text a real crashed registry child writes: the thrown line, its error, its frames, then the version banner.
const crashed = '/repo/packages/gate/src/io/static/registry.js:9\n  throw new Error(\'registry boom\');\n  ^\n\nError: registry boom\n    at runStaticTreeRegistry (/repo/packages/gate/src/io/static/registry.js:9:9)\n\nNode.js v22.22.2\n';

test('a crashed registry child reports its thrown error and location, not the Node.js banner [C7]', () => {
  assert.equal(crashLine(crashed), 'Error: registry boom (at runStaticTreeRegistry (/repo/packages/gate/src/io/static/registry.js:9:9))');
});

test('crashLine falls back to the first line, then to a plain note, when no error line exists [C7]', () => {
  assert.equal(crashLine('boom\nNode.js v22.22.2\n'), 'boom');
  assert.equal(crashLine('\nNode.js v22.22.2\n'), 'no output');
});

test('landing static checks start every independent class before any finishes [C7]', async () => {
  const events = [];
  let release;
  const gate = new Promise(done => { release = done; });
  const slow = async () => { events.push('slow start'); await gate; events.push('slow done'); return ['a']; };
  const fast = async () => { events.push('fast ran'); release(); return ['b']; };
  const rows = await staticFailures([slow, fast]);
  assert.deepEqual(events, ['slow start', 'fast ran', 'slow done']);
  assert.deepEqual(rows, ['a', 'b']);
});

test('the concurrent static classes keep their findings in listed order whichever finishes first [C7]', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const rows = await staticFailures([async () => { await gate; return ['first']; }, async () => { release(); return ['second']; }]);
  assert.deepEqual(rows, ['first', 'second']);
});
