/** Stream history beside the current board, without owning or rewinding its live move cursor [H15,H17]. */

/** Hold one completed checkpoint plus the latest requested successor; old reads may finish while moves keep arriving. */
export function createPhoneHistory({ active, current, install, changed, failed }) {
  let pending = null, running = null, busy = false, closed = false, complete = null;
  let progress = { loaded: 0, total: null, complete: false, sequence: null };
  let lastPaint = 0;

  /** Publish progress only for the checkpoint the current screen actually uses. */
  function report(job, loaded, done = false, error = null) {
    if (closed || current().id !== job.page.id) return;
    progress = { loaded, total: job.page.total, complete: done, sequence: job.sequence, ...(error ? { error } : {}) };
    const now = Date.now();
    // Budget: coalesce background progress to at most five paints per second; completion is always immediate.
    if (done || error || now - lastPaint >= 200) { lastPaint = now; changed(); }
  }

  /** Consume one page iterator independently of the foreground per-board send/cursor queue. */
  async function consume() {
    try {
      while (pending && !closed && active()) {
        const job = pending; pending = null; running = job;
        const tables = new Map(), details = new Map();
        let loaded = 0, full = null, ended = false;
        try {
          for await (const chunk of job.page.history()) {
            if (closed || !active()) return;
            if (chunk.kind === 'presentation') {
              full = chunk.value;
              if (current().id === job.page.id && current().sequence === job.sequence) install(full, null);
            } else if (chunk.kind === 'table') {
              const rows = tables.get(chunk.name) ?? [];
              rows.push(...chunk.rows); tables.set(chunk.name, rows); loaded += chunk.rows.length;
            } else if (chunk.kind === 'items') {
              for (const item of chunk.rows) details.set(item.id, item);
              loaded += chunk.rows.length;
            } else if (chunk.kind === 'complete') ended = true;
            report(job, loaded);
            // Give first paint, live events and person actions a turn between bounded history batches.
            await new Promise(resolveTurn => setTimeout(resolveTurn, 0));
          }
          if (!ended || loaded !== job.page.total) throw new Error('The background history was incomplete. Open this board again to retry.');
          const ordered = new Map([...tables].map(([name, rows]) => [name, rows.reverse()]));
          const shouts = new Map((ordered.get('shout') ?? []).map(row => [row.shout_id, row]));
          const answers = new Map();
          for (const row of shouts.values()) if (row.shout_answers !== null && !answers.has(row.shout_answers)) answers.set(row.shout_answers, row);
          complete = { id: job.page.id, sequence: job.sequence, tables: ordered, details, shouts, answers };
          if (current().id === job.page.id && current().sequence === job.sequence) install(full, details);
          if (current().id === job.page.id) job.page.prune?.();
          report(job, loaded, true);
        } catch (error) {
          if (!closed && active()) { report(job, loaded, false, 'Older history did not finish loading. Open this board again to retry.'); failed(error); }
        } finally { running = null; }
      }
    } finally { busy = false; }
  }

  /** Start after the renderer has received its transport; at most one history consumer runs for a board. */
  function start() {
    if (busy || closed || !pending || !active()) return;
    busy = true;
    setTimeout(() => { if (closed) { busy = false; return; } void consume(); }, 0);
  }

  /** Supersede only a waiting job; the pinned current worker can finish without starving under live moves. */
  function queue(page, sequence) {
    if (closed) return;
    if (complete?.id === page.id) {
      if (!progress.complete || progress.sequence !== sequence) report({ page, sequence }, page.total, true);
      return;
    }
    if (running?.page.id === page.id || pending?.page.id === page.id) return;
    pending = { page, sequence };
    progress = { loaded: 0, total: page.total, complete: false, sequence };
  }

  /** Return an already streamed item only when its exact snapshot still governs the screen. */
  function item(id) { return complete && complete.id === current().id ? complete.details.get(id) ?? null : null; }

  /** Resolve a streamed historical shout and its first answer without another network request. */
  function shout(id) {
    if (!complete || complete.id !== current().id) return null;
    const found = complete.shouts.get(id);
    if (!found) return null;
    const answer = found.shout_decision ? complete.answers.get(id) ?? null : null;
    return { ...found, decision_state: found.shout_decision ? (answer ? 'answered' : 'open') : null, decision_answer: answer };
  }

  /** Expose only counts and status to the View companion, never private table contents or keys. */
  function status() { return { ...progress }; }

  /** Access loss and pagehide discard decrypted history immediately and prevent late results from installing state. */
  function close() { closed = true; pending = null; complete = null; progress = { loaded: 0, total: null, complete: false, sequence: null }; }
  return { queue, start, item, shout, status, close };
}
