/**
 * The first screen's rules card (#967): how many Spec rows are approved, and how many of those name a gate or none,
 * so a person reads whether the rules hold before the work queue. It counts the rows the board sends as they are;
 * whether a gate runs, passes or was contradicted is the server's to report, so nothing here guesses at it.
 *
 * @param {Array<{ status: string, gate?: string }>} spec - The board's Spec rows, as the server projects them.
 * @returns {string} The card's HTML.
 */
export function homeRules(spec) {
  const approved = (spec ?? []).filter((row) => row.status === 'approved');
  const gated = approved.filter((row) => String(row.gate ?? '').trim()).length;
  const counts = [['approved', 'Approved', approved.length], ['gated', 'Name a gate', gated], ['ungated', 'No gate', approved.length - gated]];
  return '<h2>Your rules</h2><dl class="home-counts">'
    + counts.map(([key, label, n]) => '<div title="' + (key === 'approved' ? 'Approved rows in the current Spec' : key === 'gated' ? 'Approved Spec rows that name a gate' : 'Approved Spec rows that do not name a gate') + '" data-home-count="' + key + '"><dt>' + label + '</dt><dd>' + n + '</dd></div>').join('')
    + '</dl><button class="link" data-go="tab:spec" type="button">Open the Spec</button>';
}


/** Draw only the server's measured capacity projection, with unknowns and lower-bound curves explicit [N26,R1,R2]. */
export function homeCapacity(capacity) {
  /** Escape every projected label, including diagnostic text, before using HTML. */
  function escape(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
  /** Missing or invalid measurements remain unknown rather than becoming zero. */
  function measured(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  /** Keep the server's precision readable without manufacturing a value. */
  function number(value) { return measured(value) ? String(Number(value.toFixed(2))) : 'unknown'; }
  const available = capacity?.available === true;
  const agents = available ? capacity.agents ?? {} : {};
  const finish = available ? capacity.finishHours ?? {} : {};
  const needs = Array.isArray(capacity?.needsYou) ? capacity.needsYou.length : null;
  const unknown = Array.isArray(capacity?.unknown) ? capacity.unknown : [];
  const points = available && Array.isArray(capacity.curve) ? capacity.curve
    .filter(point => measured(point?.agents) && point.agents > 0 && measured(point?.hours))
    .slice(0, 32).sort((left, right) => left.agents - right.agents) : [];
  let curve = '<p class="capacity-note">Agent curve: unknown.</p>';
  if (points.length > 1) {
    const maxAgents = Math.max(...points.map(point => point.agents));
    const maxHours = Math.max(1, ...points.map(point => point.hours));
    const coordinates = points.map(point => `${(6 + 228 * (point.agents / maxAgents)).toFixed(2)},${(58 - 52 * (point.hours / maxHours)).toFixed(2)}`).join(' ');
    const description = points.map(point => `${number(point.agents)} agents: ${number(point.hours)} h`).join('; ');
    curve = '<figure class="capacity-curve"><svg viewBox="0 0 240 64" role="img" aria-label="Work/span lower bounds by agent count">'
      + '<title>' + escape(description) + '</title><polyline points="' + coordinates + '"/></svg>'
      + '<figcaption>Work/span lower bounds by agent count; not finish forecasts.</figcaption></figure>';
  }
  return '<h2>Useful agents</h2>'
    + '<p class="capacity-main">Max useful agents now: <strong>' + escape(number(agents.recommended)) + '</strong> (' + escape(number(agents.lower)) + '–' + escape(number(agents.upper)) + ').</p>'
    + '<p>' + (measured(finish.lower) && measured(finish.upper) ? 'Finish in about ' + escape(number(finish.lower)) + '–' + escape(number(finish.upper)) + ' h.' : 'Finish time: unknown.') + '</p>'
    + '<p>Binding: ' + escape(available ? capacity.binding?.kind ?? 'unknown' : 'unknown') + '. ' + escape(capacity?.binding?.text) + '</p>'
    + '<p>Lever: ' + escape(capacity?.lever?.text ?? 'Wait for measured board history.') + '</p>'
    + '<p>' + (needs === null ? 'Approval evidence count: unknown.' : escape(String(needs)) + ' items lack recorded approval evidence.') + '</p>'
    + (!available ? '<p class="capacity-warning">Capacity estimate is unavailable; no forecast is shown.</p>' : '')
    + (capacity?.stale ? '<p class="capacity-warning">Estimates are stale; waiting for a board update.</p>' : '')
    + (capacity?.staffing?.measuredLive === false ? '<p class="capacity-note">Forecast assumes ' + escape(number(capacity.staffing.seats)) + ' available seats from recent activity; live presence is unknown.</p>' : '')
    + (capacity?.monteCarlo?.asOf && capacity.monteCarlo.asOf !== capacity.asOf ? '<p class="capacity-note">Finish range last refreshed at ' + escape(capacity.monteCarlo.asOf) + '.</p>' : '')
    + (unknown.length ? '<p class="capacity-note">Unknown: ' + unknown.slice(0, 5).map(escape).join('; ') + (unknown.length > 5 ? ' (' + (unknown.length - 5) + ' more)' : '') + '.</p>' : '')
    + curve;
}
