/** Keep complete Dashboard history per board, bounded by each displayed state prefix, using the ordinary read API. */
export function dashboardRuntime({ model, html, api, boardPath, current, redraw, summary }) {
  const histories = new Map();
  /** Read missing history once per prefix; never draw one board's history over another board. */
  function read(root, prefix) {
    const key = root + '|' + boardPath(root);
    let held = histories.get(key);
    if (held && prefix < held.observedPrefix) { histories.delete(key); held = null; }
    if (!held) { held = { events: [], prefix: -1, pending: false, error: null }; histories.set(key, held); }
    if (held.pending || held.prefix >= prefix || held.failedPrefix === prefix && Date.now() - held.failedAt < 5000) return held;
    held.pending = true; held.observedPrefix = prefix;
    const after = held.events.at(-1)?.event_id ?? 0;
    api(boardPath(root) + '/events?after=' + after).then(reply => {
      if (!Array.isArray(reply.events)) throw new Error('The board did not return its event history.');
      const byId = new Map(held.events.map(event => [event.event_id,event]));
      for (const event of reply.events) byId.set(event.event_id,event);
      held.events = [...byId.values()].sort((a,b)=>a.event_id-b.event_id);
      const selected = held.events.filter(event => event.event_id <= prefix);
      const covered = prefix === 0 || selected.length === prefix && selected.every((event,index) => event.event_id === index + 1);
      held.prefix = covered ? prefix : -1; held.error = covered ? null : 'The available history does not cover this board prefix.';
      if (!covered) { held.failedPrefix = prefix; held.failedAt = Date.now(); }
    }).catch(error => { held.error = String(error.message || error); held.failedPrefix = prefix; held.failedAt = Date.now(); }).finally(() => {
      held.pending = false;
      // A failed read waits for the next board refresh, rather than a hot render/retry loop.
      if (current() === root) redraw();
    });
    return held;
  }
  /** Draw immediately from live claims, then enrich only with the complete ordered prefix when available. */
  function draw(project, needs) {
    const region = document.getElementById('dashboard');
    if (!region) return;
    const prefix = project.sequence ?? Math.max(0, ...(project.events ?? []).map(event => event.event_id));
    let held = histories.get(project.root + '|' + boardPath(project.root));
    if (!held?.error || held.prefix !== prefix) held = read(project.root, prefix);
    const complete = held.prefix >= prefix;
    const observedAt = Date.parse(project.observedAt);
    const now = Number.isFinite(observedAt) ? observedAt : Date.now();
    // Native snapshots are JSON; include every field so changed live data or an observation clock always invalidates.
    const projectKey = JSON.stringify(project), cached = held.modelCache;
    const state = cached && cached.projectKey === projectKey && cached.events === held.events
      && cached.prefix === prefix && cached.complete === complete && cached.now === now ? cached.state
      : model(project, held.events.filter(event=>event.event_id<=prefix), { complete, now });
    held.modelCache = { projectKey, events: held.events, prefix, complete, now, state };
    const progress = state.milestone ? summary(state.milestone)?.detail ?? '' : '';
    // Native details keep each Show-more/quiet disclosure open across live refreshes.
    const expanded = [...region.querySelectorAll('details[open]')].map(entry=>entry.dataset.dashboardDisclosure);
    region.innerHTML = html(state, { needs, progress })+(held.error?'<p class="muted" role="status">Dashboard history is unavailable; live work remains visible.</p>':'');
    for (const disclosure of region.querySelectorAll('details')) if (expanded.includes(disclosure.dataset.dashboardDisclosure)) disclosure.open = true;
  }
  return { draw };
}
