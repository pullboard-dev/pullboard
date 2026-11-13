/** Candidate-only and differing-diagnostic failures keep their verdicts and wording [V4,B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture } from '../../../../tests/fixtures/affected.js';
import { cli } from '../../../../tests/fixtures/affected.js';
import { settledSubmit } from '../../../../tests/fixtures/affected.js';
import { rows } from '../../../../tests/fixtures/affected.js';
import { runCliInProcess } from '../../../../tests/fixtures/process.js';

const FILE = 'test/affected.test.js';
const NAME = 'affected case [G1]';

/** Invoke ordinary text mode, retaining its first output line separately from diagnostics. */
async function text(box, ...args) {
  return await runCliInProcess(args, { cwd: box.builder, env: box.env });
}

/** Exact wording, case identity and receipt custody are shared by both command documents. */
function notice(value, box, { owner, only = false } = {}) {
  assert.equal(value.file, FILE);
  assert.equal(value.name, NAME);
  assert.equal(value.main, box.main);
  const expected = only ? `fails only with your change: ${FILE} :: ${NAME}` : `also fails on main at ${box.main}: ${FILE} :: ${NAME}`;
  // The pulled path names the main test job that judged the case, not a receipt id [P7,C7].
  assert.ok(value.message.startsWith(expected), value.message);
  assert.match(value.message, /main test job test:[a-f0-9]+:[a-f0-9]+\)$|\(not yours; test job test:[a-f0-9]+:[a-f0-9]+\)$/u);
  assert.equal(value.status, only ? 'candidate-only' : 'also-main');
}

test('candidate-only failures stay red, are first in text, and remain structured on refusal [V4,B3,C7]', async t => {
  const box = fixture(t, { main: 1, candidate: 2 });
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  assert.equal(JSON.parse(tested.stdout).mainFailures.length, 1, tested.stdout);
  notice(JSON.parse(tested.stdout).mainFailures[0], box, { only: true });
  const plain = await text(box, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], /^fails only with your change:/u);
  const settled = await settledSubmit(t, box, { submitted: false });
  assert.equal(settled.submission, null, 'a candidate-only red records no submit');
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.equal(shown.item_status, 'claimed');
  assert.ok(shown.thread.some(entry => entry.type === 'fact' && /Gate job \S+ red/u.test(entry.text) && entry.text.includes(NAME)), JSON.stringify(shown.thread.slice(-4)));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});

test('a case red on both sources with different diagnostics is not described as passing main [V4,B3,C7]', async t => {
  // Name the affected file in the frozen bar: own cases require an exact main failure signature.
  const box = fixture(t, { main: 2, candidate: 3, criterion: 'test/affected.test.js retains its behavior.' });
  const tested = cli(box, box.builder, 'test', FILE, '--compare-main');
  assert.equal(tested.status, 1, tested.stdout + tested.stderr);
  const report = JSON.parse(tested.stdout);
  assert.equal(report.mainFailures.length, 1, tested.stdout);
  assert.equal(report.mainFailures[0].status, 'different-on-main');
  assert.match(report.mainFailures[0].message, /^fails differently with your change:/u);
  assert.doesNotMatch(report.mainFailures[0].message, /not yours|fails only/u);
  const plain = await text(box, 'test', FILE, '--compare-main');
  assert.equal(plain.status, 1, plain.stdout + plain.stderr);
  assert.match(plain.stdout.split('\n')[0], /^fails differently with your change:/u);
  // The pulled gate keeps the item red and names the case as failing differently on main, never as main's own [V4,B3,P7].
  const settled = await settledSubmit(t, box, { submitted: false });
  assert.equal(settled.submission, null, 'a red that differs from main records no submit');
  const shown = JSON.parse(cli(box, box.root, 'show', String(box.item)).stdout);
  assert.equal(shown.item_status, 'claimed');
  const red = shown.thread.find(entry => entry.type === 'fact' && /Gate job \S+ red/u.test(entry.text));
  assert.ok(red && !red.text.includes(`also fails on main: proof ${FILE} (${NAME})`), JSON.stringify(shown.thread.slice(-4)));
  assert.equal(rows(box, "SELECT event_id FROM event WHERE item_id=? AND event_kind='submit'", box.item).length, 0);
});
