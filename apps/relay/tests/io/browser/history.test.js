/** Background checkpoints never rewind the live phone cursor or pretend partial history is complete [H15,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPhoneHistory } from '../../../index.js';

/** Expose one explicit transition instead of relying on a timing-based confidence wait. */
function deferred() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

/** A controlled page iterator pauses after its current presentation and then yields real history-shaped records. */
function page(id, gate = null, total = 3) {
  const entered = deferred(), closed = deferred();
  let runs = 0, pruned = 0;
  return { id, total, entered: entered.promise, closed: closed.promise,
    /** Every message and detail remains tagged with the checkpoint that produced it. */
    async *history() {
      runs++;
      try {
        yield { kind: 'presentation', value: { state: { marker: id } } };
        entered.resolve();
        if (gate) await gate.promise;
        yield { kind: 'table', name: 'shout', rows: [{ shout_id: 2, shout_text: id + '-answer', shout_decision: 0, shout_answers: 1 }] };
        yield { kind: 'table', name: 'shout', rows: [{ shout_id: 1, shout_text: id + '-question', shout_decision: 1, shout_answers: null }] };
        yield { kind: 'items', rows: [{ id: 7, marker: id, history: [] }] };
        yield { kind: 'complete' };
      } finally { closed.resolve(); }
    },
    /** Count eviction only when the fully streamed graph still governs the screen. */
    prune() { pruned++; },
    counts() { return { runs, pruned }; },
  };
}

test('history finishes a pinned predecessor while newer moves keep their own current state [H15,H17]', async t => {
  const aGate = deferred(), bGate = deferred();
  const a = page('a', aGate), b = page('b', bGate);
  let current = { id: 'a', sequence: 7 }, alive = true;
  const installed = [], failures = [], done = deferred();
  let changes = 0;
  let history;
  history = createPhoneHistory({ active: () => alive, current: () => current,
    install(value, details) { installed.push({ marker: value.state.marker, current: current.id, sequence: current.sequence, full: Boolean(details) }); },
    changed() { changes++; if (history.status().complete && history.status().sequence === 8) done.resolve(); },
    failed(error) { failures.push(error.message); },
  });
  t.after(() => { alive = false; history.close(); aGate.resolve(); bGate.resolve(); });
  history.queue(a, 7); history.start(); await a.entered;
  current = { id: 'b', sequence: 8 };
  history.queue(b, 8); history.start(); aGate.resolve(); await b.entered;
  assert.deepEqual(installed.map(value => value.marker), ['a', 'b'], 'the completed predecessor did not replace the successor');
  current.sequence = 9;
  bGate.resolve(); await done.promise;
  assert.equal(current.sequence, 9, 'the history consumer never owns or rewinds the live cursor');
  assert.deepEqual(installed.map(value => value.full), [false, false], 'a checkpoint behind a new live move cannot overwrite its current presentation at completion');
  assert.deepEqual(history.status(), { loaded: 3, total: 3, complete: true, sequence: 8 });
  assert.equal(history.item(7).marker, 'b');
  assert.equal(history.shout(1).decision_answer.shout_text, 'b-answer');
  assert.deepEqual(failures, []);
  assert.deepEqual(a.counts(), { runs: 1, pruned: 0 });
  assert.deepEqual(b.counts(), { runs: 1, pruned: 1 });
  const before = changes;
  history.queue(b, 8); history.start();
  assert.equal(b.counts().runs, 1, 'a completed checkpoint is not streamed repeatedly by foreground reads');
  assert.equal(changes, before, 'a foreground read of completed history cannot emit another refresh and create an RPC feedback loop');
});

test('access loss discards held details and late background results cannot install or advertise completion [H15,H17]', async () => {
  const gate = deferred(), source = page('removed', gate);
  let alive = true, installs = 0, failures = 0;
  const current = { id: 'removed', sequence: 1 };
  const history = createPhoneHistory({ active: () => alive, current: () => current,
    install() { installs++; }, changed() {}, failed() { failures++; },
  });
  history.queue(source, 1); history.start(); await source.entered;
  alive = false; current.id = undefined; history.close(); gate.resolve(); await source.closed;
  assert.equal(installs, 1); assert.equal(failures, 0);
  assert.equal(history.item(7), null); assert.equal(history.shout(1), null);
  assert.deepEqual(history.status(), { loaded: 0, total: null, complete: false, sequence: null });
});

test('partial history retains a readable current board and reports a failed incomplete progress state [H15,H17]', async t => {
  const source = page('partial', null, 4), failed = deferred();
  let current = null, history;
  history = createPhoneHistory({ active: () => true, current: () => ({ id: 'partial', sequence: 2 }),
    install(value) { current = value; }, changed() {}, failed(error) { failed.resolve(error); },
  });
  t.after(() => history.close());
  history.queue(source, 2); history.start();
  assert.match((await failed.promise).message, /incomplete/u);
  assert.equal(current.state.marker, 'partial');
  assert.equal(history.status().complete, false);
  assert.equal(history.status().loaded, 3);
  assert.equal(history.status().total, 4);
  assert.match(history.status().error, /Older history/u);
  assert.equal(history.item(7), null, 'an incomplete stream never becomes completed detail authority');
});
