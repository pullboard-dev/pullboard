/** Settle only an explicitly requested private journey comparison through the public source-bound show result [C7]. */

/** A complete observation preserves both source identities, native run identities and unobserved case differences. */
function complete(result) {
  const source = value => /^[a-f0-9]{40,64}$/u.test(value ?? '');
  const side = value => value && Array.isArray(value.files) && (value.id === null || /^[a-f0-9-]{36}$/u.test(value.id ?? ''));
  return source(result.headCommit) && source(result.baseCommit) && Array.isArray(result.files)
    && side(result.head) && side(result.base)
    && (result.newRed === null && result.fixed === null || Array.isArray(result.newRed) && Array.isArray(result.fixed));
}

/** Whitelist the last public observation; neither a board thread nor private worker requests belong in a timeout. */
function observation(doc, item) {
  const result = doc?.comparison;
  return { item, source: doc?.item_commit ?? null, digest: doc?.item_frozen_digest ?? null,
    comparison: result ? { status: result.status ?? null, item: result.item ?? null, source: result.source ?? null,
      digest: result.digest ?? null, error: result.error ?? null, head: result.head?.id ?? null, base: result.base?.id ?? null } : null };
}

/** Yield between public reads and release the abort listener on either path. */
function changed(signal) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 20); // budget: existing fixture observation interval, never a settlement assumption.
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

/**
 * Await a genuine terminal record for this exact submitted source and frozen digest. Unavailable and unknown stay errors,
 * and missing, pending or foreign records never become an empty passing comparison. Reads use the unrecorded fixture seam
 * so the parity call count is independent of how many observations the detached worker needs. The caller's deadline owns
 * the wait; callers without a signal retain the shared fixture's existing 20-second fallback [C7].
 */
export async function settledComparison(box, item, { signal } = {}) {
  const read = box.run.read ?? box.inProcess ?? box.run;
  const started = performance.now();
  let identity = null, last = { item, state: 'not observed' };
  const failure = message => new Error(`${message}; last comparison observation: ${JSON.stringify(last)}`);
  for (;;) {
    if (signal?.aborted || !signal && performance.now() - started >= 20_000) throw failure('comparison did not settle before the fixture deadline');
    const answer = await read(box.repo, 'show', String(item), '--json', '--no-next');
    let doc = null;
    try { if (answer.code === 0) doc = JSON.parse(answer.out); } catch { /* A missing or partial result remains an observation. */ }
    last = { ...observation(doc, item), code: answer.code };
    if (doc?.item_id === item && doc.item_commit && doc.item_frozen_digest) {
      const current = { source: doc.item_commit, digest: doc.item_frozen_digest };
      identity ??= current;
      if (identity.source !== current.source || identity.digest !== current.digest) throw failure('submitted source or frozen digest changed during comparison settlement');
      const result = doc.comparison;
      if (result?.item === item && result.source === current.source && result.digest === current.digest) {
        if (result.status === 'unavailable' || result.status === 'unknown') throw failure(`comparison ${result.status}: ${result.error ?? 'no execution account'}`);
        if (result.status === 'complete' && complete(result)) return result;
      }
    }
    await changed(signal);
  }
}
