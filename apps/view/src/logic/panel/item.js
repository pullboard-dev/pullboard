/**
 * The Items detail panel's model and markup (approved mockup item-panel-approved-1113, #7571): one header block, then one
 * scroll of sections in a fixed order, each shown only when it has content: Sent back or Passed, Latest gate, Journey,
 * Done when, Check, Brief, Files, History. Every statement is read from the item's own thread, receipts and verdicts.
 * Both functions are embedded in the page as source text, so each reads only its arguments and language globals [N26].
 *
 * @param {object} item - The opened item as the page holds it (summary laid over its detail).
 * @param {object} ctx - What only the page knows: { now, esc, name(seat), stage, holder, milestone, brief, files, reason(code), note, check, baseline, historyOpen }.
 * @returns {object} The panel model for itemPanelHtml.
 */
export function itemPanelModel(item, ctx) {
  const MIN = 60_000, HOUR = 3_600_000, DAY = 24 * HOUR;
  const { now, esc, name } = ctx;
  const at = value => Date.parse(value);
  const clock = ms => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/ (AM|PM)$/u, (_, half) => ' ' + half.toLowerCase());
  const day = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const stamp = ms => (new Date(ms).toDateString() === new Date(now).toDateString() ? '' : day(ms) + ' ') + clock(ms);
  const dur = ms => {
    const m = Math.max(1, Math.round(ms / MIN));
    if (m >= 48 * 60) return Math.floor(m / 1440) + ' d ' + Math.round((m % 1440) / 60) + ' h';
    if (m >= 60) return Math.floor(m / 60) + ' h' + (m % 60 && m < 600 ? ' ' + (m % 60) + ' m' : '');
    return m + ' m';
  };
  const sha = value => String(value || '').slice(0, 7);
  const code = value => '<code>' + esc(sha(value)) + '</code>';
  const thread = (item.thread || []).filter(entry => Number.isFinite(at(entry.at))).sort((a, b) => at(a.at) - at(b.at) || (a.eventId || 0) - (b.eventId || 0));
  const moves = thread.filter(entry => entry.type === 'move');
  const facts = thread.filter(entry => entry.type === 'fact');
  const verdicts = item.verdicts || [];
  const verdict = item.verdict || null;
  const landed = item.status === 'verified';
  const sentBack = verdicts.filter(entry => entry.decision === 'REJECT').length;

  // ---- header ----
  const claim = moves.findLast(entry => entry.kind === 'claim');
  const added = moves.find(entry => entry.kind === 'add');
  const merged = moves.findLast(entry => entry.kind === 'merged');
  const who = item.status === 'claimed' ? (item.claim?.by ?? item.owner ?? null) : item.status === 'submitted' ? (item.claim?.by ?? item.reviewer ?? null) : null;
  // The commit is a placeholder the markup fills with a copyable hash.
  let right = '', commit = '';
  if (landed) {
    commit = item.merged || merged?.detail?.commit || '';
    right = (commit ? '\u0001' : '') + (commit && merged ? ' · ' : '') + (merged ? esc(day(at(merged.at))) : '');
  } else if (item.status === 'submitted' && !who && item.commit) { commit = item.commit; right = 'submitted \u0001'; }
  else if (who) right = esc((ctx.holderName || name)(who)) + (claim && item.status === 'claimed' ? ' · ' + esc(dur(now - at(claim.at))) : '');
  else if (added) right = 'added ' + esc(dur(now - at(added.at))) + ' ago';
  const meta = [item.lane, item.route, String(ctx.milestone || '').replace(/^(\S+): /u, '$1 ')].filter(Boolean);
  const head = { id: item.id, stage: ctx.stage, back: landed ? 0 : sentBack, right, commit, meta };

  // ---- the verdict section ----
  let section = null;
  if (verdict && !(verdict.decision === 'REJECT' && landed)) {
    const pass = verdict.decision === 'ACCEPT';
    section = { pass, code: verdict.reason || '', label: String(ctx.reason(verdict.reason)).replace(/^./u, first => first.toUpperCase()), by: verdict.by ? name(verdict.by) : '', at: Number.isFinite(at(verdict.at)) ? stamp(at(verdict.at)) : '', commit: verdict.commit || '', note: ctx.note || '', long: String(ctx.note || '').length > 170 || String(ctx.note || '').split(/\r?\n/u).length > 3 };
  }

  // ---- the latest gate ----
  let gate = null;
  const runs = facts.filter(entry => /^Gate job \S+ (?:red|green)\b/u.test(entry.text || ''));
  const lastRun = runs.at(-1);
  if (lastRun && /^Gate job \S+ red\b/u.test(lastRun.text) && !landed) {
    const lines = String(lastRun.text).split(/\r?\n/u).slice(1).map(line => line.trim()).filter(Boolean);
    const parts = lines.map(line => {
      const found = /not ok: (\S+) :: (.+?)(?: \(shard [^)]*\))?$/u.exec(line);
      return found ? { file: found[1].slice(found[1].lastIndexOf('/') + 1), path: found[1], text: found[2] } : { file: '', path: '', text: line.replace(/^failing parts:\s*/u, '') };
    }).filter(part => part.text);
    gate = { sha: /red at ([0-9a-f]{7,40})/u.exec(lastRun.text)?.[1] ?? '', at: clock(at(lastRun.at)), rows: parts.slice(0, 3), more: Math.max(0, parts.length - 3) };
    if (!gate.rows.length) gate = { ...gate, rows: [{ file: '', path: '', text: String(lastRun.text).split(/\r?\n/u)[0] }] };
  }

  // ---- the journey: segments read from the item's moves ----
  const NAME = { ready: 'Ready', build: 'Building', held: 'Held', rev: 'In review', land: 'Landing' };
  let journey = null;
  if (moves.some(entry => entry.kind === 'claim')) {
    let cur = null, ended = null, heldFrom = 'ready', back = null;
    const segs = [];
    const open = (k, t) => { if (cur && cur.k === k) return; if (cur) segs.push({ k: cur.k, a: cur.a, b: t }); cur = { k, a: t }; };
    for (const entry of moves) {
      const t = at(entry.at), kind = entry.kind;
      if (ended) break;
      if (kind === 'add') open('ready', t);
      else if (kind === 'claim') open('build', t);
      else if (kind === 'release' || kind === 'lapse') open('ready', t);
      else if (kind === 'hold_item') { heldFrom = cur?.k ?? 'ready'; open('held', t); }
      else if (kind === 'unhold_item') open(heldFrom === 'held' ? 'ready' : heldFrom, t);
      else if (kind === 'submit' || kind === 'reserve') open('rev', t);
      else if (kind === 'accept') open('land', t);
      else if (kind === 'reject' || kind === 'reopen') { back = t; open('ready', t); }
      else if (kind === 'merged' || kind === 'withdraw') { ended = t; }
    }
    const start = segs[0]?.a ?? cur?.a ?? 0, end = ended ?? now;
    if (cur) segs.push({ k: cur.k, a: cur.a, b: end });
    // Fold glances (a few minutes in a non-review stage) into their neighbour, and join equal neighbours.
    const out = [];
    for (const seg of segs) {
      const m = (seg.b - seg.a) / MIN, last = out.at(-1);
      if (last && (last.k === seg.k || (m < 20 && seg.k !== 'rev' && last.k !== 'rev'))) last.b = seg.b; else out.push({ ...seg });
    }
    const total = Math.max(1, end - start);
    if (out.length) {
      journey = { segs: out.map(seg => ({ k: seg.k, name: NAME[seg.k], dur: dur(seg.b - seg.a), share: (seg.b - seg.a) / total, from: (seg.a - start) / total })),
        back: back !== null && back >= start ? (back - start) / total : null, backTitle: back === null ? '' : 'Sent back ' + stamp(back),
        start: stamp(start), end: ended ? clock(ended) : 'now', span: dur(total),
        built: dur(out.filter(seg => seg.k === 'build').reduce((sum, seg) => sum + seg.b - seg.a, 0)), builtAny: out.some(seg => seg.k === 'build') };
    }
  }

  // ---- Done when: one row per clause, with its evidence kind and proven state ----
  const text = String(item.criterion || '').trim();
  const clauses = [];
  if (text) {
    const marks = [];
    let from = 0, n = 1;
    for (;;) {
      const found = new RegExp('(?:^|\\s)' + n + '\\.\\s+', 'u').exec(text.slice(from));
      if (!found) break;
      marks.push({ n, start: from + found.index, body: from + found.index + found[0].length });
      from = from + found.index + found[0].length; n++;
    }
    const slices = marks.length ? marks.map((mark, index) => ({ n: mark.n, text: text.slice(mark.body, marks[index + 1]?.start ?? text.length).trim() })) : [{ n: 1, text }];
    const receipts = (item.proofReceipts || []).filter(receipt => receipt.exitCode === 0 && ['check', 'submit', 'gate'].includes(receipt.kind)).sort((a, b) => at(a.at) - at(b.at));
    const green = receipts.at(-1);
    const proven = landed || verdict?.decision === 'ACCEPT';
    for (const slice of slices) {
      const kind = /\[([a-z-]+)\]\.?\s*$/u.exec(slice.text)?.[1] ?? '';
      const body = slice.text.replace(/\s*\[[a-z-]+\]\.?\s*$/u, '');
      const note = facts.findLast(entry => new RegExp('\\bclauses?\\s+' + slice.n + '\\b', 'iu').test(entry.text || '') && entry.by !== 'sentinel');
      const state = proven ? 'ok' : note || green ? 'run' : 'no';
      let ev;
      if (note) ev = esc(name(note.by)) + ': ' + esc(String(note.text).replace(/^clause\s+\d+\s*(?:\[[a-z-]+\])?\s*:\s*/iu, ''));
      else if (green) ev = 'Builder ' + esc(name(green.seat)) + ': ' + (receipts.at(-1).kind === 'check' ? 'check' : 'gate') + ' green at ' + code(green.commit) + ', ' + esc(clock(at(green.at))) + '.';
      else ev = state === 'ok' ? '' : 'No run yet.';
      if (state === 'ok' && verdict?.by) ev += (ev ? ' ' : '') + 'Read by ' + esc(name(verdict.by)) + '.';
      else if (state === 'run') ev += ' Not reviewed.';
      clauses.push({ n: slice.n, text: body, kind, state, ev });
    }
  }

  // ---- Check ----
  let check = null;
  if (item.check) {
    const command = String(item.check);
    const path = [...command.matchAll(/(?:^|\s)((?:[\w.-]+\/)*[\w.-]+\.[cm]?js)(?=\s|$)/gu)].map(found => found[1]).filter(file => /(?:^|\/)(?:tests?|journeys)\//u.test(file)).at(-1) ?? '';
    const baseline = ctx.baseline;
    check = { path, command, cap: (path ? 'passes with no failures' : 'runs one command') + ' · ' + baseline.label, warn: baseline.warn };
  }

  // ---- History ----
  const SHORT = { ready: 'Ready' };
  void SHORT;
  const reasonOf = detail => typeof detail?.reason === 'string' ? detail.reason : '';
  const rows = [];
  for (const entry of thread) {
    const d = entry.detail || {}, by = esc(name(entry.by)), t = at(entry.at);
    const row = (chip, tone, body) => rows.push({ t: clock(t), full: stamp(t), chip, tone, text: body });
    if (entry.type === 'fact') {
      const found = /^Gate job \S+ red at ([0-9a-f]{7,40})/u.exec(entry.text || '');
      if (found) row('Gate', 'gt', 'red at ' + code(found[1]) + ': ' + ((String(entry.text).match(/not ok:/gu) || []).length || 'some') + ' proof cases failed');
      continue;
    }
    switch (entry.kind) {
      case 'add': row('Ready', 'rd', 'added by ' + by); break;
      case 'milestone_placed': row('Placed', 'g', 'in ' + esc(String(d.milestone || '')) + ' by ' + esc(d.rule || 'rule') + (d.rule === 'override' && d.reason ? ': ' + esc(d.reason) : '')); break;
      case 'claim': row('Building', 'b', by + ' claimed'); break;
      case 'release': row('Released', 'g', by + (reasonOf(d) ? ': ' + esc(reasonOf(d)) : ' let go')); break;
      case 'lapse': row('Released', 'g', by + ' lost its heartbeat; claim returned'); break;
      case 'submit': row('In review', 'r', by + ' submitted ' + code(d.commit)); break;
      case 'reject': row('Sent back', 'x', by + ': ' + esc(ctx.reason(d.reason))); break;
      case 'accept': row('Passed', 'l', by + ': ' + esc(ctx.reason(d.reason))); break;
      case 'merged': row('Landed', 'l', code(d.commit) + ' on main' + (d.forced ? ', forced by ' + by : '')); break;
      case 'edit': row('Edited', 'g', d.criterion ? 'criterion rewritten' : d.title ? 'title changed' : 'edited'); break;
      case 'hold_item': row('Held', 'h', reasonOf(d) ? esc(reasonOf(d)) : 'held by ' + by); break;
      case 'unhold_item': row('Held', 'h', 'hold lifted by ' + by); break;
      default: break;
    }
  }
  rows.reverse();

  const full = thread.filter(entry => !['usage', 'shared-usage'].includes(entry.kind)).length;
  return { head, section, full, gate, journey, clauses, proven: clauses.filter(clause => clause.state === 'ok').length, check, fields: Array.isArray(item.fields) ? item.fields.filter(field => field && field.name) : [], links: Array.isArray(item.links) ? item.links.filter(link => link && Number.isSafeInteger(link.id)) : [], brief: ctx.brief || '', briefLong: String(ctx.brief || '').length > 190 || String(ctx.brief || '').split(/\r?\n/u).length > 3, files: ctx.files || [], history: rows, historyOpen: Boolean(ctx.historyOpen) };
}

/**
 * The panel's markup from its model. Proportions are SVG geometry (the view refuses inline styles).
 * The page embeds this function's source text, so it reads only its arguments and language globals [N26].
 *
 * @param {object} model - From itemPanelModel.
 * @param {{ esc: Function, rich: Function, hash: Function }} h - Page helpers: escape, linked text, a copyable hash.
 * @returns {string} The panel's markup, without its outer wrapper.
 */
export function itemPanelHtml(model, h) {
  const { esc } = h;
  const icon = (paths, cls = '') => '<svg class="ip-i ' + cls + '" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  const ICON = {
    ok: '<path d="M3.5 8.5l3 3 6-6.5"/>', run: '<circle cx="8" cy="8" r="5.5"/><path d="M5.6 8.3l1.7 1.7 3.2-3.5"/>', no: '<circle cx="8" cy="8" r="5.5" stroke-dasharray="2.2 2"/>',
    back: '<path d="M6 4L2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"/>', file: '<path d="M4 2h5l3 3v9H4zM9 2v3h3"/>',
    test: '<path d="M6 2.5h4M7 2.5v4L3.5 12.5a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4"/>', x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  };
  /** A short hash that copies the whole one. */
  const copy = full => '<button class="hash-copy" type="button" title="' + esc(full) + '" aria-label="Copy full hash ' + esc(full) + '" data-copy="' + esc(full) + '"><code class="inline sha" title="' + esc(full) + '">' + esc(String(full).slice(0, 12)) + '</code></button>';
  const WORD = { ok: 'Proven', run: 'Run green', no: 'Not run' };
  const STAGE = { Verified: 'l', Ready: 'rd', Building: 'b', 'In review': 'r', Landed: 'l', Merged: 'l', Landing: 'l', Blocked: 'g', Held: 'h', Withdrawn: 'g', Gate: 'gt' };
  const sec = (label, cap, body, link = '') => '<section class="ip-sec"><div class="ip-shd"><p class="ip-lbl">' + esc(label) + '</p>' + (cap ? '<span class="ip-cap">' + cap + '</span>' : '') + link + '</div>' + body + '</section>';
  const more = (open, shown = 'Show all') => '<button class="link" type="button" data-item-panel-more aria-expanded="' + open + '">' + shown + '</button>';

  const hd = model.head;
  const header = '<header class="item-panel-head"><div class="ip-l1"><span class="id">#' + hd.id + '</span><span class="ip-chip ' + (STAGE[hd.stage] || 'g') + '">' + esc(hd.stage === 'Merged' ? 'Landed' : hd.stage) + '</span>'
    + (hd.back ? '<span class="ip-mark" title="Sent back ' + hd.back + (hd.back === 1 ? ' time' : ' times') + '">' + icon(ICON.back) + hd.back + '</span>' : '')
    + (h.marks ? '<span class="ip-marks stage-marks">' + h.marks + '</span>' : '') + '<span class="ip-who">' + hd.right.replace('\u0001', copy(hd.commit)) + '</span></div>'
    + '<h2>' + h.title + '</h2>'
    + (hd.meta.length ? '<p class="ip-meta">' + hd.meta.map(esc).join(' · ') + '</p>' : '') + (h.overlap ? '<div class="ip-overlap">' + h.overlap + '</div>' : '') + '</header>';

  let out = '';
  const v = model.section;
  if (v) {
    out += sec(v.pass ? 'Passed' : 'Sent back', [v.at, v.by].filter(Boolean).map(esc).join(' · '),
      '<div class="ip-card ip-verdict item-panel-latest' + (v.pass ? '' : ' sentback') + '"><p class="ip-vh"><span class="ip-chip ' + (v.pass ? 'l' : 'x') + '" title="' + esc(v.code) + '">' + esc(v.label) + '</span>' + (v.commit ? '<span class="ip-at">at ' + copy(v.commit) + '</span>' : '') + '</p>'
      + '<div class="ip-vn note">' + h.note + '</div>' + (v.long ? more(false) : '') + '</div>');
  }
  if (model.gate) {
    const g = model.gate;
    out += sec('Latest gate', 'red' + (g.sha ? ' at <code>' + esc(g.sha.slice(0, 7)) + '</code>' : '') + ' · ' + esc(g.at),
      '<div class="ip-card">' + g.rows.map(row => '<div class="ip-row ip-gr"' + (row.path ? ' title="' + esc(row.path) + '"' : '') + '>' + icon(ICON.x, 'bad') + (row.file ? '<code>' + esc(row.file) + '</code>' : '') + '<span>' + esc(row.text) + '</span></div>').join('')
      + (g.more ? '<div class="ip-row ip-mo"><span>' + g.more + ' more failed</span></div>' : '') + '</div>');
  }
  const j = model.journey;
  if (j) {
    const W = Math.max(240, h.width || 364), mini = 0.11;
    const bar = j.segs.map(seg => '<rect class="js-' + seg.k + '" x="' + (seg.from * W).toFixed(2) + '" y="0" width="' + Math.max(2, seg.share * W - 1).toFixed(2) + '" height="10"><title>' + esc(seg.name + ' ' + seg.dur) + '</title></rect>').join('');
    const labels = j.segs.filter(seg => seg.share >= mini).map(seg => '<text class="jl1" x="' + (seg.from * W + 1).toFixed(2) + '" y="25">' + esc(seg.name) + '</text><text class="jl2" x="' + (seg.from * W + 1).toFixed(2) + '" y="39">' + esc(seg.dur) + '</text>').join('');
    const mark = j.back === null ? '' : '<rect class="jm" x="' + (j.back * W - 1).toFixed(2) + '" y="-3" width="2" height="16"><title>' + esc(j.backTitle) + '</title></rect>';
    const svg = '<svg class="ip-journey" viewBox="0 -4 ' + W + ' 66" role="img" aria-label="Journey of #' + hd.id + '"><defs><pattern id="ip-p-held" width="6" height="6" patternUnits="userSpaceOnUse"><rect class="ph" width="3" height="6"/></pattern>'
      + '<pattern id="ip-p-land" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="pl1" width="6" height="6"/><rect class="pl2" width="3" height="6"/></pattern></defs>'
      + '<rect class="jtrack" x="0" y="0" width="' + W + '" height="10"/>' + bar + mark + labels + '<line class="jrule" x1="0" x2="' + W + '" y1="46" y2="46"/>'
      + '<text class="jt" x="0" y="59">' + esc(j.start) + '</text><text class="jt" x="' + W + '" y="59" text-anchor="end">' + esc(j.end) + '</text></svg>';
    out += sec('Journey', esc(j.span) + (j.builtAny ? ' · building ' + esc(j.built) : ''), '<div class="ip-card ip-jc">' + svg + '</div>');
  }
  const tl = h.strip && h.strip.summary && h.strip.summary.total_ms > 0 ? h.strip.summary : null;
  if (tl) {
    // The Timeline strip [#12162]: one line from filed to now or merged, a segment per bucket, wait reason and UNACCOUNTED stretch, each as wide as its share of the item's time.
    const W = 1000;
    const span = ms => { const s = Math.round(ms / 1000); return s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'; };
    const slug = name => String(name).toLowerCase().replace(/[^a-z0-9]+/gu, '-');
    const parts = [];
    for (const [name, ms] of Object.entries(tl.buckets || {})) if (ms > 0) parts.push({ cls: 'tl-' + slug(name), stage: name, ms, reason: '' });
    for (const [name, ms] of Object.entries(tl.waits || {})) if (ms > 0) parts.push({ cls: 'tl-wait', stage: 'waiting', ms, reason: name });
    if (tl.unaccounted_ms > 0) parts.push({ cls: 'tl-unaccounted', stage: 'UNACCOUNTED', ms: tl.unaccounted_ms, reason: 'UNACCOUNTED' });
    let at = 0;
    const rects = parts.map(part => {
      const width = part.ms / tl.total_ms * W, x = at;
      at += width;
      const tip = part.stage + ' ' + span(part.ms) + (part.reason ? ' ' + part.reason : '');
      return '<rect class="tl-seg ' + part.cls + '"' + (part.reason === 'UNACCOUNTED' ? ' data-unaccounted="true"' : '') + ' data-stage="' + esc(part.stage) + '" data-ms="' + part.ms + '" x="' + x.toFixed(2) + '" y="0" width="' + width.toFixed(2) + '" height="10"><title>' + esc(tip) + '</title></rect>';
    }).join('');
    const gap = tl.longest_gap;
    const gapLabel = gap ? 'longest gap ' + span(gap.ms) + ' ' + gap.reason : 'no gap';
    const mark = tl.unaccounted_ms > 0 ? ' · ' + span(tl.unaccounted_ms) + ' UNACCOUNTED' : '';
    out += sec('Timeline', esc(span(tl.total_ms)) + mark + ' · ' + esc(gapLabel),
      '<div class="ip-card ip-tl item-timeline-strip"><svg class="tl-strip" viewBox="0 0 ' + W + ' 10" preserveAspectRatio="none" role="img" aria-label="Timeline of #' + hd.id + '"><rect class="tl-track" x="0" y="0" width="' + W + '" height="10"/>' + rects + '</svg>'
      + '<p class="tl-gap" data-gap="' + (gap ? esc(gap.reason) : '') + '">' + esc(gapLabel) + '</p></div>');
  }
  if (model.clauses.length) {
    out += sec('Done when', model.proven + ' of ' + model.clauses.length + ' proven',
      '<div class="ip-card">' + model.clauses.map(c => '<div class="ip-cl" data-item-clause role="button" tabindex="0" aria-expanded="false"><span class="n">' + c.n + '</span><span class="t">' + h.inline(c.text) + '</span>'
        + '<span class="k">' + esc(c.kind) + '</span><span class="pv ' + c.state + '" title="' + WORD[c.state] + '">' + icon(ICON[c.state]) + (c.state === 'no' ? '' : WORD[c.state]) + '</span><p class="ev">' + c.ev + '</p></div>').join('') + '</div>');
  }
  if (model.check) {
    const c = model.check;
    out += sec('Check', esc(c.cap), '<div class="ip-card"><div class="ip-row ip-fr" title="' + esc(c.command) + '">' + icon(ICON.test)
      + (c.path ? '<span class="p"><span class="dir">' + esc(c.path.slice(0, c.path.lastIndexOf('/') + 1)) + '</span>' + esc(c.path.slice(c.path.lastIndexOf('/') + 1)) + '</span>' : '<span class="p">' + esc(c.command) + '</span>') + '</div>'
      + (c.warn ? '<div class="ip-row ip-mo"><span>This check already passed before the work, so it proves nothing.</span></div>' : '') + '</div>');
  }
  if (model.brief) out += sec('Brief', '', '<div class="ip-card ip-bc item-panel-expand"><div class="ip-bt item-panel-brief item-panel-clamp">' + h.rich(model.brief) + '</div>' + (model.briefLong ? more(false) : '') + '</div>');
  // Typed fields and free related links (#1321): each only when the item carries some, so an item with neither draws exactly what it did [C7].
  if (model.fields.length) out += sec('Fields', String(model.fields.length), '<div class="ip-card item-panel-fields">' + model.fields.map(field => '<div class="ip-row ip-fld" data-field="' + esc(field.name) + '"><b>' + esc(field.name) + '</b><span class="ip-cap">' + esc(field.type) + '</span><span>' + esc(field.value) + '</span></div>').join('') + '</div>');
  if (model.links.length) out += sec('Related', String(model.links.length), '<div class="ip-card item-panel-related">' + model.links.map(link => '<div class="ip-row ip-rel" data-related="' + link.id + '">' + h.rich('#' + link.id) + (link.title ? ' <span>' + esc(link.title) + '</span>' : '') + '</div>').join('') + '</div>');
  if (model.files.length) {
    const shown = model.files.slice(0, 5), rest = model.files.length - shown.length;
    const tests = model.files.filter(path => /(?:^|\/)(?:tests?|journeys)\//u.test(path)).length;
    out += sec('Files', model.files.length + (tests ? ' · ' + tests + ' test' + (tests === 1 ? '' : 's') : ''), '<div class="ip-card item-panel-files">' + shown.map(path => {
      const slash = path.lastIndexOf('/'), testFile = /(?:^|\/)(?:tests?|journeys)\//u.test(path);
      return '<div class="ip-row ip-fr file item-file" data-file="' + esc(path) + '" title="' + esc(path) + '">' + icon(testFile ? ICON.test : ICON.file) + '<span class="p"><span class="dir">' + esc(slash < 0 ? '' : path.slice(0, slash + 1)) + '</span>' + esc(path.slice(slash + 1)) + '</span></div>';
    }).join('') + (rest ? '<details class="ip-rest"><summary class="ip-row ip-mo">' + rest + ' more</summary>' + model.files.slice(5).map(path => {
      const slash = path.lastIndexOf('/');
      return '<div class="ip-row ip-fr file item-file" data-file="' + esc(path) + '" title="' + esc(path) + '">' + icon(ICON.file) + '<span class="p"><span class="dir">' + esc(slash < 0 ? '' : path.slice(0, slash + 1)) + '</span>' + esc(path.slice(slash + 1)) + '</span></div>';
    }).join('') + '</details>' : '') + '</div>');
  }
  if (h.waits) out += sec('Blocked by', '', '<div class="ip-card"><div class="ip-row waits-on">' + h.waits + '</div></div>');
  if (h.refs) out += sec('Referenced code', '', '<div class="ip-card ip-bc">' + h.refs + '</div>');
  if (model.history.length) {
    const rows = model.history.slice(0, 6);
    out += '<section class="ip-sec item-panel-history" data-item-panel-panel="history"><div class="ip-shd"><p class="ip-lbl">History</p><span class="ip-cap">' + model.full + ' event' + (model.full === 1 ? '' : 's') + '</span>'
      + '<button class="link item-panel-history-more" type="button" data-item-panel-history data-count="' + model.full + '" aria-expanded="' + model.historyOpen + '">' + (model.historyOpen ? 'Less' : 'All ›') + '</button></div>'
      + '<div class="ip-card item-panel-history-list' + (model.historyOpen ? ' expanded' : '') + '"><div class="ip-hrs">'
      + rows.map(row => '<div class="ip-hr" title="' + esc(row.full) + '"><span class="tm">' + esc(row.t) + '</span><span class="ip-chip ' + row.tone + '">' + esc(row.chip) + '</span><span class="tx">' + row.text + '</span></div>').join('')
      + '</div><div class="ip-full">' + (h.verdicts || '') + h.timeline + '</div></div></section>';
  }
  return header + out;
}
