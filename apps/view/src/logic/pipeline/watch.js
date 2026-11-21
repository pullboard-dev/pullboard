/**
 * The Insights Pipeline page (#6869): why work is not moving, read only from the board's own items and events and from
 * this machine's CPU samples. Every number here is counted from what the board recorded; a stage whose events the board
 * has not recorded in the last day reads null, never 0 and never a constant [N26].
 *
 * Why two functions: the page embeds each one's source text, so the model reads only its arguments and the markup
 * reads only its model and options; no helper may sit outside either.
 */

/**
 * Work the Pipeline page out of the board's state and its event history.
 *
 * @param {object} project - The board's state: items, agents, milestones, itemHolds, holds, landingBatches, statsComparison.
 * @param {object[]} events - The board's events in id order (up to the state's prefix).
 * @param {{ now: number, windowMinutes?: number, complete?: boolean, machine?: object|null }} options
 * @returns {object} Everything the page draws; counts the board never recorded are null.
 */
export function pipelineWatchModel(project, events, { now, windowMinutes = 60, complete = true, machine = null } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('The Pipeline page needs an explicit clock reading');
  const MIN = 60_000, HOUR = 3_600_000, W = windowMinutes * MIN, from = now - W, before = now - 2 * W;
  const floor = Math.min(before, now - 26 * HOUR);
  const items = Array.isArray(project?.items) ? project.items : [];
  const byId = new Map(items.map(item => [item.id, item]));
  const parse = text => { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } };
  const median = list => { if (!list.length) return null; const sorted = [...list].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };
  const count = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
  /** Plain-language cause for a release, a reject, a gate or a landing reason. */
  const bucket = text => {
    const t = String(text || '');
    if (/no heartbeat|worktree is gone|seat-gone/i.test(t)) return 'Seat heartbeat lost';
    if (/session ended|context limit/i.test(t)) return 'Agent session ended';
    if (/BUDGET|over budget|too big|not light/i.test(t)) return 'Over budget for one session';
    if (/RUNNER_|TRANSPORT_LOST|GATE_INFRA|CLEANUP_UNVERIFIED|runner/i.test(t)) return 'Runner failure';
    if (/BOARD_BUSY|DATABASE_LOCKED|SLOT_DB_LOCKED|LOCK_BUSY|board changed while/i.test(t)) return 'Board or lock busy';
    if (/STACKED_ON_UNVERIFIED|Waiting on #|waits on|needs accepted|companion|dependency/i.test(t)) return 'Blocked by another item';
    if (/MERGE_CONFLICT|conflicts in/i.test(t)) return 'Merge conflict';
    if (/NOT_JOINED|NOT_AT_COMMIT|NOT_YOUR|dirty|RUNNER_SOURCE|itemFolder|checkout/i.test(t)) return 'Wrong or dirty checkout';
    if (/INELIGIBLE|ROUTED_ELSEWHERE|route|family|reviewer seat/i.test(t)) return 'Routed to another seat';
    if (/frozen|criterion|bar |Invalid frozen|NO_BRIEF|DIAGNOSIS_REQUIRED|sharper bar/i.test(t)) return 'Item or criterion defect';
    if (/TEST_FAILURE|BEHAVIOR_MISMATCH|red|fail/i.test(t)) return 'Tests fail';
    if (/EMPTY_SUBMIT|SUBMIT_HANDOFF/i.test(t)) return 'Submit handoff';
    return 'Other';
  };
  const norm = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const isMainRed = item => /^Main red/i.test(item?.title || '');
  const open = item => ['open', 'claimed', 'submitted'].includes(item.status);

  // ---------- One pass over the recent events (the last 26 hours, or two windows when longer) ----------
  const recent = [];
  for (let index = events.length - 1; index >= 0; index--) {
    const at = Date.parse(events[index].event_at);
    if (Number.isFinite(at) && at < floor) break;
    if (Number.isFinite(at) && at <= now) recent.push(events[index]);
  }
  recent.reverse();
  const seenKind = new Map(); // kind -> latest instant, to tell "none happened" from "none recorded"
  const dayAgo = now - 24 * HOUR;
  const mkPeriod = () => ({ claimed: new Set(), submitted: new Set(), builds: [], back: 0, backItems: new Set(), backCauses: new Map(), backBy: new Map(),
    green: 0, red: 0, infra: 0, gated: new Set(), gateCauses: new Map(), gateMs: [],
    accepts: 0, rejects: 0, gaveUp: 0, reviewed: new Set(), reviewCauses: new Map(), reviewMs: [],
    landed: new Set(), cycles: [], held: new Map(), heldItems: new Map() });
  const P = { w: mkPeriod(), b: mkPeriod() };
  const slot = at => at > from ? P.w : at > before ? P.b : null;
  const claimAt = new Map(), firstClaim = new Map(), submitAt = new Map(), reserveAt = new Map(), last = new Map(), gateVerdictAt = new Map();
  const seats = new Map(), feed = [], hourly = Array.from({ length: 12 }, () => 0), landedHours = new Set();
  const seat = id => { if (!seats.has(id)) seats.set(id, { seat: id, claims: new Set(), back: new Set(), submitted: new Set(), red: new Set(), last: 0 }); return seats.get(id); };
  const person = by => by && !['sentinel', 'coordinator', 'board', 'person'].includes(by);
  const bouncing = new Map(); // item -> { releases, seats:Set } over 12 h
  const reds = new Map(); // test file -> { items:Set, runs:number }
  const LAST = new Set(['claim', 'renew', 'release', 'submit', 'submit-handoff', 'accept', 'reject', 'reserve', 'reopen', 'merged', 'hold_item', 'unhold_item']);
  let lastMerged = null;
  const mainRedIntervals = new Map(); // item -> { start, end }
  const addedAt = new Map(), endedAt = new Map();
  const ids = [];
  for (const event of recent) {
    const at = Date.parse(event.event_at), kind = event.event_kind, id = event.item_id, by = event.event_by;
    if (at > (seenKind.get(kind) ?? 0)) seenKind.set(kind, at);
    if (LAST.has(kind) && id != null) last.set(id, { at, kind, by });
    if (kind === 'add' && id != null) addedAt.set(id, at);
    if (['merged', 'withdraw', 'accept'].includes(kind) && id != null && kind !== 'accept') endedAt.set(id, at);
    const period = slot(at), inWindow = at > from;
    if (kind === 'claim' && id != null) {
      claimAt.set(id, at); if (!firstClaim.has(id)) firstClaim.set(id, at);
      if (person(by) && inWindow) { seat(by).claims.add(id); seat(by).last = Math.max(seat(by).last, at); }
      if (period) period.claimed.add(id);
      continue;
    }
    if (kind === 'submit' && id != null) {
      const built = claimAt.get(id);
      submitAt.set(id, at);
      if (person(by) && inWindow) { seat(by).submitted.add(id); seat(by).last = Math.max(seat(by).last, at); }
      if (period) { period.submitted.add(id); if (Number.isFinite(built) && at >= built) period.builds.push(at - built); }
      continue;
    }
    if (kind === 'reserve' && id != null) { reserveAt.set(id, at); continue; }
    if (kind === 'release' && id != null) {
      const d = parse(event.event_detail), why = (d.reason || '') + ' ' + (d.reasonCode || '') + ' ' + (d.idleClaim?.kind || '');
      const cause = bucket(why);
      if (!d.review) {
        const holder = d.idleClaim?.holder || d.reclaim?.seat || by;
        if (period) { period.back++; period.backItems.add(id); count(period.backCauses, cause); (period.backCauseItems ??= new Map()).set(cause, [...((period.backCauseItems.get(cause)) ?? []), id]); }
        if (inWindow && person(holder)) { seat(holder).back.add(id); seat(holder).last = Math.max(seat(holder).last, at); }
        if (at > now - 12 * HOUR) { const entry = bouncing.get(id) ?? { releases: 0, seats: new Set() }; entry.releases++; if (holder) entry.seats.add(holder); bouncing.set(id, entry); }
        if (inWindow) feed.push({ at, item: id, stage: 'build', what: 'claim released', cause, detail: norm(d.reason) });
      } else if (period) { period.gaveUp++; count(period.reviewCauses, cause); }
      if (d.review && inWindow) feed.push({ at, item: id, stage: 'review', what: 'review given up', cause, detail: norm(d.reason) });
      continue;
    }
    // A gate's verdict, from whichever record the board keeps: the hand-off's state, a gate run, or a proof receipt.
    let gate = null, d = null;
    if (kind === 'submit-handoff') { d = parse(event.event_detail); gate = d.state === 'green' ? 'green' : d.state === 'red' ? 'red' : d.state === 'infrastructure' ? 'infra' : null; }
    else if (kind === 'gate-run') { d = parse(event.event_detail); if (typeof d.run?.green === 'boolean') gate = d.run.green ? 'green' : 'red'; }
    else if (kind === 'proof-run') { d = parse(event.event_detail); if (['submit', 'gate'].includes(d.receipt?.kind) && Number.isInteger(d.receipt?.exitCode)) gate = d.receipt.exitCode === 0 ? 'green' : 'red'; }
    if (gate) {
      if (at > (seenKind.get('gate') ?? 0)) seenKind.set('gate', at);
      const files = [...new Set((d.run?.failures || d.receipt?.failures || []).map(f => f.file).filter(Boolean))];
      if (id != null) gateVerdictAt.set(id, at);
      if (period) {
        if (gate === 'green') period.green++; else if (gate === 'red') period.red++; else period.infra++;
        if (id != null) period.gated.add(id);
        const queued = submitAt.get(id);
        if (Number.isFinite(queued) && at >= queued) period.gateMs.push(at - queued);
      }
      if (gate === 'red' && at > dayAgo) for (const file of files) { const entry = reds.get(file) ?? { items: new Set(), runs: 0 }; entry.runs++; if (id != null) entry.items.add(id); reds.set(file, entry); }
      if (inWindow && (gate === 'red' || gate === 'infra')) {
        const cause = gate === 'infra' ? 'Runner failure' : 'Tests fail';
        count(period.gateCauses, cause); (period.gateCauseItems ??= new Map()).set(cause, [...((period.gateCauseItems.get(cause)) ?? []), id]);
        feed.push({ at, item: id, stage: 'gate', what: gate === 'infra' ? 'gate stopped' : 'gate red', cause, detail: norm(files.slice(0, 2).join(', ') || d.code || '') });
        if (gate === 'red' && person(by)) seat(by).red.add(id);
      }
      continue;
    }
    // Sent back is one definition on every page: a reject or a reopen, as the Dashboard and Cost count it (#7310).
    if (kind === 'reopen' && id != null && period) { period.rejects++; period.reviewed.add(id); continue; }
    if ((kind === 'accept' || kind === 'reject') && id != null) {
      const d = parse(event.event_detail), reservedAt = reserveAt.get(id);
      if (period) {
        if (kind === 'accept') period.accepts++; else period.rejects++;
        period.reviewed.add(id);
        if (Number.isFinite(reservedAt) && at >= reservedAt) period.reviewMs.push(at - reservedAt);
      }
      if (kind === 'reject' && inWindow) {
        const why = d.reason || d.pipelineCause?.text || d.pipelineCause?.reason || d.pipelineCause?.type || '';
        const label = bucket(why);
        const cause = 'Rejected: ' + (label === 'Other' ? 'work not right' : label.toLowerCase());
        if (period) { count(period.reviewCauses, cause); (period.reviewCauseItems ??= new Map()).set(cause, [...((period.reviewCauseItems.get(cause)) ?? []), id]); }
        feed.push({ at, item: id, stage: 'review', what: 'sent back', cause: label === 'Other' ? 'Work not right' : label, detail: norm(why) });
        if (person(by)) seat(by).last = Math.max(seat(by).last, at);
      }
      continue;
    }
    if (kind === 'merged' && id != null) {
      const d = parse(event.event_detail);
      lastMerged = { at, commit: typeof d.commit === 'string' ? d.commit : null, item: id };
      if (!landedHours.has(id)) {
        landedHours.add(id);
        const age = now - at;
        if (age >= 0 && age < 12 * HOUR) hourly[11 - Math.floor(age / HOUR)]++;
        if (period) { period.landed.add(id); const started = firstClaim.get(id); if (Number.isFinite(started) && at >= started) period.cycles.push(at - started); }
      }
      continue;
    }
    if (kind === 'landing_batch') {
      const d = parse(event.event_detail), batch = d.batch || d;
      if (period === P.w) {
        for (const blocked of batch.blocked || []) {
          const cause = 'Held: ' + bucket((blocked.message || '') + ' ' + (blocked.code || '')).toLowerCase();
          count(period.held, cause); (period.heldItems.get(cause) ?? period.heldItems.set(cause, []).get(cause)).push(Number(blocked.id));
          feed.push({ at, item: Number(blocked.id) || null, stage: 'land', what: 'held at landing', cause: bucket((blocked.message || '') + ' ' + (blocked.code || '')), detail: norm(blocked.message || blocked.code) });
        }
      }
    }
  }
  /** Whether the board recorded any event of these kinds in the last day: a stage with none shows no counts rather than zeros. */
  const recordedKind = (...kinds) => kinds.some(kind => (seenKind.get(kind) ?? 0) > dayAgo);
  const rec = { build: recordedKind('claim'), gate: recordedKind('gate'), review: recordedKind('accept', 'reject'), land: recordedKind('merged'), batches: recordedKind('landing_batch') };
  const w = P.w, b = P.b;

  // ---------- Items: where each one stands now ----------
  const heldIds = new Set((project?.itemHolds ?? []).map(hold => hold.item));
  const holdReason = new Map((project?.itemHolds ?? []).map(hold => [hold.item, hold.reason]));
  const laneHeld = new Set((project?.holds ?? []).map(hold => hold.hold_lane));
  const milestone = (project?.milestones ?? []).find(entry => !entry.shipped && entry.summary?.left > 0) ?? (project?.milestones ?? []).find(entry => !entry.shipped) ?? null;
  const milestoneIds = new Set((milestone?.items ?? []).map(entry => typeof entry === 'number' ? entry : entry?.id).filter(Number.isInteger));
  const reservedNow = item => item.status === 'submitted' && Boolean(item.claim?.by) && Date.parse(item.claim?.until) > now;
  const moveAt = item => last.get(item.id)?.at ?? (Date.parse(item.updatedAt) || now);
  const ageMin = at => Number.isFinite(at) ? Math.max(0, Math.round((now - at) / MIN)) : null;
  const groups = new Map(), moving = { building: [], gate: [], pending: [], reviewing: [] };
  /** Where a submitted item is: held by a reviewer, past its gate and waiting for one, or still in the gate. */
  const phase = item => reservedNow(item) ? 'reviewing' : !rec.gate || (gateVerdictAt.get(item.id) ?? -1) >= (submitAt.get(item.id) ?? moveAt(item)) ? 'pending' : 'gate';
  const add = (key, row) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); };
  const merged = item => Boolean(item.merged) || item.stage === 'merged';
  const unmet = item => (item.blockedBy ?? []).filter(id => { const other = byId.get(id); return other && !merged(other) && other.status !== 'withdrawn'; });
  const blockerCount = new Map();
  const landBlock = new Map();
  for (const batch of [...(project?.landingBatches ?? [])].reverse()) { for (const entry of batch.blocked ?? []) if (!landBlock.has(Number(entry.id))) landBlock.set(Number(entry.id), (entry.code || '') + (entry.message ? ': ' + entry.message : '')); }
  for (const item of items) {
    if (!milestoneIds.has(item.id) || merged(item) || item.status === 'withdrawn') continue;
    const mine = last.get(item.id), age = ageMin(moveAt(item));
    const row = { id: item.id, title: String(item.title || '').slice(0, 110), age, detail: '' };
    if (heldIds.has(item.id) || laneHeld.has(item.lane)) {
      const reason = String(holdReason.get(item.id) ?? '');
      row.detail = norm(reason);
      add(/^Released twice/i.test(reason) ? 'held-twice' : /person|ruling/i.test(reason) ? 'held-person' : 'held', row); continue;
    }
    if (item.status === 'verified') { row.detail = landBlock.get(item.id) || 'not selected by the lander yet'; add(landBlock.has(item.id) ? 'accepted-blocked' : 'accepted', row); continue; }
    const pending = unmet(item);
    if (item.status === 'open' && pending.length) { row.detail = 'blocked by ' + pending.map(id => '#' + id).join(', '); for (const id of pending) count(blockerCount, id); add('blocked', row); continue; }
    if (item.status === 'submitted') { moving[phase(item)].push(item.id); continue; }
    if (item.status === 'claimed') {
      const holder = item.claim?.by || mine?.by;
      row.detail = (holder || '—') + ' · last move ' + age + 'm ago';
      if (age > 30) add('claimed-idle', row); else moving.building.push(item.id);
      continue;
    }
    if (mine && (mine.kind === 'release' || mine.kind === 'reject')) { row.detail = (mine.kind === 'reject' ? 'sent back' : 'released') + ' ' + age + 'm ago'; add(mine.kind === 'reject' ? 'sent-back' : 'released', row); continue; }
    row.detail = 'ready · ' + (item.lane || 'no lane') + ' lane';
    add('never-claimed', row);
  }
  const GROUPS = [
    ['accepted-blocked', 'Accepted: blocked at landing', 'gated', 'The lander refused these. Read why on each item.'],
    ['accepted', 'Accepted, waiting to land', 'review', 'Passed review; the lander has not taken them yet.'],
    ['claimed-idle', 'Claimed, no move for 30+ min', 'build', 'The builder went quiet. Release the claim so another seat picks it up.'],
    ['released', 'Released, no one rebuilding', 'back', 'A seat gave these up and none has taken them since. Split them, or hold them for a ruling.'],
    ['sent-back', 'Sent back, no one rebuilding', 'back', 'Review sent these back and no builder has picked them up.'],
    ['never-claimed', 'Never claimed', 'ready', 'Ready, but no seat takes it. Check which lane it is routed to.'],
    ['blocked', 'Blocked by another item', 'waiting', 'Moves when its blocker lands.'],
    ['held-twice', 'Held: released twice (auto)', 'held', 'Two seats gave up on each. These need a split or a ruling.'],
    ['held-person', 'Held: waits on you', 'held', 'Held until you rule.'],
    ['held', 'Held by the coordinator', 'held', 'Held on purpose; each says why.'],
  ];
  const RED_AT = { 'claimed-idle': 30, released: 60, 'sent-back': 60, 'never-claimed': 30, blocked: 240, 'held-twice': 120, accepted: 60, 'accepted-blocked': 30, held: 480, 'held-person': 480 };
  const topBlocker = [...blockerCount].sort((a, b) => b[1] - a[1])[0] ?? null;
  const stuckGroups = GROUPS.filter(([key]) => groups.has(key)).map(([key, name, dot, hint]) => {
    const rows = groups.get(key).sort((a, b) => (b.age ?? 0) - (a.age ?? 0));
    const oldest = Math.max(0, ...rows.map(row => row.age ?? 0));
    return { key, name, dot, hint: key === 'blocked' && topBlocker && topBlocker[1] > 1 ? hint + ' #' + topBlocker[0] + ' alone blocks ' + topBlocker[1] + '.' : hint,
      count: rows.length, oldest, red: oldest >= RED_AT[key] * 4, redAt: RED_AT[key] * 4, ids: rows.map(row => row.id), rows };
  });
  const stuckLeft = stuckGroups.reduce((sum, group) => sum + group.count, 0);
  const total = milestoneIds.size;
  const clock = project?.clock ?? null;
  const stuck = { milestone: milestone?.name ?? null, count: stuckLeft, left: stuckLeft + moving.building.length + moving.gate.length + moving.pending.length + moving.reviewing.length, total, groups: stuckGroups, moving };

  // ---------- Where each stage loses work ----------
  const ranked = map => [...map].sort((a, c) => c[1] - a[1]).map(([cause, n]) => n >= 0 ? { cause, n } : null).filter(Boolean);
  const idsFor = (map, cause) => [...new Set(map?.get(cause) ?? [])];
  const stage = (key, name, dot, recorded, summary, causes, loss, causeIds) => ({ key, name, dot, recorded, summary, loss, causes: causes.map(entry => ({ ...entry, ids: causeIds(entry.cause) })) });
  const stageList = [
    stage('build', 'Build', 'building', rec.build, { claimed: w.claimed.size, handedBack: w.back }, ranked(w.backCauses), w.back, cause => idsFor(w.backCauseItems, cause)),
    stage('gate', 'Gate', 'gate', rec.gate, { green: rec.gate ? w.green : null, red: rec.gate ? w.red : null, stopped: rec.gate ? w.infra : null }, ranked(w.gateCauses), w.red + w.infra, cause => idsFor(w.gateCauseItems, cause)),
    stage('review', 'Review', 'review', rec.review, { accepted: rec.review ? w.accepts : null, sentBack: rec.review ? w.rejects : null }, ranked(w.reviewCauses), w.rejects + w.gaveUp, cause => idsFor(w.reviewCauseItems, cause)),
    stage('land', 'Land', 'merged', rec.land, { landed: w.landed.size, lastMergedAt: lastMerged?.at ?? null }, ranked(w.held), [...w.held.values()].reduce((sum, n) => sum + n, 0), cause => [...new Set(w.heldItems.get(cause) ?? [])]),
  ];
  const top = stageList.filter(entry => entry.loss > 0).sort((a, c) => c.loss - a.loss)[0] ?? null;
  const topCause = top?.causes[0] ?? null;

  // ---------- Flow cards ----------
  const idsOf = set => [...set];
  const flow = {
    build: { claimed: w.claimed.size, submitted: w.submitted.size, back: w.back, median: median(w.builds), ids: idsOf(w.claimed), recorded: rec.build },
    gate: { green: rec.gate ? w.green : null, red: rec.gate ? w.red : null, stopped: rec.gate ? w.infra : null, pass: rec.gate && w.green + w.red > 0 ? w.green / (w.green + w.red) : null, median: median(w.gateMs), ids: idsOf(w.gated), recorded: rec.gate },
    review: { accepted: rec.review ? w.accepts : null, sentBack: rec.review ? w.rejects : null, pending: moving.pending.length, median: median(w.reviewMs), ids: idsOf(w.reviewed), recorded: rec.review },
    land: { landed: w.landed.size, queued: items.filter(item => item.status === 'verified' && !merged(item)).length, lastAt: lastMerged?.at ?? null, median: median(w.cycles), ids: idsOf(w.landed), recorded: rec.land },
  };
  const hoursTotal = hourly.reduce((sum, n) => sum + n, 0);
  flow.rate = { perHour: rec.land ? w.landed.size * 60 / windowMinutes : null, hours: hourly, total: rec.land ? hoursTotal : null, ids: idsOf(w.landed) };

  // ---------- Time: the verdict, what to do, where item time went ----------
  const compare = project?.statsComparison?.available ? project.statsComparison : null;
  const measured = value => typeof value === 'number' && Number.isFinite(value);
  const tone = (delta, higherBetter) => !measured(delta) || delta === 0 ? '' : (delta > 0) === higherBetter ? 'good' : 'bad';
  const verdicts = (period) => period.accepts + period.rejects;
  // Sent back is rejects and reopens over verdicts, the board's own definition (#7261); a window with none reads 0%, never a dash beside a Rework share (#7310).
  const shared = project?.counts?.sentBack && Number.isFinite(project.counts.sentBack.share) ? project.counts.sentBack.share : null;
  // With no review recorded in the window, the state's shared four-hour share stands in, so no dash sits beside the Rework share.
  const shareNow = rec.review ? (verdicts(w) > 0 ? w.rejects / verdicts(w) : 0) : shared, shareBefore = rec.review ? (verdicts(b) > 0 ? b.rejects / verdicts(b) : 0) : null;
  const landedNow = w.landed.size, landedBefore = b.landed.size;
  const measures = [
    { key: 'landed', label: 'landed', value: rec.land ? landedNow : null, unit: '', delta: rec.land ? landedNow - landedBefore : null, higherBetter: true, ids: idsOf(w.landed) },
    { key: 'sent-back', label: 'sent back', value: shareNow, unit: '%', delta: measured(shareNow) && measured(shareBefore) ? shareNow - shareBefore : null, higherBetter: false, ids: idsOf(w.reviewed), title: 'Share of finished reviews that were sent back, over the same window as the Dashboard count' },
    { key: 'idle', label: 'agents idle', value: compare?.current?.idleShare ?? null, unit: '%', delta: compare?.change?.idleShare ?? null, higherBetter: false, basis: '2 h' },
    { key: 'hours', label: 'agent-hours per landing', value: compare?.current?.agentHoursPerLanding ?? null, unit: '', delta: compare?.change?.agentHoursPerLanding ?? null, higherBetter: false, basis: '2 h' },
  ].map(entry => ({ ...entry, tone: tone(entry.delta, entry.higherBetter) }));
  const SHARES = [['build', 'Build', 'k-build'], ['rework', 'Rework', 'k-rework'], ['reviewWait', 'Pending review', 'k-wait'], ['review', 'Review', 'k-review'], ['land', 'Landing', 'k-land']];
  const shares = compare ? SHARES.map(([key, label, tint]) => ({ key, label, tint, now: compare.current?.stageShares?.[key] ?? null, before: compare.previous?.stageShares?.[key] ?? null })) : null;
  const advice = {
    'Seat heartbeat lost': 'Seats are dying mid-claim. Check the builder sessions and their budgets; the work returns to the queue on its own.',
    'Agent session ended': 'Sessions end before the work is submitted. Check the session budget; the work returns to the queue on its own.',
    'Over budget for one session': 'Items are too big for one session. Split them, or hold them for a ruling.',
    'Routed to another seat': 'Work is routed to seats that are not there. Check each lane has a seat of the family it needs.',
    'Tests fail': 'Tests are failing. The Red tests below name the files; fix the ones on main first.',
    'Runner failure': 'Runners are failing the gate. Check the runner machines and their slots.',
    'Merge conflict': 'Landings are held on merge conflicts. Rebase or split the items that conflict.',
    'Board or lock busy': 'The board is busy. Check what is holding it before adding more seats.',
    'Blocked by another item': 'Items are blocked by other items. Land the blockers first.',
    'Wrong or dirty checkout': 'Seats are working in the wrong or a dirty checkout. Check their seats.',
    'Item or criterion defect': 'Items have defects in their bar. Sharpen the criteria.',
    'Submit handoff': 'Submits are not handing off. Check the gate workers.',
  };
  const sinceMerge = lastMerged ? Math.round((now - lastMerged.at) / MIN) : null;
  let level = 'q', label = 'Reading', say = null;
  if (complete && rec.land) {
    if (landedNow === 0) { level = 'x'; label = 'Stalled'; }
    else if (landedNow < landedBefore) { level = 'a'; label = 'Slow'; }
    else { level = 'l'; label = 'Flowing'; }
    say = { landed: landedNow, before: landedBefore, since: sinceMerge, loss: top ? { stage: top.name, cause: topCause?.cause ?? null, n: topCause?.n ?? null, of: top.loss } : null };
  }
  const time = { level, label, say, doNext: topCause ? advice[topCause.cause] ?? 'Look at the failures below for what this stage hands back.' : null, measures, shares,
    rework: shares ? shares.find(entry => entry.key === 'rework') : null };

  // ---------- Main ----------
  const redItems = items.filter(item => isMainRed(item) && open(item));
  let redMs = 0;
  { const spans = [];
    for (const item of items) {
      if (!isMainRed(item)) continue;
      const start = addedAt.get(item.id) ?? (Date.parse(item.createdAt) || dayAgo);
      const end = open(item) ? now : endedAt.get(item.id) ?? (Date.parse(item.updatedAt) || now);
      const a = Math.max(start, dayAgo), z = Math.min(end, now);
      if (z > a) spans.push([a, z]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let cursor = -Infinity;
    for (const [a, z] of spans) { const begin = Math.max(a, cursor); if (z > begin) redMs += z - begin; cursor = Math.max(cursor, z); }
  }
  const runnerList = Array.isArray(project?.dashboardRunners?.runners) ? project.dashboardRunners.runners : null;
  const main = {
    commit: lastMerged?.commit ? lastMerged.commit.slice(0, 7) : null, at: lastMerged?.at ?? null,
    redItems: redItems.length, redIds: redItems.map(item => item.id), redMs: complete ? redMs : null,
    gateWorkers: machine?.gateWorkers ?? null, gatesQueued: machine?.gateQueued ?? null, handoffsQueued: machine?.handoffQueued ?? null,
    slotsUsed: Number.isFinite(machine?.runnerUsed) ? machine.runnerUsed : runnerList ? runnerList.reduce((sum, runner) => sum + (runner.jobs?.length ?? 0), 0) : null,
    slots: Number.isFinite(machine?.runnerSlots) ? machine.runnerSlots : null,
  };

  // ---------- Failures, bouncing, red tests, seats ----------
  const failures = feed.sort((x, y) => y.at - x.at).map(entry => ({ ...entry }));
  const itemNow = id => { const item = byId.get(id); return item ? { status: item.status, held: heldIds.has(id) || laneHeld.has(item.lane), title: String(item.title || '') } : null; };
  const bounce = [...bouncing].filter(([, entry]) => entry.seats.size >= 2 || entry.releases >= 3).map(([id, entry]) => ({ id, releases: entry.releases, seats: entry.seats.size, now: itemNow(id) }))
    .sort((x, y) => y.releases - x.releases || y.seats - x.seats || x.id - y.id);
  const redRows = [...reds].map(([file, entry]) => ({ file, broke: entry.items.size, runs: entry.runs, owners: [] }));
  const mainRedOpen = items.filter(item => isMainRed(item) && open(item));
  for (const item of mainRedOpen) {
    const named = String(item.title).match(/([\w.-]+(?:\/[\w.-]+)+\.(?:m?js|ts|py|rs|go|php|exs?))/u)?.[1] ?? null;
    if (!named) continue;
    const row = redRows.find(entry => entry.file.endsWith(named) || named.endsWith(entry.file));
    if (row) row.owners.push({ id: item.id, status: heldIds.has(item.id) ? 'held' : item.status });
    else redRows.push({ file: named, broke: null, runs: null, owners: [{ id: item.id, status: heldIds.has(item.id) ? 'held' : item.status }] });
  }
  redRows.sort((x, y) => (y.broke ?? 0) - (x.broke ?? 0) || (y.runs ?? 0) - (x.runs ?? 0) || x.file.localeCompare(y.file));
  const agentLast = new Map((project?.agents ?? []).map(agent => [agent.agent_id, Date.parse(agent.lastMoveAt) || 0]));
  const seatRows = [...seats.values()].map(entry => ({ seat: entry.seat, claimed: entry.claims.size, back: entry.back.size, submitted: entry.submitted.size, red: entry.red.size,
    idle: ageMin(Math.max(entry.last, agentLast.get(entry.seat) ?? 0) || NaN), ids: { claimed: idsOf(entry.claims), back: idsOf(entry.back), submitted: idsOf(entry.submitted), red: idsOf(entry.red) } }))
    .filter(row => row.claimed || row.back || row.submitted)
    .sort((x, y) => y.back - x.back || y.claimed - x.claimed || x.seat.localeCompare(y.seat));

  return { complete, now, windowMinutes, recorded: rec, time, flow, main, stages: stageList, topStage: top?.key ?? null, failures, stuck, clock, bounce, reds: redRows, seats: seatRows,
    machine: machine ? { ...machine, startedBeforeMain: Array.isArray(machine.views) && lastMerged ? machine.views.filter(view => view.startedMs < lastMerged.at).length : null } : null };
}

/**
 * Draw the Pipeline page from its model.
 *
 * @param {object} model - pipelineWatchModel's result.
 * @param {{ href?: (ids: number[]) => string, itemHref?: (id: number) => string, locale?: string, timeZone?: string, machineHere?: boolean, open?: string[]|null }} [options] - open names the groups the person left open; null until they touch one, when the two biggest open
 * @returns {string}
 */
export function pipelineWatchHtml(model, { href = () => '#', itemHref = id => '#' + id, locale = 'en-US', timeZone = 'UTC', machineHere = true, open = null } = {}) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const num = value => Number.isFinite(value) ? String(value) : '—';
  const fixed = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const pct = value => Number.isFinite(value) ? Math.round(value * 100) + '%' : '—';
  const dur = minutes => !Number.isFinite(minutes) ? '—' : minutes < 60 ? Math.round(minutes) + 'm' : minutes < 1440 ? (minutes / 60).toFixed(minutes < 600 ? 1 : 0) + 'h' : (minutes / 1440).toFixed(1) + 'd';
  const ms = value => Number.isFinite(value) ? dur(value / 60_000) : '—';
  const ago = at => Number.isFinite(at) ? dur(Math.max(0, Math.round((model.now - at) / 60_000))) + ' ago' : '—';
  const clock = at => Number.isFinite(at) ? new Date(at).toLocaleTimeString(locale, { timeZone, hour: 'numeric', minute: '2-digit' }) : '—';
  const hm = value => !Number.isFinite(value) ? '—' : value < 3_600_000 ? Math.round(value / 60_000) + 'm' : Math.floor(value / 3_600_000) + 'h ' + String(Math.round(value % 3_600_000 / 60_000)).padStart(2, '0') + 'm';
  const win = { 15: '15 min', 30: '30 min', 60: '1 h', 180: '3 h' }[model.windowMinutes] ?? model.windowMinutes + ' min';
  const link = (ids, content, extra = '') => ids?.length ? '<a class="dash-n" href="' + esc(href(ids)) + '" data-pipeline-ids="' + ids.join(',') + '"' + extra + '>' + content + '</a>' : content;
  const sec = (label, body, { cap = '', lk = '', id = '' } = {}) => '<section class="dash-sec" aria-label="' + esc(label.replace(/<[^>]*>/g, '')) + '"><div class="dash-shd"><p class="dash-lbl"' + (id ? ' id="' + id + '"' : '') + '>' + label + '</p>' + (cap ? '<span class="dash-cap2">' + cap + '</span>' : '') + lk + '</div>' + body + '</section>';
  const dot = kind => '<i class="dash-dot ' + kind + '"></i>';
  const none = text => '<p class="dash-empty pw-none">' + esc(text) + '</p>';
  const unrecorded = 'The board has not recorded these events in the last day.';
  const t = model.time;

  // ---------- 1. Time ----------
  const chip = t.level + '';
  const loss = t.say?.loss;
  const verdictLine = !t.say ? (model.complete ? 'The board has recorded no landings in the last day, so there is nothing to compare.' : 'Reading the board’s history…')
    : (t.level === 'x' ? 'Nothing landed in ' + esc(win) + (Number.isFinite(t.say.since) ? ' · last landing <b>' + esc(dur(t.say.since)) + '</b> ago' : '')
      : '<b>' + t.say.landed + '</b> landed against <b>' + t.say.before + '</b> before')
    + (loss ? ' · biggest loss at <b>' + esc(loss.stage) + '</b>' + (loss.cause ? ': ' + esc(loss.cause.toLowerCase()) + ', <b>' + loss.n + '</b> of <b>' + loss.of + '</b> ' + (loss.stage === 'Build' ? 'hand-backs' : loss.stage === 'Gate' ? 'red gates' : loss.stage === 'Review' ? 'sent back' : 'held') : '') : '');
  const measure = entry => {
    const shown = !Number.isFinite(entry.value) ? '—' : entry.unit === '%' ? Math.round(entry.value * 100) + '%' : entry.key === 'hours' ? fixed(entry.value, 1) : String(entry.value);
    const d = entry.delta, arrow = !Number.isFinite(d) || d === 0 ? '' : (d > 0 ? '↑' : '↓') + (entry.unit === '%' ? Math.abs(Math.round(d * 1000) / 10) + ' pts' : entry.key === 'hours' ? Math.abs(d).toFixed(1) : Math.abs(d));
    const body = '<b>' + shown + '</b> ' + esc(entry.label) + (arrow ? '<small class="' + entry.tone + '">' + arrow + '</small>' : '');
    return '<span class="m"' + (entry.basis ? ' title="Counted over the last ' + entry.basis + ' against the ' + entry.basis + ' before"' : entry.title ? ' title="' + esc(entry.title) + '"' : '') + '>' + link(entry.ids, body) + '</span>';
  };
  const barSvg = (list, key, before) => {
    let x = 0;
    return '<svg class="pw-bar' + (before ? ' before' : '') + '" viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden="true">' + list.map(entry => {
      const share = entry[key]; if (!Number.isFinite(share) || share <= 0) return '';
      const width = Math.max(3, Math.round(share * 1000)), at = x; x += width;
      return '<rect class="' + entry.tint + '" x="' + at + '" y="0" width="' + Math.max(0, width - 2) + '" height="8"/>';
    }).join('') + '</svg>';
  };
  const timeBody = '<div class="dash-card pw-time" aria-label="Time, verdict and where item time went"><div class="pw-verdict"><span class="pw-chip ' + chip + '">' + esc(t.label) + '</span><span class="say">' + verdictLine + '</span></div>'
    + (t.doNext ? '<p class="pw-do"><span class="k">Do next:</span><span>' + esc(t.doNext) + '</span></p>' : '')
    + '<p class="pw-nowl">' + t.measures.map(measure).join('<span class="d">·</span>') + '</p>'
    + (t.shares ? '<div class="pw-twg"><span>Now</span>' + barSvg(t.shares, 'now', false) + '<span>Before</span>' + barSvg(t.shares, 'before', true) + '</div>'
      + '<div class="pw-twkey">' + t.shares.map(entry => '<span><i class="' + entry.tint + '"></i>' + esc(entry.label) + ' <b>' + pct(entry.now) + '</b> <small class="' + (entry.key === 'rework' && entry.now > entry.before ? 'up' : '') + '">was ' + pct(entry.before) + '</small></span>').join('') + '</div>'
      : none('Where item time went needs the board’s two-hour comparison, which it has not sent.'))
    + '</div>';
  const timeCap = t.rework && Number.isFinite(t.rework.now) ? 'Rework <b class="' + (t.rework.now > t.rework.before ? 'back' : '') + '">' + pct(t.rework.before) + ' → ' + pct(t.rework.now) + '</b> · shares over 2 h' : '';

  // ---------- 2. Flow ----------
  const f = model.flow;
  const stageLink = (kind, name, a, bLine, ids, extra = '') => (ids?.length ? '<a class="dash-stage" href="' + esc(href(ids)) + '" data-pipeline-ids="' + ids.join(',') + '">' : '<div class="dash-stage">') + '<span class="dash-stage-t">' + dot(kind) + esc(name) + extra + '</span><span class="dash-stage-a">' + a + '</span><span class="dash-stage-b">' + bLine + '</span>' + (ids?.length ? '</a>' : '</div>');
  const hot = key => model.topStage === key ? '<span class="pw-chip x tag">biggest loss</span>' : '';
  const maxHour = Math.max(1, ...f.rate.hours);
  const hbars = '<svg class="pw-hbars" viewBox="0 0 120 30" preserveAspectRatio="none" aria-hidden="true">' + f.rate.hours.map((n, i) => '<rect class="' + (i === 11 ? 'now' : '') + '" x="' + (i * 10 + 1) + '" y="' + (30 - Math.max(1, n / maxHour * 30)).toFixed(1) + '" width="8" height="' + Math.max(1, n / maxHour * 30).toFixed(1) + '"><title>' + n + '</title></rect>').join('') + '</svg>';
  const flowBody = '<div class="dash-card dash-flowcard"><div class="pw-flow" aria-label="Build, gate, review, land">'
    + stageLink('back', 'Build', '<b>' + num(f.build.claimed) + '</b> claimed → <b>' + num(f.build.submitted) + '</b> submitted', num(f.build.back) + ' back · median ' + ms(f.build.median), f.build.ids, hot('build'))
    + stageLink('gate', 'Gate', f.gate.recorded ? '<b>' + num(f.gate.green) + '</b> green · <b>' + num(f.gate.red) + '</b> red · <b>' + pct(f.gate.pass) + '</b> pass' : '<b>—</b> green · <b>—</b> red', f.gate.recorded ? num(f.gate.stopped) + ' stopped · median ' + ms(f.gate.median) : 'not recorded', f.gate.ids, hot('gate'))
    + stageLink('review', 'Review', f.review.recorded ? '<b>' + num(f.review.accepted) + '</b> accepted · <b>' + num(f.review.sentBack) + '</b> sent back' : '<b>—</b> accepted · <b>—</b> sent back', (f.review.recorded ? num(f.review.pending) + ' pending · median ' + ms(f.review.median) : 'not recorded'), f.review.ids, hot('review'))
    + stageLink('merged', 'Land', '<b>' + num(f.land.landed) + '</b> landed · <b>' + num(f.land.queued) + '</b> queued', 'last ' + ago(f.land.lastAt) + ' · median ' + ms(f.land.median), f.land.ids, hot('land'))
    + (f.rate.ids.length ? '<a class="dash-stage pw-rate" href="' + esc(href(f.rate.ids)) + '" data-pipeline-ids="' + f.rate.ids.join(',') + '">' : '<div class="dash-stage pw-rate">') + '<span class="dash-stage-t"><i class="dash-dot pw-amber"></i>Landed per hour</span><span class="pw-big">' + (Number.isFinite(f.rate.perHour) ? (Number.isInteger(f.rate.perHour) ? f.rate.perHour : f.rate.perHour.toFixed(1)) : '—') + '<small>over ' + esc(win) + '</small></span>' + hbars + '<span class="dash-stage-b">' + num(f.rate.total) + ' in the last 12 hours</span>' + (f.rate.ids.length ? '</a>' : '</div>')
    + '</div></div>';

  // ---------- 3. Main ----------
  const m = model.main;
  const mainBody = '<div class="dash-card pw-health" aria-label="Main health"><span class="pw-kv">main <b class="pw-code">' + esc(m.commit ?? '—') + '</b> · ' + clock(m.at) + '</span>'
    + '<span class="pw-kv">' + link(m.redIds, 'main red <b class="' + (m.redItems ? 'back' : '') + '">' + m.redItems + '</b> items') + '</span>'
    + '<span class="pw-kv">red <b class="' + (m.redMs > 0 ? 'back' : '') + '">' + hm(m.redMs) + '</b> of the last 24 hours</span><span class="vr"></span>'
    + '<span class="pw-kv">gate workers <b>' + num(m.gateWorkers) + '</b></span><span class="pw-kv">gates queued <b>' + num(m.gatesQueued) + '</b></span><span class="pw-kv">hand-offs queued <b>' + num(m.handoffsQueued) + '</b></span><span class="vr"></span>'
    + '<span class="pw-kv">runner slots <b>' + (Number.isFinite(m.slotsUsed) ? m.slotsUsed + (Number.isFinite(m.slots) ? '/' + m.slots : '') : '—') + '</b>' + (Number.isFinite(m.slotsUsed) && m.slots > 0 ? ' ' + Math.round(m.slotsUsed / m.slots * 100) + '%' : '') + '</span></div>';

  // ---------- 4. Why, by stage ----------
  const cmax = Math.max(1, ...model.stages.flatMap(entry => entry.causes.map(cause => cause.n)));
  const whyBody = '<div class="dash-card pw-why" aria-label="Why, by stage">' + model.stages.map(entry => {
    const s = entry.summary;
    const sum = entry.key === 'build' ? '<b>' + num(s.claimed) + '</b> claimed · <b>' + num(s.handedBack) + '</b> handed back'
      : entry.key === 'gate' ? '<b>' + num(s.green) + '</b> green · <b>' + num(s.red) + '</b> red · <b>' + num(s.stopped) + '</b> stopped'
        : entry.key === 'review' ? '<b>' + num(s.accepted) + '</b> accepted · <b>' + num(s.sentBack) + '</b> sent back'
          : '<b>' + num(s.landed) + '</b> landed · last ' + ago(s.lastMergedAt);
    const rows = entry.causes.slice(0, 3).map(cause => '<a class="pw-cz" href="' + esc(href(cause.ids)) + '"' + (cause.ids.length ? ' data-pipeline-ids="' + cause.ids.join(',') + '"' : '') + '><span class="bar"><svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true"><rect width="' + Math.max(2, Math.round(cause.n / cmax * 100)) + '" height="18"/></svg><span>' + esc(cause.cause) + '</span></span><span class="c">' + cause.n + '</span></a>').join('');
    return '<div class="pw-sg"><div class="dash-stage-t">' + dot(entry.dot) + esc(entry.name) + (model.topStage === entry.key ? '<span class="pw-chip x tag">biggest loss</span>' : '') + '</div><div class="s">' + sum + '</div>'
      + (rows || (entry.recorded || entry.key === 'land' && model.recorded.batches ? '<div class="pw-none">Nothing lost</div>' : '<div class="pw-none">Not recorded</div>')) + '</div>';
  }).join('') + '</div>';

  // ---------- 5. Failures ----------
  const SD = { build: 'building', gate: 'gate', review: 'review', land: 'merged' };
  const shown = model.failures.slice(0, 14);
  const failBody = '<div class="dash-card pw-tb"><div class="dash-scroll"><table><thead><tr><th>When</th><th>Item</th><th>What</th><th>Cause</th><th class="hide">Detail</th></tr></thead><tbody>'
    + (shown.length ? shown.map(entry => '<tr><td class="f">' + clock(entry.at) + '</td><td class="m">' + (entry.item ? '<a class="dash-n pw-code" href="' + esc(itemHref(entry.item)) + '">#' + entry.item + '</a>' : '—') + '</td><td>' + dot(SD[entry.stage]) + esc(entry.what) + '</td><td>' + esc(entry.cause) + '</td><td class="w hide" title="' + esc(entry.detail) + '">' + esc(entry.detail) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="pw-none">Nothing failed in ' + esc(win) + '.</td></tr>')
    + '</tbody></table></div></div>';

  // ---------- 6. Not moving ----------
  const sg = model.stuck, age = minutes => dur(minutes);
  const groupsHtml = sg.groups.map((group, index) => {
    const shownRows = group.rows.slice(0, 5), more = group.count - shownRows.length, openNow = open ? open.includes(group.key) : index < 2;
    const clockRules = { 'claimed-idle': ['claim-idle'], released: ['ready'], 'never-claimed': ['ready'], blocked: ['waiting'], held: ['hold'], 'held-twice': ['hold'], 'held-person': ['hold'] }[group.key] ?? [];
    const deadlines = clockRules.flatMap(rule => {
      const entry = model.clock?.byRule?.[rule];
      return entry ? ['next deadline ' + clock(entry.nextDeadlineAt) + ' · default move ' + entry.move] : [];
    });
    const hint = [group.hint, ...deadlines].join(' · ');
    return '<div class="pw-gr' + (openNow ? ' open' : '') + '" data-pipeline-group="' + esc(group.key) + '"><div class="pw-gh" role="button" tabindex="0" aria-expanded="' + openNow + '"><span class="tw">▶</span>' + dot(group.dot) + '<span class="nm">' + esc(group.name) + '</span><span class="ct">' + group.count + '</span><span class="old' + (group.red ? ' back' : '') + '" title="oldest">' + age(group.oldest) + '</span><span class="hint">' + esc(hint) + '</span><a class="open" href="' + esc(href(group.ids)) + '" data-pipeline-ids="' + group.ids.join(',') + '">Open in Items ›</a></div>'
      + '<div class="pw-gl">' + shownRows.map(row => '<a class="pw-ir" href="' + esc(itemHref(row.id)) + '"><span class="id">#' + row.id + '</span><span class="tt">' + esc(row.title) + '</span><span class="dt">' + esc(row.detail) + '</span><span class="ag' + (row.age >= group.redAt ? ' back' : '') + '">' + age(row.age) + '</span></a>').join('')
      + (more > 0 ? '<a class="pw-gmore" href="' + esc(href(group.ids)) + '" data-pipeline-ids="' + group.ids.join(',') + '">' + more + ' more in Items ›</a>' : '') + '</div></div>';
  }).join('');
  const mv = sg.moving;
  const clockAlert = model.clock ? '<p class="pw-clock"><span class="dash-pill static' + (model.clock.withoutOwnerDeadline > 0 ? ' back' : '') + '">items without owner+deadline: ' + num(model.clock.withoutOwnerDeadline) + '</span> <span class="dash-pill static">overdue: ' + num(model.clock.overdue) + ' · oldest ' + dur(model.clock.oldestOverdueMinutes) + '</span></p>' : '';
  const stuckBody = '<div class="dash-card pw-stuck" aria-label="Where items are not moving">' + clockAlert + (groupsHtml || '<p class="dash-empty pw-none">' + (sg.milestone ? 'Every unfinished item in ' + esc(sg.milestone) + ' is moving.' : 'The board has no release in focus.') + '</p>')
    + '<div class="pw-moving"><span class="ct">Moving</span>'
    + '<span class="pw-kv">' + link(mv.building, dot('building') + '<b>' + mv.building.length + '</b> building') + '</span>'
    + '<span class="pw-kv">' + (model.recorded.gate ? link(mv.gate, dot('gate') + '<b>' + mv.gate.length + '</b> in the gate') : dot('gate') + '<b>—</b> in the gate') + '</span>'
    + '<span class="pw-kv">' + link(mv.pending, dot('review') + '<b>' + mv.pending.length + '</b> pending review') + '</span>'
    + '<span class="pw-kv">' + link(mv.reviewing, dot('review') + '<b>' + mv.reviewing.length + '</b> in review') + '</span><button type="button" class="dash-lk pw-dash" data-tab="dashboard">Dashboard ›</button></div></div>';

  // ---------- 7. Bouncing and red tests ----------
  const ST = { claimed: '<span class="pw-chip b">building</span>', open: '<span class="pw-chip p">ready</span>', submitted: '<span class="pw-chip r">in review</span>', verified: '<span class="pw-chip l">accepted</span>', held: '<span class="pw-chip q">held</span>', withdrawn: '<span class="pw-chip q">withdrawn</span>' };
  const stateOf = now => !now ? '<span class="pw-chip q">gone</span>' : now.held ? ST.held : ST[now.status] ?? '<span class="pw-chip q">' + esc(now.status) + '</span>';
  const BOUNCE_ROWS = 8, bounced = model.bounce.slice(0, BOUNCE_ROWS), moreBounce = model.bounce.length - bounced.length;
  const bounceBody = '<div class="dash-card pw-tb"><div class="dash-scroll"><table><thead><tr><th>Item</th><th class="r">Releases</th><th class="r">Seats</th><th>Now</th><th class="hide">Title</th></tr></thead><tbody>'
    + (model.bounce.length ? bounced.map(row => '<tr><td class="m"><a class="dash-n pw-code" href="' + esc(itemHref(row.id)) + '">#' + row.id + '</a></td><td class="dash-num' + (row.releases >= 3 ? ' back' : '') + '">' + row.releases + '</td><td class="dash-num">' + row.seats + '</td><td>' + stateOf(row.now) + '</td><td class="t hide" title="' + esc(row.now?.title ?? '') + '">' + esc(row.now?.title ?? '') + '</td></tr>').join('') + (moreBounce > 0 ? '<tr><td colspan="5" class="pw-more">' + link(model.bounce.slice(BOUNCE_ROWS).map(row => row.id), moreBounce + ' more in Items ›') + '</td></tr>' : '')
      : '<tr><td colspan="5" class="pw-none">No item was released by two seats in 12 hours.</td></tr>')
    + '</tbody></table></div></div>';
  const redBody = '<div class="dash-card pw-tb"><div class="dash-scroll"><table><thead><tr><th>Test file</th><th class="r">Broke</th><th class="r hide">Runs</th><th>Fix item</th></tr></thead><tbody>'
    + (model.reds.length ? model.reds.map(row => '<tr><td class="m" title="' + esc(row.file) + '">' + esc(row.file) + '</td><td class="dash-num' + (row.broke >= 3 ? ' back' : '') + '">' + num(row.broke) + '</td><td class="dash-num z hide">' + num(row.runs) + '</td><td>'
      + (row.owners.length ? row.owners.map(owner => '<a class="dash-n pw-code" href="' + esc(itemHref(owner.id)) + '">#' + owner.id + '</a> ' + (ST[owner.status] ?? '')).join(' ') : '<span class="pw-lone">no item</span>') + '</td></tr>').join('')
      : '<tr><td colspan="4" class="pw-none">No red test file is recorded.</td></tr>')
    + '</tbody></table></div></div>';

  // ---------- 8. Hand-backs ----------
  const cell = (ids, value, extra = '') => '<td class="dash-num ' + extra + '">' + (value ? link(ids, String(value)) : '<span class="z">–</span>') + '</td>';
  const SEAT_ROWS = 12, seatsShown = model.seats.slice(0, SEAT_ROWS), moreSeats = model.seats.length - seatsShown.length;
  const seatBody = '<div class="dash-card pw-tb"><div class="dash-scroll"><table><thead><tr><th>Seat</th><th class="r">Claimed</th><th class="r">Back</th><th class="r">Submitted</th><th class="r hide">Red</th><th class="r">Idle</th></tr></thead><tbody>'
    + (model.seats.length ? seatsShown.map(row => '<tr><td class="m">' + esc(row.seat) + '</td>' + cell(row.ids.claimed, row.claimed) + cell(row.ids.back, row.back, row.back > row.submitted && row.back > 2 ? 'amb' : '') + cell(row.ids.submitted, row.submitted) + cell(row.ids.red, row.red, 'hide' + (row.red ? ' back' : '')) + '<td class="dash-num' + (row.idle > 30 ? ' amb' : '') + '">' + dur(row.idle) + '</td></tr>').join('') + (moreSeats > 0 ? '<tr><td colspan="6" class="pw-more">' + moreSeats + ' more seats, quieter than these</td></tr>' : '')
      : '<tr><td colspan="6" class="pw-none">No seat claimed or handed back work in ' + esc(win) + '.</td></tr>')
    + '</tbody></table></div></div>';

  // ---------- 9. This machine ----------
  const mc = model.machine;
  let machineBody;
  if (!machineHere) machineBody = '<div class="dash-card pw-mach"><p class="pw-none">This page does not run on the machine whose pipeline it shows, so it has no samples to draw.</p></div>';
  else if (!mc) machineBody = '<div class="dash-card pw-mach"><p class="pw-none">Reading this machine’s CPU samples…</p></div>';
  else {
    const parts = mc.parts ?? [], busy = parts.reduce((sum, part) => sum + part.now, 0), pmax = Math.max(0.01, ...parts.map(part => part.now));
    const loadTone = Number.isFinite(mc.load?.[0]) && mc.cores && mc.load[0] > mc.cores ? 'back' : '';
    machineBody = '<div class="dash-card pw-mach" aria-label="This machine"><div class="facts"><span><b>' + fixed(busy, 1) + '</b> of ' + num(mc.cores) + ' cores busy</span><span>load <b class="' + loadTone + '">' + (mc.load ?? []).map(value => Math.round(value)).join('</b> / <b>') + '</b></span><span>disk free <b>' + (Number.isFinite(mc.diskFreeGb) ? fixed(mc.diskFreeGb, 1) + ' GB' : '—') + '</b></span>'
      + '<span>started before main <b class="' + (mc.startedBeforeMain > 0 ? 'amb' : '') + '">' + num(mc.startedBeforeMain) + '</b> board views</span></div>'
      + '<div class="dash-scroll"><table><thead><tr><th>Part</th><th class="hide">Now (5 min)</th><th class="r">Now</th><th class="r">Avg</th><th class="r">Peak</th><th class="r hide">Procs</th><th class="hide">Busiest command</th></tr></thead><tbody>'
      + (parts.length ? parts.map(part => '<tr><td>' + esc(part.part) + '</td><td class="bar hide"><svg class="pw-cpu" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="bg" width="100" height="6"/><rect class="' + (part.now >= 2 ? 'hi' : '') + '" width="' + Math.round(part.now / pmax * 100) + '" height="6"/></svg></td><td class="dash-num ink">' + fixed(part.now, 2) + '</td><td class="dash-num">' + fixed(part.avg, 2) + '</td><td class="dash-num">' + fixed(part.peak, 2) + '</td><td class="dash-num hide">' + num(part.procs) + '</td><td class="w hide pw-code" title="' + esc(part.command) + '">' + esc(part.command) + '</td></tr>').join('')
        : '<tr><td colspan="7" class="pw-none">No CPU sample has been taken yet; one comes every 10 seconds.</td></tr>')
      + '</tbody></table></div><p class="pw-mnote">1.00 = one full core. ' + (Number.isFinite(mc.minutes) && mc.minutes > 0 ? 'Averages and peaks cover the ' + mc.minutes + ' minute' + (mc.minutes === 1 ? '' : 's') + ' sampled while this page was open.' : 'Averages and peaks fill in as the page stays open.') + '</p></div>';
  }

  const left = sg.total ? '<b>' + sg.count + '</b> of ' + sg.left + ' left' + (sg.milestone ? ' in <b>' + esc(sg.milestone) + '</b>' : '') : '';
  return '<div class="dash-live pw-page">'
    + sec('Time · ' + esc(win) + ' vs before', timeBody, { cap: timeCap, id: 'pw-time-cap' })
    + sec('Flow · ' + esc(win), flowBody, { id: 'pw-flow-cap' })
    + sec('Main · 24 h', mainBody, { lk: '<button type="button" class="dash-lk" data-tab="dashboard">Runners ›</button>' })
    + '<div class="pw-split">' + sec('Why · ' + esc(win), whyBody) + sec('Failures · ' + esc(win), failBody, { lk: '<button type="button" class="dash-lk" data-tab="activity">Activity ›</button>' }) + '</div>'
    + sec('Not moving<span class="dash-pill static">' + sg.count + '</span>', stuckBody, { cap: left })
    + '<div class="pw-two">' + sec('Bouncing · 12 h', bounceBody, { lk: model.bounce.length ? '<a class="dash-lk" href="' + esc(href(model.bounce.map(row => row.id))) + '" data-pipeline-ids="' + model.bounce.map(row => row.id).join(',') + '">Items ›</a>' : '' }) + sec('Red tests', redBody) + '</div>'
    + sec('Hand-backs · ' + esc(win), seatBody, { lk: '<button type="button" class="dash-lk" data-tab="dashboard">Agents ›</button>' })
    + sec('This machine', machineBody, { cap: 'CPU every 10 s' })
    + '<p class="dash-footnote">Every group and count opens the items it counts. A number the board has not recorded reads —.</p></div>';
}
