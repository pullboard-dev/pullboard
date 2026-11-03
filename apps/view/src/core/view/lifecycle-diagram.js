/** Render the declared lifecycle and supplied counts as SVG without replay or browser state [N26,M1,C7].
 * Standalone so live/export pages and data-only tests use exactly the same layout implementation.
 */
export function lifecycleDiagramHtml(p, FLOW, counts) {
  /** Escape the declaration's text at its SVG boundary. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** Format a move total without consulting a clock or browser locale. */
  const count = (n, one, many = one) => n + ' ' + (n === 1 ? one : many);
  /** Preserve the live page's distinction between a return and work already in progress. */
  const stateOf = i => i.status === 'claimed' ? 'building' : i.status === 'submitted' ? 'verify' : i.status === 'verified' ? 'verified' : i.status === 'withdrawn' ? 'withdrawn' : i.verdict && i.verdict.decision === 'REJECT' ? 'back' : 'open';
  const finals = FLOW.states.filter((s) => s.final).map((s) => s.id);
  /** List outgoing state changes without duplicating self loops. */
  const leads = (s) => FLOW.moves.filter((m) => m.from.includes(s) && m.to !== s).map((m) => m.to);
  let row = [];
  /** Choose the longest declared route, retaining declaration order for ties. */
  const walk = (trail) => {
    const at = trail[trail.length - 1];
    if (finals.includes(at)) {
      if (trail.length > row.length || (trail.length === row.length && finals.indexOf(at) < finals.indexOf(row[row.length - 1]))) row = trail;
      return;
    }
    for (const next of new Set(leads(at))) if (!trail.includes(next)) walk([...trail, next]);
  };
  walk([FLOW.initial]);
  const W = 880, L = 20, BW = 160, step = (W - 2 * L - BW) / Math.max(row.length - 1, 1);
  /** Keep generated SVG coordinates bounded to one decimal place. */
  const f = (v) => String(Math.round(v * 10) / 10);
  /** Locate a state on the chosen main route. */
  const col = (s) => row.indexOf(s);
  const pairs = [];
  for (const m of FLOW.moves) for (const from of m.from) {
    let pair = pairs.find((e) => e.from === from && e.to === m.to);
    if (!pair) pairs.push((pair = { from, to: m.to, moves: [] }));
    pair.moves.push(m);
  }
  /** Read one exact transition count supplied by the replay model. */
  const made = (pair, m) => counts.get(pair.from + '>' + pair.to + ':' + m.verb) || 0;
  /** Describe each transition and its guards for accessible SVG titles. */
  const says = (pair) => pair.moves.map((m) => m.verb + ', ' + pair.from + ' to ' + pair.to + ', by the ' + m.by.join(' or ') + ': ' + m.how + '. Made ' + count(made(pair, m), 'time', 'times') + (m.checks.length ? '.\nChecks, in order:\n' + m.checks.map((c) => '  ' + c).join('\n') : '.')).join('\n\n');
  // What some pairs' moves come to: each verb with how often it was made, or every verb when none was.
  /** Group actual counts by verb while retaining unused declared routes. */
  const told = (list) => {
    const sums = new Map();
    for (const pair of list) for (const m of pair.moves) sums.set(m.verb, (sums.get(m.verb) || 0) + made(pair, m));
    const done = [...sums].filter(([, n]) => n);
    return { words: done.length ? done.map(([verb, n]) => verb + ' ' + n) : [...sums.keys()], idle: !done.length };
  };
  // A generous width for words at a size, and words joined by dots into the fewest even lines that
  // fit a room, as the README's figure splits them.
  /** Estimate text width using the same fixed layout rule as the live page. */
  const wide = (words, size) => words.length * size * 0.56;
  /** Fit complete move labels into the available SVG room. */
  const wrap = (words, room, size) => {
    for (let n = 1; ; n += 1) {
      const per = Math.ceil(words.length / n), lines = [];
      for (let i = 0; i < words.length; i += per) lines.push(words.slice(i, i + per).join(' · '));
      if (per === 1 || lines.every((line) => wide(line, size) <= room)) return lines;
    }
  };
  /** Escape and position one SVG text label. */
  const text = (x, y, words, cls, anchor = 'middle') => '<text class="' + cls + '" x="' + f(x) + '" y="' + f(y) + '" text-anchor="' + anchor + '">' + esc(words) + '</text>';
  /** Stack wrapped labels above their route. */
  const lines = (x, y, said, cls, anchor) => said.map((line, i) => text(x, y - 15 * (said.length - 1 - i), line, cls, anchor)).join('');
  /** Serialize route coordinates without browser geometry. */
  const path = (points) => 'M' + points.map(([x, y]) => f(x) + ' ' + f(y)).join('L');

  // Inside each box: its name and count, then the moves that keep it, then any items sent back.
  const back = p.items.filter((i) => stateOf(i) === 'back').length;
  const inside = new Map(FLOW.states.map((s) => {
    const keeps = pairs.find((pair) => pair.from === s.id && pair.to === s.id);
    const said = keeps ? told([keeps]) : null;
    // A wrapped line opens with the dot it was split at, so the moves still read as one list (#954).
    const kept = said ? wrap(said.words, BW - 28 - wide('↻ ', 11), 11).map((line, i) => (i ? '· ' : '↻ ') + line) : [];
    return [s.id, { keeps, said, kept, back: s.id === FLOW.initial && back ? back + ' sent back' : '' }];
  }));
  const BH = 44 + 15 * Math.max(1, ...[...inside.values()].map((box) => box.kept.length + (box.back ? 1 : 0)));

  // Routes back along the row, each at a level by how far back it goes; their words above them.
  const ups = pairs.filter((pair) => col(pair.to) >= 0 && col(pair.from) > col(pair.to))
    .map((pair) => ({ pair, span: Math.abs(col(pair.from) - col(pair.to)) })).sort((a, b) => a.span - b.span);
  const spans = [...new Set(ups.map((up) => up.span))];
  for (const up of ups) {
    up.level = spans.indexOf(up.span);
    const a = L + BW / 2 + col(up.pair.from) * step, b = L + BW / 2 + col(up.pair.to) * step;
    /** Count narrower incoming or outgoing routes to keep stems distinct. */
    const before = (key, value) => ups.filter((other) => other !== up && other.pair[key] === value && other.span < up.span).length;
    up.start = a + (a > b ? 16 : -16) + (a > b ? 26 : -26) * before('from', up.pair.from);
    up.end = b + (a > b ? BW / 2 - 40 : 40 - BW / 2) + (a > b ? -30 : 30) * before('to', up.pair.to);
    up.said = told([up.pair]);
    up.lines = wrap(up.said.words, Math.abs(up.start - up.end) - 20, 12);
  }
  // Higher routes cross this level vertically; put its words in the widest gap between them.
  for (const up of ups) {
    const left = Math.min(up.start, up.end), right = Math.max(up.start, up.end);
    const cuts = [left, ...ups.filter((other) => other.span > up.span).flatMap((other) => [other.start, other.end]).filter((x) => x > left && x < right), right].sort((a, b) => a - b);
    const rooms = cuts.slice(1).map((end, index) => ({ left: cuts[index], right: end })).sort((a, b) => (b.right - b.left) - (a.right - a.left));
    const room = rooms[0];
    up.labelX = (room.left + room.right) / 2;
    up.lines = wrap(up.said.words, room.right - room.left - 20, 12);
  }
  // Each level stands clear of the words of the level below it.
  const rise = [];
  for (const level of spans.keys()) {
    const below = ups.filter((up) => up.level === level - 1);
    rise[level] = level ? rise[level - 1] + 18 + 15 * Math.max(...below.map((up) => up.lines.length)) : 30;
  }
  const highest = ups.length ? Math.max(...ups.map((up) => rise[up.level] + 21 + 15 * (up.lines.length - 1))) : 0;
  const top = 12 + highest, Y = top + BH / 2, bottom = top + BH;
  const pos = new Map(row.map((s, i) => [s, { x: L + BW / 2 + i * step, y: Y }]));

  // A forward shortcut gets its own lower lane. Keep its words between the vertical stems of
  // deeper shortcuts and routes into off-row states, rather than at a fixed diagram coordinate.
  const shortcuts = pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) > col(pair.from) + 1)
    .map((pair) => ({ pair, span: col(pair.to) - col(pair.from),
      start: pos.get(pair.from).x + BW / 2 - 40, end: pos.get(pair.to).x - BW / 2 + 40 }))
    .sort((a, b) => a.span - b.span);
  const downwardStems = pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) < 0)
    .map((pair) => pos.get(pair.from).x);
  shortcuts.forEach((shortcut, index) => {
    const cuts = [shortcut.start, ...downwardStems,
      ...shortcuts.slice(index + 1).flatMap((other) => [other.start, other.end]), shortcut.end]
      .filter((x) => x >= shortcut.start && x <= shortcut.end).sort((a, b) => a - b);
    const rooms = cuts.slice(1).map((right, i) => ({ left: cuts[i], right }))
      .sort((a, b) => (b.right - b.left) - (a.right - a.left));
    const room = rooms[0];
    shortcut.said = told([shortcut.pair]);
    shortcut.lines = wrap(shortcut.said.words, room.right - room.left - 20, 12);
    shortcut.labelX = (room.left + room.right) / 2;
    shortcut.depth = (index ? shortcuts[index - 1].depth + 24 : 30) + 15 * (shortcut.lines.length - 1);
  });
  const shortcutDepth = shortcuts.length ? shortcuts[shortcuts.length - 1].depth : 0;
  // A straight incoming route labels the midpoint of this gap: its words must also sit below
  // every shortcut, not just place the off-row boxes below them.
  const lowerGap = Math.max(80, 2 * shortcutDepth + 32);

  // A state off the row sits below the last state on it that leads there.
  const below = FLOW.states.filter((s) => !pos.has(s.id));
  for (const s of below) {
    const from = row.filter((r) => leads(r).includes(s.id));
    pos.set(s.id, { x: from.length ? pos.get(from[from.length - 1]).x : W / 2, y: bottom + lowerGap + BH / 2 });
  }
  const outgoing = pairs.filter((pair) => pair.from !== pair.to && below.some((state) => state.id === pair.from));
  const H = (below.length ? bottom + lowerGap + BH : bottom + shortcutDepth) + 14 + (outgoing.length ? 44 + 40 * (outgoing.length - 1) : 0);

  /** Draw each route with its own declaration title and one shared label. */
  const group = (pairList, route, label) => pairList.map((pair, n) => '<g><title>' + esc(says(pair)) + '</title><path class="edge' + (route.back ? ' back' : '') + '" d="' + route.d + '" marker-end="url(#pb-head' + (route.back ? '-back' : '') + ')"/>' + (n === 0 ? label : '') + '</g>').join('');
  /** Distinguish unused and return routes without changing their counts. */
  const tone = (said, extra = '') => 'tag' + (said.idle ? ' idle' : '') + extra;
  const routes = [];
  // Straight along the row.
  for (const pair of pairs.filter((pair) => col(pair.from) >= 0 && col(pair.to) === col(pair.from) + 1)) {
    const a = pos.get(pair.from), b = pos.get(pair.to), said = told([pair]);
    const words = said.words.join(' · ');
    // A long label sits above the boxes when the gap cannot hold it with clearance.
    const labelY = wide(words, 12) + 8 > b.x - a.x - BW ? top - 8 : Y - 8;
    routes.push(group([pair], { d: path([[a.x + BW / 2, Y], [b.x - BW / 2 - 1, Y]]) }, text((a.x + b.x) / 2, labelY, words, tone(said))));
  }
  // Square, above the row.
  for (const up of ups) {
    const isBack = col(up.pair.to) < col(up.pair.from), y = top - rise[up.level];
    routes.push(group([up.pair], { back: isBack, d: path([[up.start, top], [up.start, y], [up.end, y], [up.end, top - 1]]) }, lines(up.labelX, y - 7, up.lines, tone(up.said, isBack ? ' back' : ''))));
  }
  // Square, below the row, for moves that skip forward past another state.
  for (const shortcut of shortcuts) {
    const y = bottom + shortcut.depth;
    routes.push(group([shortcut.pair], { d: path([[shortcut.start, bottom], [shortcut.start, y], [shortcut.end, y], [shortcut.end, bottom + 1]]) },
      lines(shortcut.labelX, y - 7, shortcut.lines, tone(shortcut.said))));
  }
  // Down from the row, joining into one route per state below, labelled once on the way in.
  for (const s of below) {
    const t = pos.get(s.id), into = pairs.filter((pair) => pair.to === s.id && col(pair.from) >= 0);
    const said = told(into), tTop = t.y - BH / 2;
    // A new import-only route cannot carry the existing ordinary moves' shared label.
    const ordinary = into.filter((pair) => pair.moves.some((move) => move.verb !== 'rehomeImport'));
    const carriers = ordinary.length ? ordinary : into;
    const xs = carriers.map((pair) => pos.get(pair.from).x).sort((a, b) => a - b);
    const left = xs.filter((x) => x < t.x - 0.5), right = xs.filter((x) => x > t.x + 0.5);
    const label = left.length
      ? lines((left[0] + (left[1] ?? t.x - BW / 2)) / 2, t.y - 8, wrap(said.words, (left[1] ?? t.x - BW / 2) - left[0] - 20, 12), tone(said))
      : right.length
        ? lines((right[right.length - 1] + (right[right.length - 2] ?? t.x + BW / 2)) / 2, t.y - 8, wrap(said.words, right[right.length - 1] - (right[right.length - 2] ?? t.x + BW / 2) - 20, 12), tone(said))
        : lines(t.x + 10, (bottom + tTop) / 2 + 4, said.words, tone(said), 'start');
    // Keep path order intact, but bind the label to its ordinary route family before placement.
    const order = [...into].sort((p1, p2) => Math.abs(pos.get(p2.from).x - t.x) - Math.abs(pos.get(p1.from).x - t.x));
    const carrier = order.find((pair) => carriers.includes(pair));
    order.forEach((pair) => {
      const a = pos.get(pair.from);
      const d = Math.abs(a.x - t.x) < 0.5 ? path([[a.x, bottom], [t.x, tTop - 1]]) : path([[a.x, bottom], [a.x, t.y], [a.x < t.x ? t.x - BW / 2 - 1 : t.x + BW / 2 + 1, t.y]]);
      routes.push(group([pair], { d }, pair === carrier ? label : ''));
    });
  }
  // A below-row state can move back into the row or on to another below-row state.
  outgoing.forEach((pair, index) => {
    const from = pos.get(pair.from), to = pos.get(pair.to);
    const lane = bottom + lowerGap + BH + 26 + index * 40;
    const side = to.x < from.x ? to.x + BW / 2 + 1 : to.x - BW / 2 - 1;
    const said = told([pair]);
    const room = Math.max(40, Math.abs(side - from.x) - 24);
    const label = lines((from.x + side) / 2, lane - 8, wrap(said.words, room, 12), tone(said));
    routes.push(group([pair], { d: path([[from.x, from.y + BH / 2], [from.x, lane], [side, lane], [side, to.y]]) }, label));
  });

  const boxes = FLOW.states.map((s) => {
    const { x, y } = pos.get(s.id), box = inside.get(s.id), left = x - BW / 2, boxTop = y - BH / 2;
    const tip = s.id + ': ' + s.means + (s.entry.length ? '.\nEvery way in checks:\n' + s.entry.map((r) => '  ' + r).join('\n') : '.');
    const keeps = box.kept.length ? '<g><title>' + esc(says(box.keeps)) + '</title>' + box.kept.map((line, i) => text(left + 14, boxTop + 47 + 15 * i, line, 'keep' + (box.said.idle ? ' idle' : ''), 'start')).join('') + '</g>' : '';
    return '<g class="s-' + esc(s.id) + '"><title>' + esc(tip) + '</title><rect class="box" x="' + f(left) + '" y="' + f(boxTop) + '" width="' + BW + '" height="' + BH + '" rx="10"/>'
      + (s.final ? '<rect class="box inner" x="' + f(left + 4) + '" y="' + f(boxTop + 4) + '" width="' + (BW - 8) + '" height="' + (BH - 8) + '" rx="7"/>' : '')
      + text(left + 14, boxTop + 25, s.id, 'name', 'start') + text(x + BW / 2 - 14, boxTop + 29, String(p.items.filter((i) => i.status === s.id).length), 'n', 'end')
      + keeps + (box.back ? text(left + 14, boxTop + 47 + 15 * box.kept.length, box.back, 'sub', 'start') : '') + '</g>';
  });
  /** Render one reusable direction marker. */
  const head = (id, cls) => '<marker id="' + id + '" class="' + cls + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>';
  return '<svg viewBox="0 0 ' + W + ' ' + f(H) + '" role="img" aria-label="The item lifecycle, with counts from this board"><defs>' + head('pb-head', '') + head('pb-head-back', 'back') + '</defs>' + routes.join('') + boxes.join('') + '</svg>';
}
