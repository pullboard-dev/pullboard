/** Check the real private refusal walk, preserving contextual traversal and source freshness [C7,M1]. */
import assert from 'node:assert/strict';

/** Observe actual local scans without substituting the walk or its result. */
export function assertMachineWalkMemo(codeWalk) {
  const entry = "function entry() {\n  if (true) throw new Refused('MEMO_DIRECT', 'fixture');\n  leaf();\n}";
  let source = entry + "\nfunction leaf() {\n  if (true) throw new Refused('MEMO_LEAF', 'fixture');\n  entry();\n}\n";
  const caughtEntry = "function stateFor() {\n  boardLinkRecord();\n}";
  let caughtScans = 0;
  let reads = 0;
  let entryScans = 0;
  const intrinsic = String.prototype.matchAll;
  /** Count actual scans of this exact synthetic body and forward the original intrinsic unchanged. */
  String.prototype.matchAll = function observedMatchAll(pattern) {
    if (String(this) === entry) entryScans++;
    if (String(this) === caughtEntry) caughtScans++;
    return Reflect.apply(intrinsic, this, arguments);
  };
  try {
    const walk = codeWalk(file => {
      assert.equal(file, 'memo-witness.js');
      reads++;
      return source;
    });
    assert.deepEqual([...walk.refusalsOf('memo-witness.js#entry', new Set(['memo-witness.js#leaf']))].sort(), ['MEMO_DIRECT']);
    assert.ok(entryScans > 0, 'the witness observes the real local-body scanner');
    const scannedOnce = entryScans;
    assert.deepEqual([...walk.refusalsOf('memo-witness.js#entry')].sort(), ['MEMO_DIRECT', 'MEMO_LEAF'],
      'a new caller context still traverses the previously skipped leaf and terminates its cycle');
    assert.equal(entryScans, scannedOnce, 'repeated traversal reuses local facts instead of rescanning the body');
    assert.deepEqual([...walk.refusalsOf('memo-witness.js#entry', new Set(['memo-witness.js#leaf']))].sort(), ['MEMO_DIRECT'],
      'memoized local facts do not retain another caller’s transitive result');
    assert.equal(entryScans, scannedOnce);
    assert.equal(reads, 1, 'the already-existing file cache remains effective within a walk');
    source = source.replace('MEMO_LEAF', 'MEMO_CHANGED');
    const fresh = codeWalk(file => {
      assert.equal(file, 'memo-witness.js');
      reads++;
      return source;
    });
    assert.deepEqual([...fresh.refusalsOf('memo-witness.js#entry')].sort(), ['MEMO_CHANGED', 'MEMO_DIRECT'],
      'a fresh walk reads and scans changed source rather than sharing stale facts');
    assert.ok(entryScans > scannedOnce);
    assert.equal(reads, 2);
    const caughtSources = new Map([
      ['../packages/items/src/logic/cross/repo.js', "import { boardLinkRecord } from '../../../../kernel/src/logic/registry.js';\n" + caughtEntry + '\n'],
      ['../packages/kernel/src/logic/registry.js', "function boardLinkRecord() {\n  throw new Refused('MEMO_CAUGHT', 'fixture');\n}\n"],
    ]);
    const caughtRead = file => {
      assert.ok(caughtSources.has(file), 'use the real named caught boundary with finite synthetic inputs');
      return caughtSources.get(file);
    };
    assert.deepEqual([...codeWalk(caughtRead).refusalsOf('../packages/items/src/logic/cross/repo.js#stateFor')], ['MEMO_CAUGHT']);
    const caughtWalk = codeWalk(caughtRead, { caught: true });
    const beforeCaught = caughtScans;
    assert.deepEqual([...caughtWalk.refusalsOf('../packages/items/src/logic/cross/repo.js#stateFor')], [],
      'the real caught boundary excludes the callee refusal without changing its local facts');
    assert.ok(caughtScans > beforeCaught, 'this caught walk reached its actual local-body scanner');
    const caughtOnce = caughtScans;
    assert.deepEqual([...caughtWalk.refusalsOf('../packages/kernel/src/logic/registry.js#boardLinkRecord')], ['MEMO_CAUGHT'],
      'the callee still raises its refusal when traversed directly');
    assert.deepEqual([...caughtWalk.refusalsOf('../packages/items/src/logic/cross/repo.js#stateFor')], []);
    assert.equal(caughtScans, caughtOnce, 'the caught traversal also reuses its actual local-body scan');

  } finally {
    String.prototype.matchAll = intrinsic;
  }
}
