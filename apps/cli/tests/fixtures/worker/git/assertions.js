/** Count completed real worker Git processes, preserving the transfer's semantic assertions [C7]. */
import assert from 'node:assert/strict';

/** Validate one fully drained fixture-worker trace without treating application summaries as process evidence. */
export function assertWorkerTagBatches(rows, expectedRefs, report = () => {}) {
  const tagCount = expectedRefs.length;
  assert.equal(new Set(expectedRefs).size, tagCount, 'the selected tag manifest has unique names');
  const spawned = rows.filter(row => row.phase === 'spawn');
  assert.ok(spawned.length > 0, 'the private preload observed actual Git child launches');
  assert.equal(new Set(spawned.map(row => row.worker)).size, 1, 'scope the witness to the first completed worker job');
  const closed = new Map(rows.filter(row => row.phase === 'close').map(row => [row.ordinal, row]));
  assert.equal(closed.size, spawned.length, 'all observed children actually completed before counting processes');
  for (const row of spawned) {
    const result = closed.get(row.ordinal);
    assert.equal(result.child, row.child, 'the close evidence belongs to the actual launched process');
    assert.equal(result.code, 0, 'the successful source transfer completed its real Git operations');
    assert.equal(result.signal, null);
  }
  const deliveryRefs = row => row.args.filter(arg => /^refs\/pullboard\/tag-delivery\/[^:]+:refs\/tags\//u.test(arg));
  const peeledRefs = row => row.args.filter(arg => /^refs\/tags\/.+\^\{\}$/u.test(arg));
  const fetches = spawned.filter(row => row.args.includes('fetch') && deliveryRefs(row).length);
  const peels = spawned.filter(row => row.args.includes('rev-parse') && peeledRefs(row).length);
  const bodies = spawned.filter(row => row.args.includes('cat-file')
    && (row.args.includes('--batch') || row.args.includes('-p')));
  const counts = { totalGit: spawned.length, tags: tagCount, fetchProcesses: fetches.length,
    peelProcesses: peels.length, annotationBodyProcesses: bodies.length };
  report(counts);
  const batches = Math.ceil(tagCount / 32);
  assert.equal(fetches.reduce((sum, row) => sum + deliveryRefs(row).length, 0), tagCount,
    'the counted Git invocations deliver every selected tag, rather than omitting work');
  assert.equal(peels.reduce((sum, row) => sum + peeledRefs(row).length, 0), tagCount,
    'the counted Git invocations validate every selected tag target');
  assert.deepEqual(fetches.flatMap(deliveryRefs).map(ref => ref.slice(ref.indexOf(':') + 1)).sort(), [...expectedRefs].sort(),
    'the measured fetch work delivers the exact selected ref set');
  assert.deepEqual(peels.flatMap(peeledRefs).map(ref => ref.slice(0, -3)).sort(), [...expectedRefs].sort(),
    'the measured peel work validates the exact selected ref set');
  assert.ok(fetches.length <= batches, 'short tag names may use fewer fetches than fixed groups of 32');
  assert.ok(peels.length <= batches, 'every fetched batch is peeled with no extra per-tag processes');
  assert.equal(fetches.length, peels.length, 'each delivered batch has its own complete peel validation');
  for (const row of [...fetches, ...peels]) {
    assert.ok(row.args.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 4) <= 32_768,
      'each actual Git launch stays within the UTF-8 argument byte budget');
  }
  assert.equal(bodies.length, 1, 'annotation bodies use one real batch process instead of one process per object');
  return counts;
}
