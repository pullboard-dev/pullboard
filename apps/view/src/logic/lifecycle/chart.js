/** Draw the approved lifecycle in plain words from the board's replayed move counts [N26].
 * Standalone because the live and exported pages embed this renderer's source.
 */
export function lifecycleChart(project, moves, sentBack) {
  const esc = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const number = value => Number(value).toLocaleString('en-US');
  const made = (from, to, verbs) => verbs.reduce((sum, verb) => sum + (moves.get(from + '>' + to + ':' + verb) || 0), 0);
  const tip = (value, meaning) => '<span title="' + esc(meaning) + '">' + number(value) + '</span>';
  const states = [
    ['open', 'Ready', sentBack + ' of them sent back', 'Items ready for an agent to take, including items sent back.'],
    ['claimed', 'Building', 'one agent each', 'Items taken by one agent to build.'],
    ['submitted', 'In review', 'a different agent checks', 'Submitted items waiting for an independent review.'],
    ['verified', 'Verified', 'passed review', 'Items that passed independent review, including landed items.'],
  ];
  const text = (x, y, words, cls, anchor = 'start') => '<text class="' + cls + '" x="' + x + '" y="' + y + '" text-anchor="' + anchor + '">' + esc(words) + '</text>';
  const stage = ([state, label, sub, meaning], index) => {
    const x = 10 + index * 250;
    const count = project.items.filter(item => item.status === state).length;
    return '<g class="s-' + state + '" data-lifecycle-stage="' + state + '"><title>' + esc(meaning) + '</title><rect class="box" x="' + x + '" y="80" width="180" height="96" rx="8"/>'
      + text(x + 16, 106, label, 'name') + text(x + 16, 142, number(count), 'n') + text(x + 16, 162, sub, 'sub') + '</g>';
  };
  const route = (from, to, verbs, words, d, x, y, back = false) => {
    const total = made(from, to, verbs);
    return '<g data-lifecycle-route="' + from + '>' + to + '"><title>' + esc(words + ': ' + number(total) + ' moves. ' + verbs.map(verb => number(made(from, to, [verb])) + ' ' + ({ claim: 'taken to build', submit: 'submitted for review', accept: 'passed independent review', release: 'let go', lapse: 'went idle', escalate: 'moved to a stronger agent', refreeze: 'check re-frozen', reject: 'rejected by a reviewer', reopen: 'reopened' }[verb])).join('; ')) + '</title>'
      + '<path class="edge' + (back ? ' back' : '') + '" d="' + d + '" marker-end="url(#lifecycle-' + (back ? 'back' : 'forward') + ')"/>'
      + text(x, y, number(total) + ' ' + words, 'tag' + (back ? ' back masked' : ''), 'middle') + '</g>';
  };
  const forward = [
    ['open', 'claimed', ['claim'], 'taken', 'M192 128H256', 224, 70],
    ['claimed', 'submitted', ['submit'], 'submitted', 'M442 128H506', 474, 70],
    ['submitted', 'verified', ['accept'], 'passed', 'M692 128H756', 724, 70],
  ];
  const backward = [
    ['claimed', 'open', ['release', 'lapse', 'escalate', 'refreeze'], 'handed back', 'M350 178V222H100V182', 225, 226],
    ['submitted', 'open', ['reject', 'reopen', 'refreeze'], 'sent back by a reviewer', 'M600 178V264H84V182', 342, 268],
    ['verified', 'open', ['reject', 'reopen', 'refreeze'], 'reopened after passing', 'M850 178V306H68V182', 456, 310],
  ];
  const marker = (id, back) => '<marker id="lifecycle-' + id + '"' + (back ? ' class="back"' : '') + ' viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>';
  const withdrawn = project.items.filter(item => item.status === 'withdrawn').length;
  const svg = '<svg viewBox="0 0 950 322" role="img" aria-label="How work moves, with counts from this board"><defs>' + marker('forward', false) + marker('back', true) + '</defs>'
    + states.map(stage).join('') + forward.map(args => route(...args)).join('') + backward.map(args => route(...args, true)).join('')
    + '<g class="s-withdrawn"><title>Items withdrawn from the board.</title><rect class="box withdrawn" x="10" y="6" width="150" height="44" rx="8"/>' + text(24, 33, 'Withdrawn', 'name') + text(146, 33, number(withdrawn), 'tag', 'end') + '</g></svg>';
  const parts = (from, verbs) => verbs.map(([verb, meaning]) => tip(made(from, 'open', [verb]), meaning) + ' ' + meaning).join(' · ');
  const handedBack = parts('claimed', [['release', 'let go'], ['refreeze', 'check re-frozen'], ['lapse', 'went idle'], ['escalate', 'moved to a stronger agent']]);
  const reviewedBack = parts('submitted', [['reject', 'rejected'], ['reopen', 'reopened'], ['refreeze', 'check re-frozen']]);
  const kept = [
    ['submitted', 'reserve', 'reviews started'], ['claimed', 'claim', 'claimed again while building'],
    ['claimed', 'patch-claimed', 'updated while building'],
    ['open', 'refreeze', 'checks re-frozen while ready'], ['claimed', 'refreeze', 'checks re-frozen while building'], ['open', 'release', 'let go while ready'],
    ['open', 'escalate', 'moved to a stronger agent while ready'], ['verified', 'accept', 'passed again'],
  ].map(([state, verb, meaning]) => tip(made(state, state, [verb]), meaning) + ' ' + meaning).join(' · ');
  const rareNames = { rehomeImport: 'imported with an existing review', 'submit-merge': 'submitted and passed together', intake: 'brought in for review', patch: 'updated after submission' };
  const rare = [...moves].filter(([key]) => Object.keys(rareNames).some(verb => key.endsWith(':' + verb)));
  const rareCount = rare.reduce((total, [, value]) => total + value, 0);
  const rareRows = rare.map(([key, value]) => {
    const [pair, verb] = key.split(':');
    const labels = { open: 'Ready', claimed: 'Building', submitted: 'In review', verified: 'Verified', withdrawn: 'Withdrawn' };
    const [from, to] = pair.split('>');
    return '<li>' + tip(value, rareNames[verb]) + ' ' + esc(rareNames[verb]) + ': ' + esc(labels[from] || 'another stage') + ' to ' + esc(labels[to] || 'another stage') + '</li>';
  }).join('');
  return svg + '<div class="lifecycle-notes"><p class="lifecycle-returns">Handed back: ' + handedBack + '. Sent back: ' + reviewedBack + '.</p><p>Moves that keep an item where it is: ' + kept + '.</p>'
    + '<details class="lifecycle-rare"><summary>' + number(rareCount) + ' rare routes</summary>' + (rareRows ? '<ul>' + rareRows + '</ul>' : '<p>No rare routes yet.</p>') + '</details></div>';
}
