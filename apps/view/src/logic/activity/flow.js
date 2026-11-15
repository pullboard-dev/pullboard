/**
 * The Activity page's one model (approved mockup activity-approved-1113, #6916): every item's journey through the
 * line, each hour's events and waterfall, the five Bottlenecks, and the Resources rail, all read from the board's
 * own items, ordered events and runner report. Nothing here is a constant of the board: counts are counted, ages are
 * measured against `now`, and a stage limit is read from `project.stageLimits` when the board sends one.
 * The page embeds this function's source text, so it reads only its arguments and language globals [N26].
 *
 * Reading the line from events (one state machine per item):
 *   add -> Ready; claim -> Building; submit -> Gate; a green gate verdict -> Pending review; reserve -> In review;
 *   accept -> Landing; merged -> Landed. release/lapse/reject/reopen return an item to Ready (reject and reopen also
 *   mark "sent back"); hold_item opens Held until unhold_item. An item that waits on another is Blocked from the
 *   board's own `blockedBy`. A stay longer than its stage's limit shows its excess as "past limit".
 *
 * @param {object} project - The board's snapshot: items, agents, shouts, dashboardRunners.
 * @param {object[]} events - The board's ordered events, at least those since the window opened.
 * @param {object} [options]
 * @param {number} options.now - The clock reading in ms; required, so the model never reads the host clock.
 * @param {number} [options.windowHours] - How many hourly cards the page reaches back (the strip's window).
 * @param {number|null} [options.left] - When the person last looked, in ms, or null.
 * @param {string[]|null} [options.working] - The seats at work (the notch's list), for the Agents split.
 * @param {string|null} [options.by] - Keep only this seat's events in the lists and counts.
 * @returns {object} The page model.
 */
export function activityFlow(project, events, { now, windowHours = 24, left = null, working = null, by = null } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Activity projection requires an explicit clock reading');
  const MIN = 60_000, HOUR = 3_600_000;
  const NAMES = { ready: 'Ready', held: 'Held', build: 'Building', blk: 'Blocked', gate: 'Gate', pend: 'Pending review', rev: 'In review', land: 'Landing' };
  // The board names its limits by stage (building, gate, pending review, in review, landing); a stage with no board limit has none here.
  const BOARD = { building: 'build', gate: 'gate', 'pending review': 'pend', 'in review': 'rev', landing: 'land' };
  const MINUTES = Object.fromEntries(Object.entries(project.stageLimits ?? {}).filter(([name]) => BOARD[name]).map(([name, minutes]) => [BOARD[name], minutes]));
  const limitOf = kind => (Number.isFinite(MINUTES[kind]) ? MINUTES[kind] : Infinity) * MIN;
  const GROUP = { ready: 'ready', build: 'building', blk: 'building', gate: 'gate', pend: 'pending', rev: 'pending', land: 'landing' };
  const REASONS = { TEST_FAILURE: 'tests failed', BEHAVIOR_MISMATCH: 'behavior did not match', INSUFFICIENT_EVIDENCE: 'not enough evidence', STALE_HEAD: 'source changed', OTHER: 'other reason', CRITERION_MET: 'criterion met' };
  const detailOf = event => { try { return JSON.parse(event.event_detail || '{}') || {}; } catch { return {}; } };
  const minutes = ms => Math.max(1, Math.round(ms / MIN));
  const items = new Map((project.items ?? []).map(item => [item.id, item]));
  const shouts = new Map((project.shouts ?? []).map(shout => [shout.shout_id, shout]));

  // The window: the newest hour is the clock's current hour; each card reaches one hour further back.
  const top = new Date(now); top.setMinutes(0, 0, 0);
  const newest = top.getTime(), W0 = newest - (windowHours - 1) * HOUR;
  const hours = [];
  for (let h0 = newest; h0 + HOUR > W0; h0 -= HOUR) hours.push({ h0, from: Math.max(h0, W0), h1: Math.min(h0 + HOUR, now) });

  // ---- one pass over the events: each item's lifecycle, plus the rows that are not about one item's stage ----
  const byItem = new Map(), loose = [];
  let mainMoved = null;
  for (const event of events) {
    const at = Date.parse(event.event_at);
    if (!Number.isFinite(at) || at > now) continue;
    const kind = event.event_kind;
    if (kind === 'main-moved') { mainMoved = { at, sha: detailOf(event).sha ?? null }; continue; }
    if (kind === 'shout' || kind === 'answer') {
      const d = detailOf(event), target = /^item:(\d+)$/u.exec(d.to ?? '')?.[1];
      const id = event.item_id ?? (target ? Number(target) : null);
      const ruling = kind === 'shout' && d.to === 'person' && d.decision === true;
      // Automatic notices and the coordinator's fan-out to an item's followers are not the shouts a person reads here.
      if (['sentinel', 'board'].includes(event.event_by) || kind === 'answer' && !ruling || !ruling && event.event_by === 'coordinator' && target) continue;
      const entry = { at, kind: ruling ? 'ruling' : 'shout', by: event.event_by, to: d.to, text: shouts.get(d.shout)?.shout_text ?? '', id: id ?? null, event: event.event_id };
      if (id !== null) { if (!byItem.has(id)) byItem.set(id, []); byItem.get(id).push(entry); } else loose.push(entry);
      continue;
    }
    if (!['add', 'claim', 'release', 'lapse', 'submit', 'gate-run', 'proof-run', 'reserve', 'accept', 'reject', 'reopen', 'merged', 'withdraw', 'hold_item', 'unhold_item'].includes(kind)) continue;
    if (event.item_id === null || event.item_id === undefined) continue;
    if (!byItem.has(event.item_id)) byItem.set(event.item_id, []);
    byItem.get(event.item_id).push({ at, kind, by: event.event_by, event: event.event_id, raw: event });
  }
  // A claim, review or landing that began before the loaded events still shows its stage, from the item's own row.
  for (const item of project.items ?? []) {
    if (byItem.has(item.id) || !['claimed', 'submitted', 'verified'].includes(item.status) || item.status === 'verified' && (item.stage === 'merged' || item.merged)) continue;
    const since = Date.parse(item.since ?? item.updatedAt);
    if (!Number.isFinite(since) || since > now) continue;
    const reviewing = item.status === 'submitted' && (item.reviewer || item.progress?.holder) && !(Date.parse(item.reviewUntil) <= now);
    byItem.set(item.id, [{ at: since, kind: 'row', stage: item.status === 'claimed' ? 'build' : item.status === 'verified' ? 'land' : reviewing ? 'rev' : 'pend', by: item.claim?.by ?? item.reviewer ?? '', event: 0 }]);
  }

  const journeys = [], rows = [];
  for (const [id, list] of byItem) {
    const item = items.get(id), title = item?.title ?? '';
    const segs = [], marks = [];
    let cur = null, landedAt = null, ended = false, withdrew = false, builtAt = null, held = null, lastBuilder = '';
    const close = at => { if (cur && at > cur.a) segs.push({ k: cur.k, a: cur.a, b: at }); cur = null; };
    const open = (k, at) => { if (cur?.k === k) return; close(at); cur = { k, a: at }; };
    const row = (at, kind, fact, extra = {}) => rows.push({ at, kind, id, title, fact, by: extra.by ?? '', quote: extra.quote ?? '', event: extra.event ?? 0 });
    const readyAge = at => cur?.k === 'ready' ? ' · ready for ' + minutes(at - cur.a) + 'm' : '';
    for (const e of list.sort((a, b) => a.at - b.at || a.event - b.event)) {
      if (ended) break;
      // A landing recorded by hand follows its own withdraw; nothing else counts once an item is withdrawn.
      if (withdrew && e.kind !== 'merged') continue;
      if (e.stage) { open(e.stage, e.at); continue; }
      const d = e.raw ? detailOf(e.raw) : {};
      if (e.kind === 'add') { open('ready', e.at); row(e.at, 'ready', 'made ready' + (item?.milestone ? ' · into ' + String(item.milestone).split(':')[0] : ''), { by: e.by, event: e.event }); }
      else if (e.kind === 'claim') {
        if (cur?.k !== 'build') { const back = segs.some(s => s.k === 'rev' || s.k === 'pend'); const age = readyAge(e.at); open('build', e.at); lastBuilder = e.by; if (builtAt === null) builtAt = e.at;
          row(e.at, 'building', (back ? 'back to building · claimed by ' : 'claimed by ') + e.by + (back ? '' : age), { by: e.by, event: e.event }); }
      }
      else if (e.kind === 'release' || e.kind === 'lapse') {
        if (d.review) { open('pend', e.at); row(e.at, 'pending', 'review let go by ' + e.by + ' · waits for a reviewer', { by: e.by, event: e.event }); }
        else { open('ready', e.at); row(e.at, 'ready', 'let go by ' + e.by + ' · back to ready', { by: e.by, event: e.event }); }
      }
      else if (e.kind === 'submit') { const built = builtAt === null ? '' : ' · built in ' + minutes(e.at - builtAt) + 'm'; open('gate', e.at); row(e.at, 'gate', 'submitted by ' + e.by + built, { by: e.by, event: e.event }); }
      else if (e.kind === 'gate-run' || e.kind === 'proof-run') {
        const green = e.kind === 'gate-run' && typeof d.run?.green === 'boolean' ? d.run.green
          : e.kind === 'proof-run' && ['submit', 'gate'].includes(d.receipt?.kind) && Number.isInteger(d.receipt?.exitCode) ? d.receipt.exitCode === 0 : null;
        if (green === true && cur?.k === 'gate') { open('pend', e.at); row(e.at, 'pending', 'gate passed · no reviewer yet', { by: e.by, event: e.event }); }
        else if (green === false && cur?.k === 'gate') { open('ready', e.at); row(e.at, 'ready', 'gate failed · back to ready', { by: e.by, event: e.event }); }
      }
      else if (e.kind === 'reserve') { open('rev', e.at); row(e.at, 'review', e.by + ' checking', { by: e.by, event: e.event }); }
      else if (e.kind === 'accept') { open('land', e.at); row(e.at, 'landing', 'accepted by ' + e.by + ' · landing next', { by: e.by, event: e.event }); }
      else if (e.kind === 'reject' || e.kind === 'reopen') {
        marks.push({ k: 'back', t: e.at }); open('ready', e.at);
        const why = REASONS[d.reason] ?? (typeof d.note === 'string' && d.note ? d.note.split('\n')[0].slice(0, 90) : e.kind === 'reopen' ? 'reopened' : 'sent back');
        row(e.at, 'sentback', 'review: ' + why, { by: e.by, event: e.event });
      }
      else if (e.kind === 'merged') {
        if (landedAt === null) { landedAt = e.at; close(e.at); ended = true; cur = null; row(e.at, 'landed', 'in flight ' + minutes(e.at - (segs[0]?.a ?? e.at)) + 'm' + (typeof d.commit === 'string' && d.commit ? ' · ' + d.commit.slice(0, 7) : ''), { by: e.by, event: e.event }); }
      }
      else if (e.kind === 'withdraw') { close(e.at); withdrew = true; row(e.at, 'withdrawn', 'withdrawn by ' + e.by + (d.reason ? ' · ' + String(d.reason).slice(0, 80) : ''), { by: e.by, event: e.event }); }
      else if (e.kind === 'hold_item') { held = cur?.k ?? 'ready'; open('held', e.at); row(e.at, 'held', 'paused on purpose' + (d.reason ? ' · ' + String(d.reason).slice(0, 80) : ''), { by: e.by, event: e.event }); }
      else if (e.kind === 'unhold_item') { if (cur?.k === 'held') { open(held ?? 'ready', e.at); row(e.at, 'ready', 'hold lifted · back to ' + NAMES[held ?? 'ready'].toLowerCase(), { by: e.by, event: e.event }); } }
      else if (e.kind === 'ruling') { marks.push({ k: 'ruling', t: e.at }); row(e.at, 'ruling', 'asked by ' + e.by, { by: e.by, quote: e.text, event: e.event }); }
      else if (e.kind === 'shout') { marks.push({ k: 'shout', t: e.at }); row(e.at, 'shout', 'from ' + e.by + (e.to ? ' to ' + (e.to === 'person' ? 'you' : e.to) : ''), { by: e.by, quote: e.text, event: e.event }); }
    }
    // The item as the board holds it now wins over a log that ended early.
    if (!ended && !withdrew && cur) {
      if (item?.status === 'withdrawn') { close(Math.min(now, Date.parse(item.updatedAt) || now)); ended = true; }
      else if (item?.status === 'open' && item.blockedBy?.length && cur.k === 'ready') {
        const since = Math.min(now, Math.max(cur.a, Date.parse(item.since ?? item.updatedAt) || cur.a));
        if (since > cur.a) { segs.push({ k: 'ready', a: cur.a, b: since }); cur = { k: 'blk', a: since }; } else cur = { k: 'blk', a: cur.a };
        row(cur.a, 'blocked', 'blocked by ' + item.blockedBy.map(blocker => '#' + blocker).join(', ') + ' · must land first', { event: 0 });
      }
    }
    if (!ended && !withdrew && cur) { segs.push({ k: cur.k, a: cur.a, b: now }); }
    // Past-limit: the excess of a stay beyond its stage's limit is its own segment, with a Sentinel row where it began.
    const bars = [];
    for (const seg of segs) {
      const limit = limitOf(seg.k), same = seg.k === 'blk' || seg.k === 'held' ? Infinity : limit;
      if (seg.b - seg.a > same) {
        bars.push({ k: seg.k, a: seg.a, b: seg.a + same }, { k: seg.k, a: seg.a + same, b: seg.b, over: true });
        rows.push({ at: seg.a + same, kind: 'sentinel', id, title, fact: 'past the ' + minutes(same) + 'm ' + NAMES[seg.k].toLowerCase() + ' limit · ' + NAMES[seg.k].toLowerCase() + ' ' + minutes(seg.b - seg.a) + 'm so far', by: 'sentinel', quote: '', event: 0 });
      } else bars.push(seg);
    }
    const first = bars[0]?.a ?? list[0].at, end = landedAt ?? bars.at(-1)?.b ?? list.at(-1).at;
    const live = !ended && !withdrew && bars.length > 0;
    const last = bars.at(-1);
    const stateKind = landedAt !== null ? 'landed' : live ? last.k : null;
    journeys.push({ id, title, who: lastBuilder || (item?.claim?.by ?? ''), segs: bars, marks, start: first, end, landed: landedAt !== null, live, state: stateKind,
      stuck: live && (last.over === true || last.k === 'blk'), lane: 0,
      // The waterfall draws from the work, with at most one Ready limit of the wait before it; the item's own panel shows the rest.
      drawStart: Math.max(first, (bars.find(seg => !['ready', 'blk', 'held'].includes(seg.k))?.a ?? first) - limitOf('ready')) });
  }
  for (const entry of loose) rows.push({ at: entry.at, kind: entry.kind, id: null, title: '', fact: entry.kind === 'ruling' ? 'asked by ' + entry.by : 'from ' + entry.by + (entry.to ? ' to ' + (entry.to === 'person' ? 'you' : entry.to) : ''), by: entry.by, quote: entry.text, event: entry.event });

  // ---- columns for the waterfall: by start, each item takes the first lane free for six minutes ----
  // Only work that moved is drawn: an item that has only waited (Ready, Blocked or Held) is counted in Bottlenecks, not drawn.
  const worked = journey => journey.segs.some(seg => !['ready', 'blk', 'held'].includes(seg.k));
  const shown = journeys.filter(journey => journey.end >= W0 - 25 * MIN && worked(journey)).sort((a, b) => a.start - b.start || a.id - b.id);
  const laneEnd = [];
  for (const journey of shown) {
    let lane = laneEnd.findIndex(end => end <= Math.max(journey.drawStart, W0));
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
    journey.lane = lane; laneEnd[lane] = journey.end + 6 * MIN;
  }
  const journeyById = new Map(journeys.map(journey => [journey.id, journey]));

  // ---- events, newest first, with who they are by ----
  const all = rows.filter(entry => entry.at >= W0 && (!by || entry.by === by)).sort((a, b) => b.at - a.at || b.event - a.event);
  const count = kind => all.filter(entry => kind === 'all' || entry.kind === kind).length;
  const counts = { all: all.length, landed: count('landed'), sentback: count('sentback'), held: count('held'), blocked: count('blocked'), pending: count('pending'), ruling: count('ruling'), shout: count('shout') };
  const people = [...new Set(rows.filter(entry => entry.at >= W0).map(entry => entry.by).filter(name => name && name !== 'sentinel'))].sort();

  // ---- peak in flight per hour, from one sweep of the segments that are neither Ready nor Held ----
  const edges = [];
  for (const journey of shown) for (const seg of journey.segs) if (seg.k !== 'ready' && seg.k !== 'held') { edges.push([seg.a, 1]); edges.push([seg.b, -1]); }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const peakIn = (from, to) => {
    let level = 0, peak = 0, index = 0;
    while (index < edges.length && edges[index][0] <= from) level += edges[index++][1];
    peak = level;
    for (; index < edges.length && edges[index][0] < to; index++) { level += edges[index][1]; peak = Math.max(peak, level); }
    return peak;
  };
  for (const hour of hours) {
    const here = all.filter(entry => entry.at >= hour.from && entry.at < hour.h1 + (hour.h1 === now ? 1 : 0));
    const n = kind => here.filter(entry => entry.kind === kind).length;
    Object.assign(hour, { events: here, landed: n('landed'), sentBack: n('sentback'), rulings: n('ruling'), peak: peakIn(hour.from, hour.h1) });
  }

  // ---- Bottlenecks, now: the five stages, working and stuck, the oldest stay ----
  const STAGES = [['ready', 'Ready'], ['building', 'Building'], ['gate', 'Gate'], ['pending', 'Pending review'], ['landing', 'Landing']];
  const liveList = journeys.filter(journey => journey.live && journey.segs.length);
  const bottlenecks = STAGES.map(([key, name]) => {
    let working = 0, stuck = 0, red = false, oldest = 0;
    for (const journey of liveList) {
      const bars = journey.segs;
      let last = bars.at(-1), index = bars.length - 1;
      // A blocked item sits in the stage it was blocked in: the one before it, else Building.
      let group = last.k === 'blk' ? (bars.slice(0, -1).findLast(seg => seg.k !== 'blk' && seg.k !== 'held') ? GROUP[bars.slice(0, -1).findLast(seg => seg.k !== 'blk' && seg.k !== 'held').k] : 'building') : GROUP[last.k];
      if (last.k === 'held' || group !== key) continue;
      const isStuck = last.over === true || last.k === 'blk';
      if (isStuck) { stuck++; if (last.over) red = true; } else working++;
      let since = last.a;
      while (index > 0 && (GROUP[bars[index - 1].k] === key) && bars[index - 1].b === bars[index].a) { index--; since = bars[index].a; }
      oldest = Math.max(oldest, now - since);
    }
    return { key, name, working, stuck, red, oldest: working + stuck ? oldest : null };
  });
  const worst = bottlenecks.reduce((a, b) => (b.stuck > a.stuck ? b : a));
  for (const row of bottlenecks) row.bottleneck = row === worst && row.stuck > 0;
  const off = { blocked: liveList.filter(journey => journey.segs.at(-1).k === 'blk').length, held: liveList.filter(journey => journey.segs.at(-1).k === 'held').length };

  // Items of a stage and its working/stuck half, for the lane filter.
  const laneIds = (key, sub) => new Set(liveList.filter(journey => {
    const last = journey.segs.at(-1);
    const before = journey.segs.slice(0, -1).findLast(seg => seg.k !== 'blk' && seg.k !== 'held');
    const group = last.k === 'blk' ? (before ? GROUP[before.k] : 'building') : GROUP[last.k];
    if (last.k === 'held' || group !== key) return false;
    const isStuck = last.over === true || last.k === 'blk';
    return sub === 's' ? isStuck : !isStuck;
  }).map(journey => journey.id));

  // ---- the Resources rail ----
  const seats = Array.isArray(working) ? working : (project.agents ?? []).map(agent => agent.agent_id);
  const builders = new Set((project.items ?? []).filter(item => item.status === 'claimed' && item.claim?.by && Date.parse(item.claim.until) > now).map(item => item.claim.by));
  const reviewers = new Set((project.items ?? []).filter(item => item.status === 'submitted' && (item.reviewer || item.progress?.holder) && !(Date.parse(item.reviewUntil) <= now)).map(item => item.reviewer || item.progress?.holder));
  const building = seats.filter(seat => builders.has(seat)).length, reviewing = seats.filter(seat => !builders.has(seat) && reviewers.has(seat)).length;
  const runners = (project.dashboardRunners?.runners ?? []).map(runner => ({ name: runner.name ?? 'Runner ' + runner.runner, cpu: Number.isFinite(runner.cpu) ? runner.cpu : null, jobs: runner.jobs?.length ?? 0, busy: Boolean(runner.busy) }));
  const stay = key => liveList.filter(journey => journey.segs.at(-1).k === key).map(journey => now - journey.segs.at(-1).a);
  const queue = [['Gate', 'gate', 'longest'], ['Landing', 'land', 'next'], ['Pending review', 'pend', 'oldest']].map(([name, key, word]) => {
    const waits = stay(key); return { name, count: waits.length, word, age: waits.length ? Math.max(...waits) : null };
  });
  const repair = (project.items ?? []).filter(item => ['open', 'claimed', 'submitted'].includes(item.status) && /^main red\b/iu.test(item.title ?? ''));
  const main = { green: repair.length === 0, repairs: repair.length, at: mainMoved?.at ?? null, sha: mainMoved?.sha ?? null };

  // ---- Since you left ----
  const sinceAt = Number.isFinite(left) ? left : null;
  const sinceRows = sinceAt === null ? [] : all.filter(entry => entry.at >= sinceAt);
  const since = { at: sinceAt, landed: sinceRows.filter(entry => entry.kind === 'landed').length, sentBack: sinceRows.filter(entry => entry.kind === 'sentback').length, rulings: sinceRows.filter(entry => entry.kind === 'ruling').length };

  return { now, windowStart: W0, windowHours, hours, journeys: shown, journeyById, lanes: laneEnd.length, events: all, counts, people, bottlenecks, off, laneIds, since,
    // The rail's two counts are the state's shared ones, the same the top bar and the Dashboard show (#7310).
    rail: { agents: { total: Number.isInteger(project.counts?.agents) ? project.counts.agents : seats.length, building, reviewing, idle: Math.max(0, (Number.isInteger(project.counts?.agents) ? project.counts.agents : seats.length) - building - reviewing) },
      runners, runnerCount: Number.isInteger(project.counts?.runners) ? project.counts.runners : runners.length, queue, main },
    names: NAMES, limits: Object.fromEntries(Object.keys(MINUTES).map(key => [key, MINUTES[key]])) };
}
