/**
 * The first-run Dashboard: until a board has finished its checklist, the Dashboard teaches the loop in plain words
 * instead of showing zeros [N26,N38]. The page embeds firstRunKit's source text, so the kit may use only its own
 * scope and the language's globals; tests call it directly.
 *
 * `coordinate` says whether the CLI has the pullboard coordinate command (#2068); the copy line names it once it does.
 *
 * @param {{ coordinate?: boolean }} [options]
 * @returns {{ steps: Array<[number, string]>, dwell: (index: number) => number, model: Function, html: Function, paint: Function }}
 */
export function firstRunKit({ coordinate = false } = {}) {
  /** Escape text and attribute values that come from a board. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** The diagram's boxes top to bottom: title, what it does, and its middle y on the 320-wide drawing. */
  const NODES = [['You', 'declare it, then approve', 30], ['Coordinator (agent)', 'runs everything', 92], ['Builder (agent)', 'does one task', 154], ['Verifier (agent)', 'verifies it', 216], ['Your app', 'updates', 278]];
  /** The tour: the box it lights and the one line it says, each adding something the last did not. */
  const steps = [[0, 'Nothing is built without your yes.'], [1, 'Your one contact. Ask it anything.'], [2, 'Many can work at once.'],
    [3, 'Always a different agent. Wrong? Back to fix.'], [4, 'Only verified work goes in. Then the next task.']];
  /** Each stop stays long enough to read: 2.5 seconds plus a third of a second per word. */
  const dwell = index => 2500 + steps[index][1].trim().split(/\s+/u).length * 330;
  /** The seven checklist steps: what is ticked, and the one-line pointer shown while it is the current step. */
  const CHECKS = [
    ['Coordinator created', 'Paste the line above', null],
    ['Declared and approved', 'Approve in ', ['spec', 'Spec →']],
    ['First task built', 'Watch it in ', ['items', 'Items →']],
    ['First task verified', 'See the check in ', ['activity', 'Activity →']],
    ['Your app updated', 'See what landed on the ', ['dashboard', 'Dashboard →']],
    ['Rinse and repeat', 'Go get a coffee ☕', null],
    ['Map out the work', 'Plan releases in ', ['roadmap', 'Roadmap →']],
  ];
  /** The approved line once the coordinate command exists (#2068), and the skill line until then. */
  const COPY = coordinate ? 'Run pullboard coordinate' : 'Use the pullboard-run skill: be this project\'s coordinator. Keep listening, run builder and verifier subagents, and help me add more agents.';
  const SETUP = [['Runs on', 'Runs on:'], ['Hosting', 'Hosting:'], ['Sign-in', 'Sign-in:'], ['Done means', 'Done means:']];
  const ICONS = [
    '<path d="M5 4.5L2 8l3 3.5M11 4.5L14 8l-3 3.5"/>',
    '<path d="M4.5 11.5h7a3 3 0 0 0 .3-6 4 4 0 0 0-7.6 1A2.5 2.5 0 0 0 4.5 11.5z"/>',
    '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7"/>',
    '<path d="M3.5 8.5l3 3 6-6.5"/>',
    '<path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z"/>',
  ];

  /**
   * Whether an agent row is a coordinator that is really there: any coordinator seat other than the placeholder the
   * board creates at init, or the placeholder itself once an agent has identified its model on it. A board whose
   * coordinator predates first-run therefore still ticks step 1.
   */
  function coordinatorPresent(agent) {
    if (agent.agent_lane !== 'coordinator') return false;
    const model = String(agent.model ?? agent.agent_model ?? '').trim().toLowerCase();
    return agent.agent_id !== 'coordinator' || (model !== '' && model !== 'unknown');
  }

  /**
   * What the page needs from one board: which steps are ticked, from the board's own events and rows, and the
   * five architecture tiles, read from the setup facts the board started with.
   */
  function model(project, events = []) {
    // The page keeps a running tally ({ kinds, merged }) so a live update never rescans the history; a list of events counts the same.
    const tally = Array.isArray(events) ? { kinds: new Set(events.map(event => event.event_kind)), merged: events.filter(event => event.event_kind === 'merged').length } : events;
    const { kinds } = tally;
    const items = project.items ?? [];
    const landings = Math.max((project.dashboardLanded ?? []).length, project.counts?.landed?.total ?? 0, items.filter(item => item.merged || item.stage === 'merged').length, tally.merged);
    const ticks = [
      (project.agents ?? []).some(coordinatorPresent),
      (project.spec ?? []).some(row => row.status === 'approved'),
      kinds.has('submit') || items.some(item => ['submitted', 'verified'].includes(item.status)),
      kinds.has('accept') || items.some(item => item.status === 'verified'),
      landings >= 1,
      landings >= 2,
      (project.milestones ?? []).some(milestone => (milestone.items ?? []).length >= 3),
    ];
    const rows = project.spec ?? [];
    /** The value in a setup fact such as "Hosting: Free; provider undecided." is what follows the label, up to a semicolon or the closing period. */
    const tiles = SETUP.map(([label, prefix], index) => {
      const row = rows.find(entry => typeof entry.text === 'string' && entry.text.startsWith(prefix));
      const value = row ? row.text.slice(prefix.length).split(';')[0].trim().replace(/\.$/u, '') : '';
      return { label, value: value || 'Not set', link: row ? 'Change' : 'Set', tab: 'spec', detail: row ? row.id : null, icon: index };
    });
    const rules = (project.practice ?? []).filter(row => row.status === 'approved').length;
    tiles.push({ label: 'Doctrine', value: rules + (rules === 1 ? ' rule' : ' rules'), link: 'Review', tab: 'doctrine', detail: null, icon: 4 });
    const done = ticks.every(Boolean);
    return { ticks, done, current: done ? CHECKS.length : ticks.indexOf(false), landed: landings, tiles };
  }

  /** The tour diagram: five boxes, square connectors, the red way back to the builder, and the way round to the next task. */
  function diagram(lit) {
    const box = ([title, sub, y], index) => '<g class="node' + (index === lit ? ' now' : '') + '" data-first-run-node="' + index + '"><rect x="60" y="' + (y - 22) + '" width="200" height="44" rx="10"/><text x="160" y="' + (y - 2) + '">' + esc(title) + '</text><text class="sub" x="160" y="' + (y + 13) + '">' + esc(sub) + '</text></g>';
    // Arrowheads are styled by class from view.css: the page's CSP (style-src 'self') refuses inline style attributes.
    const head = (id, tone) => '<marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path' + (tone ? ' class="' + tone + '"' : '') + ' d="M1 1L9 5L1 9"/></marker>';
    let links = '';
    for (let k = 0; k < NODES.length - 1; k++) links += '<path d="M160 ' + (NODES[k][2] + 22) + ' V' + (NODES[k + 1][2] - 24) + '" marker-end="url(#fr-ah)"/>';
    links += '<path class="back" d="M260 216 H288 V154 H264" marker-end="url(#fr-ab)"/><text class="lbl back" x="302" y="185" transform="rotate(90 302 185)" text-anchor="middle">back to fix</text>';
    links += '<path class="next" d="M60 278 H32 V154 H56" marker-end="url(#fr-ah)"/><text class="lbl" x="20" y="216" transform="rotate(-90 20 216)" text-anchor="middle">next task</text>';
    return '<defs>' + head('fr-ah', '') + head('fr-ab', 'head-back') + '</defs>' + links + NODES.map(box).join('');
  }

  /** Move the tour to one stop in place: the lit box, the caption, the dots and the stay time, without redrawing the page. */
  function paint(root, index) {
    const tour = root?.querySelector('[data-first-run-tour]');
    if (!tour) return;
    tour.dataset.step = String(index);
    tour.querySelectorAll('[data-first-run-node]').forEach(node => node.classList.toggle('now', Number(node.dataset.firstRunNode) === index ? true : false));
    const caption = tour.querySelector('[data-first-run-caption]');
    caption.textContent = steps[index][1];
    caption.dataset.dwell = String(dwell(index));
    tour.querySelectorAll('[data-first-run-dot]').forEach((dot, at) => dot.classList.toggle('on', at === index));
  }

  /**
   * The whole first-run block. `href(tab, detail)` gives a link's address; `tour` is the stop the tour is on.
   * A finished checklist draws its last state: every step ticked and the way to set up a phone.
   */
  function html(state, { href = () => '#', tour = 0 } = {}) {
    const link = (tab, text, detail = null, extra = '') => '<a href="' + esc(href(tab, detail)) + '" data-tab="' + tab + '"' + (detail !== null ? ' data-detail="' + esc(detail) + '"' : '') + extra + '>' + esc(text) + '</a>';
    const three = [['Your board runs on its own:', 'build → verify → add to your app'], ['Talk to your coordinator agent', 'It runs everything'], ['Want it faster?', 'Add agents: “run pullboard next”']];
    const boxes = '<ol class="first-run-rules" aria-label="How your board works">' + three.map(([head, tail], index) =>
      (index ? '<li class="arr" aria-hidden="true">→</li>' : '') + '<li><b>' + (index + 1) + '</b><span>' + esc(head) + '<em>' + esc(tail) + '</em></span></li>').join('') + '</ol>';
    const how = '<div class="first-run-how" data-first-run-tour data-step="' + tour + '"><figure class="first-run-dia"><svg viewBox="0 0 320 306" role="img" aria-label="How it works: you say what you want and say yes; your coordinator handles everything between you and the work; a builder does one task; a verifier checks it; your app gets the update. Anything wrong goes back to be fixed.">' + diagram(tour) + '</svg></figure>'
      + '<p class="first-run-caption" data-first-run-caption data-dwell="' + dwell(tour) + '">' + esc(steps[tour][1]) + '</p>'
      + '<div class="first-run-tour"><button type="button" data-first-run-step="-1" aria-label="Previous">‹</button><span class="first-run-dots">' + steps.map((_, at) => '<i data-first-run-dot class="' + (at === tour ? 'on' : '') + '"></i>').join('') + '</span><button type="button" data-first-run-step="1" aria-label="Next">›</button></div></div>';
    const items = CHECKS.map(([name, pointer, target], at) => {
      const ticked = state.ticks[at], now = at === state.current;
      return '<li class="' + (ticked ? 'ok' : now ? 'now' : '') + '" data-first-run-check="' + at + '" data-ticked="' + ticked + '"><i>' + (ticked ? '✓' : at + 1) + '</i>' + esc(name)
        + (now ? '<small class="hint">' + esc(pointer) + (target ? link(target[0], target[1]) : '') + '</small>' : '') + '</li>';
    }).join('') + '<li class="after' + (state.done ? ' ok' : '') + '" data-first-run-walk>Walk away.' + (state.done
      ? '<small class="hint">We\'ll call you if it\'s on fire 🔥 · <a href="#" data-first-run-phone>Set up your phone →</a></small>' : '') + '</li>';
    const start = '<div class="first-run-start"><h2>Create your Coordinator Agent</h2><div class="first-run-line"><code>' + esc(COPY) + '</code><button type="button" data-first-run-copy>Copy</button></div><ul class="first-run-checks">' + items + '</ul></div>';
    const tile = row => '<div class="first-run-tile" data-first-run-tile="' + esc(row.label) + '"><span class="ico"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[row.icon] + '</svg></span><div><span class="k">' + esc(row.label) + '</span><b>' + esc(row.value) + '</b>' + link(row.tab, row.link, row.detail) + '</div></div>';
    return '<div class="first-run" aria-label="Getting started">' + boxes + '<section class="first-run-card" aria-label="How it works"><div class="first-run-two">' + how + start + '</div></section>'
      + '<section class="first-run-card first-run-arch" aria-label="Architecture"><div class="first-run-dhead"><h2>Architecture</h2><span>Made for you. Change any before building starts. No outside accounts needed.</span></div><div class="first-run-tiles">' + state.tiles.map(tile).join('') + '</div></section>'
      + (state.landed ? '<p class="first-run-later"><button type="button" class="link" data-first-run-hide>Hide this page</button></p>' : '<p class="first-run-later">Your agents, their progress and what landed show up here once work starts.</p>') + '</div>';
  }

  /** The page shows until the loop is proven running (a coordinator present and one item landed), or the person hides it. */
  const visible = (state, hidden) => Boolean(state && !hidden && !(state.ticks[0] && state.landed >= 1));

  return { steps, dwell, model, html, paint, visible, copy: COPY };
}
