/** @pullboard-test-input source-cell apps/cli */
/** The tab-speed fixture prints each stage's elapsed milliseconds only when PULLBOARD_TAB_SPEED_TRACE is set, using a stub board and stub Chrome [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { measureTabSpeed } from '../../../tests/fixtures/cockpit/perf/speed.mjs';
import { tabSpeedTrace } from '../../../tests/fixtures/cockpit/perf/speed.mjs';

const PREFIX = 'tab-speed-trace: ';

/** Stub Chrome and view server: every call answers at once, so the run needs no browser. */
function stubDeps() {
  const chrome = {
    send: async () => ({}),
    navigate: async () => {},
    waitFor: async () => true,
    stable: async expression => (String(expression).includes('visibleTab') ? { items: 0 } : undefined),
    close: async () => {},
  };
  return {
    findChromeExecutable: () => '/stub/chrome',
    startChrome: async () => chrome,
    stableChrome: value => value,
    press: async () => {},
    startView: async () => ({ link: { href: 'http://127.0.0.1:1/' } }),
    stopView: async () => {},
  };
}

/** Run measureTabSpeed on a stub board with the variable set or unset; return the trace lines written to stderr. */
async function traceLines(value, tabs) {
  const { root: workspace } = privateFixtureFiles('tab-speed-trace-');
  const previous = process.env.PULLBOARD_TAB_SPEED_TRACE, write = process.stderr.write, lines = [];
  if (value === undefined) delete process.env.PULLBOARD_TAB_SPEED_TRACE; else process.env.PULLBOARD_TAB_SPEED_TRACE = value;
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).startsWith(PREFIX)) { lines.push(String(chunk).trimEnd()); return true; }
    return write.call(process.stderr, chunk, ...rest);
  };
  try { await measureTabSpeed({ workspace }, tabs, stubDeps()); }
  finally {
    process.stderr.write = write;
    if (previous === undefined) delete process.env.PULLBOARD_TAB_SPEED_TRACE; else process.env.PULLBOARD_TAB_SPEED_TRACE = previous;
  }
  return lines;
}

test('clause 1: with PULLBOARD_TAB_SPEED_TRACE=1 measureTabSpeed prints one line per stage with elapsed ms [C7]', async () => {
  const lines = await traceLines('1', ['items', 'roadmap']);
  const labels = lines.map(line => line.slice(PREFIX.length).replace(/ \d+ ms$/, ''));
  assert.deepEqual(labels, ['server start', 'chrome start', 'first load',
    'first click items', 'first click roadmap', 'repeat click items', 'repeat click roadmap',
    'isolation click items', 'isolation click roadmap']);
  for (const line of lines) assert.match(line, /^tab-speed-trace: .+ \d+ ms$/);
});

test('clause 1: with the variable unset measureTabSpeed prints no trace line [C7]', async () => {
  assert.deepEqual(await traceLines(undefined, ['items']), []);
});

test('clause 1: a stage prints its line even when it throws, so board generation and a failed wait are named [C7]', async () => {
  const lines = [], stage = tabSpeedTrace({ PULLBOARD_TAB_SPEED_TRACE: '1' }, line => lines.push(line));
  assert.equal(await stage('board generation', async () => 7), 7);
  await assert.rejects(stage('first load', async () => { throw new Error('boom'); }), /boom/);
  assert.match(lines[0], /^tab-speed-trace: board generation \d+ ms$/);
  assert.match(lines[1], /^tab-speed-trace: first load \d+ ms$/);
});
