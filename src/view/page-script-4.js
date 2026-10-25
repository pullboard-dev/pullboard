/**
 * Part 4 of the hosted page's script, verbatim from src/cockpit.js lines 2886-3996 (#745): its
 * text is what the page served before the split, with the values its ${} expressions read passed in as scope.
 *
 * @param {Record<string, any>} scope - The values cockpitPage passes for the names this part interpolates.
 * @returns {string} The script text of this part.
 */
export function pageScriptPart4(scope) {
return `function showFlow(shown) {
  keep('pb.flow', shown ? 'shown' : 'hidden');
  $('flow-panel').hidden = !shown;
  $('flow-show').hidden = shown;
  if (shown && data && data.project) $('flow').innerHTML = flowSvg(data.project);
}

function showTab() {
  document.querySelectorAll('[data-pane]').forEach((pane) => { pane.hidden = pane.dataset.pane !== view.tab; });
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('on', button.dataset.tab === view.tab));
  countUnseen();
  if (view.tab === 'shouts') foldShouts();
  if (view.tab === 'settings') void showSettings();
}

/** Read the selected repo, tab and detail from a path or the hosted page's fragment. */
function placeAtAddress(page = data) {
  const tabs = ['home', 'items', 'shouts', 'spec', 'doctrine', 'activity', 'roadmap', 'settings'];
  const hash = location.hash || '';
  let path = routed ? location.pathname || '/' : hash.slice(1);
  if (hash === '#items/pipeline' || hash === '#roadmap') path = hash.slice(1);
  if (hash.startsWith('#shout-')) path = 'shouts/' + hash.slice(7);
  let parts;
  try { parts = path.split('/').filter(Boolean).map(decodeURIComponent); }
  catch { parts = []; }
  const repo = page?.projects.find((entry) => entry.ok && entry.name === parts[0]);
  const group = page?.groups.find((entry) => entry.name === parts[0]);
  const named = (repo || group) && tabs.includes(parts[1]);
  const root = named ? repo?.root || group.key : null;
  if (named) parts.shift();
  const tab = tabs.includes(parts[0]) ? parts.shift() : (!path && transportModule && globalThis.history?.state?.tab) || homeTab(page);
  return { root, tab, detail: parts[0] ?? null };
}

/** Name each repo even beneath a group; one repo needs no prefix. */
function tabHref(tab) {
  if (snapshot) {
    const detail = tab === 'items' && view.itemsView === 'pipeline' ? 'pipeline' : view.addressDetail;
    if (tab === 'items' && detail === null && !location.hash) return location.pathname + location.search;
    return location.pathname + location.search + '#' + tab + (detail === null ? '' : '/' + encodeURIComponent(String(detail)));
  }
  const repo = data?.projects.find((entry) => entry.root === view.root);
  const group = data?.groups.find((entry) => entry.key === view.root);
  const name = repo?.name || group?.name;
  const prefix = (data?.projects.filter((entry) => entry.ok).length || 0) > 1 && name ? '/' + encodeURIComponent(name) : '';
  const detail = tab === 'items' && view.itemsView === 'pipeline' && (view.addressDetail === null || view.addressDetail === 'pipeline') ? 'pipeline' : view.addressDetail;
  const path = prefix + '/' + tab + (detail === null ? '' : '/' + encodeURIComponent(String(detail)));
  return routed ? path + location.search : location.pathname + location.search + '#' + path.slice(1);
}

/** Push one entry per changed place, and retain native fact anchors when restoring an entry. */
function address(push = true) {
  if (typeof history === 'undefined' || typeof location === 'undefined' || !addressReady) return;
  const state = { tab: view.tab, root: view.root, item: view.item, itemsView: view.itemsView, detail: view.addressDetail };
  let href = tabHref(view.tab);
  if (!push && routed && location.hash && !['#roadmap', '#items/pipeline'].includes(location.hash)) href += location.hash;
  try {
    if (push && href !== location.pathname + location.search + (location.hash || '')) history.pushState(state, '', href);
    else if (transportModule && !location.hash && view.tab === 'items' && view.addressDetail === null) history.replaceState(state, '');
    else history.replaceState(state, '', href);
  } catch { /* A host that refuses history changes still shows the selected place. */ }
}

/** Apply a parsed selection without recording another history entry. */
function applyPlace(place, kept = null) {
  if (place.root) view.root = place.root;
  view.tab = place.tab;
  view.addressDetail = place.detail;
  view.item = place.tab === 'items' && place.detail !== null && place.detail !== 'pipeline' ? Number(place.detail) : null;
  view.itemsView = place.tab === 'items' && place.detail === 'pipeline' ? 'pipeline' : 'list';
  if (place.tab === 'items' && kept?.root === view.root && kept.tab === place.tab && kept.detail === place.detail && kept.itemsView === 'pipeline') view.itemsView = 'pipeline';
  view.shout = place.tab === 'shouts' && place.detail !== null ? Number(place.detail) : null;
  view.agent = null;
  view.unread = null;
  view.roadmapOnly = null;
  if (place.tab === 'spec' || place.tab === 'doctrine') {
    view.row[place.tab] = place.detail;
    if (place.detail !== null) view.rows[place.tab] = 'all';
  }
  view.scrollPlace = place.detail !== null;
  keep('pb.project', view.root);
  if (place.tab !== 'roadmap') keep('pb.tab', place.tab);
}

/** Restore the address on Back and Forward, with a scoped refresh when the repo changes. */
function fromAddress(event) {
  if (!data) return;
  // Back and Forward close Approve all's confirmation and the decline dialog without recording, wherever they lead.
  leaveDialogs();
  // The configured relay transport owns pairing fragments and removes their secrets itself.
  if (transportModule) {
    const pairing = new URLSearchParams((location.hash || '').slice(1));
    if (['board', 'key', 'device'].some((name) => pairing.has(name))) return;
  }
  if (snapshot) {
    const kept = event?.state || {};
    const place = location.hash ? placeAtAddress() : { root: null, tab: kept.tab || homeTab(data), detail: kept.detail ?? null };
    applyPlace(place, kept);
    if (kept.root && kept.root !== view.root) return switchTo(kept.root, view.item, false);
  } else {
    const place = placeAtAddress();
    // A native timeline anchor keeps its existing DOM target and the browser's own scroll.
    if ((location.hash || '').startsWith('#fact-') && place.tab === 'items' && (!place.root || place.root === view.root) && (place.detail === null || Number(place.detail) === view.item)) { address(false); return; }
    const previous = view.root;
    applyPlace(place, event?.state);
    if (previous !== view.root) return switchTo(view.root, view.item, false);
  }
  address(false);
  render();
  void loadAddressedShout();
}

/** Pick a tab or an explicit detail and record the complete place once. */
function openTab(tab, detail = null) {
  view.tab = tab;
  view.addressDetail = detail;
  view.shout = tab === 'shouts' && detail !== null ? Number(detail) : null;
  view.scrollPlace = detail !== null;
  if (tab !== 'roadmap') keep('pb.tab', tab);
  address();
}

/** Fetch one old shout through the same public read API used by local and relay views. */
async function loadAddressedShout() {
  if (!data?.project || view.tab !== 'shouts' || view.shout === null || data.root !== view.root) return;
  const root = view.root, id = view.shout, key = JSON.stringify([root, id]);
  if (data.project.shouts.some((entry) => entry.shout_id === id) || addressedShouts.has(key)) return;
  const entry = { shout: null, error: null };
  addressedShouts.set(key, entry);
  try {
    const reply = await api(boardPath(root) + '/shouts/' + encodeURIComponent(String(id)));
    entry.shout = reply.shout;
  } catch (error) {
    const message = String(error.message || error);
    entry.error = relayProject(root) && !message.includes('NO_SHOUT')
      ? 'This shout is older than the relay holds. Open its address in the local project view.'
      : 'No shout #' + id + ' exists here. ' + message;
  }
  if (view.root === root && view.shout === id && view.tab === 'shouts') render();
}

/** Scroll a newly addressed detail once, after its real content has arrived. */
function revealPlace() {
  if (!view.scrollPlace) return;
  const fact = view.tab === 'items' && (location.hash || '').startsWith('#fact-') ? $(location.hash.slice(1)) : null;
  const element = fact || (view.tab === 'shouts' ? $('shout-' + view.shout)
    : view.tab === 'items' ? $('detail')
      : ['spec', 'doctrine'].includes(view.tab) ? $(view.tab + '-detail') : null);
  if (!element || (view.tab === 'shouts' && !element.querySelector('h2'))) return;
  element.scrollIntoView({ block: 'center', behavior: 'instant' });
  view.scrollPlace = false;
}

/**
 * Count on the Shouts tab the shouts that came after the newest one the person has seen in this
 * project. Seeing means having the Shouts tab open with the board drawn; a project shown for the
 * first time has seen everything so far. The mark is kept in this browser, so a reload counts
 * nothing old. The board counts the shouts since the mark the last refresh sent, so a burst larger
 * than the forty loaded still counts in full; until a moved mark reaches the board, the loaded
 * shouts count, which is exact then since the mark only ever moves to the newest.
 */
function countUnseen() {
  const p = data && data.project;
  // While a switch loads, the board on hand is the last project's: it marks nothing for this one.
  if (!p || data.root !== view.root) return;
  const key = 'pb.seen.' + view.root;
  const kept = view.seen[key] ?? keep(key);
  const newest = p.shouts.length ? p.shouts[0].shout_id : 0;
  const seen = view.tab === 'shouts' || kept === null || kept === undefined ? newest : Number(kept);
  if (String(seen) !== String(kept)) { view.seen[key] = seen; keep(key, String(seen)); }
  const unread = (p.unseen && p.unseen.since === seen ? p.unseen.count : p.shouts.filter((x) => x.shout_id > seen).length) || 0;
  const slot = $('status-unread');
  if (slot) { slot.innerHTML = '<b>' + unread + '</b> unread'; slot.hidden = !unread; }
}

/** A quiet line that opens what it counts: what it says, everything it holds on hover, and show or hide. */
function foldLine(name, text, names) {
  return '<button class="fold-line" data-fold="' + name + '" type="button" aria-expanded="' + Boolean(view.open[name]) + '" title="' + esc(names) + '"><span>' + esc(text) + '</span><span class="fold-more">' + (view.open[name] ? 'hide' : 'show') + '</span></button>';
}

/**
 * Address the composer: the coordinator unless someone else is named, who then shows as a chip the person can clear.
 */
function addressTo(to) {
  const who = to || 'coordinator';
  $('shout-to').value = who;
  $('shout-to-chip').hidden = who === 'coordinator';
  $('shout-to-chip').innerHTML = who === 'coordinator' ? '' : 'to <b>' + esc(agentName(who)) + '</b><button class="to-clear" data-to-clear type="button" aria-label="Shout to the coordinator instead">×</button>';
  $('shout-text').placeholder = 'Shout to ' + (who === 'coordinator' ? 'the coordinator' : agentName(who));
}

/**
 * Put the shout form in answer mode for an open decision (B21), or back to a plain shout with null.
 * The form is never redrawn, so what the person types survives every refresh; only its answer line,
 * its To and its button change. The To the person had comes back when the answer is done. An answer
 * belongs to the project whose question it shows: leaving that project leaves answer mode.
 */
function answer(id, ordinary = false) {
  const ask = id === null ? null : (ordinary ? data.project.decisionQueue || [] : data.project.decisions).find((d) => d.shout_id === id) || null;
  if (ask && !view.answering) view.to = $('shout-to').value;
  if (!ask && view.answering) addressTo(view.to);
  view.answering = ask ? { root: view.root, id: ask.shout_id, ordinary } : null;
  $('answering').hidden = !ask;
  $('answering-who').textContent = ask ? agentName(ask.shout_from) : '';
  const question = ask ? linked(ask.shout_text, new Map(data.project.items.map((i) => [String(i.id), i.title]))) : '';
  if (question.includes('<a class="ref"')) $('answering-q').innerHTML = question;
  else $('answering-q').textContent = ask ? ask.shout_text : '';
  if (ask) addressTo(ask.shout_from);
  $('shout-to').disabled = Boolean(ask);
  $('shout-to-chip').hidden = Boolean(ask) || $('shout-to').value === 'coordinator';
  const verb = ask ? 'Answer' : 'Shout';
  $('shout-send').setAttribute('aria-label', verb);
  $('shout-send').title = verb + ' (Enter; Shift+Enter for a new line)';
  if (ask) $('shout-text').focus();
}

/** Open what a status-bar part counts: its tab, narrowed to exactly those. */
function statusGo(to) {
  view.unread = null;
  view.roadmapOnly = null;
  if (to.startsWith('item:')) return go(to);
  if (to === 'items') { view.state = 'active'; view.lane = null; view.before = null; $('q').value = ''; openTab('items'); }
  else if (to === 'verify' || to === 'gated') { view.state = to; view.lane = null; view.before = null; $('q').value = ''; openTab('items'); }
  else if (to === 'unread') {
    // Only the shouts after the mark the person had; opening Shouts then moves the mark past them.
    const key = 'pb.seen.' + view.root;
    view.unread = { root: view.root, after: Number(view.seen[key] ?? keep(key) ?? 0) };
    view.agent = null;
    openTab('shouts');
  }
  // The agents it counts are the panel's rows, so it opens the panel even where the person hid it.
  else if (to === 'agents') { view.agentsHidden = false; keep('pb.agents', 'shown'); view.agent = null; openTab('shouts'); }
  // The release it counts is one milestone, so the Roadmap opens on that one alone.
  else if (to === 'release') { view.roadmapOnly = nextMilestone(data.project)?.name ?? null; openTab('roadmap'); }
  else openTab(to);
  showTab();
  render();
}

/**
 * Follow a link in the page: an item, a spec row, a tab or a decision to answer. An item can live on
 * another project's board, root, which the page then switches to.
 */
function go(target, root = view.root) {
  const [kind, id] = target.split(':');
  let tab = view.tab;
  if (kind === 'item') { tab = 'items'; view.state = 'all'; view.before = null; }
  else if (kind === 'spec') { tab = 'spec'; view.row.spec = id; view.rows.spec = 'all'; }
  else if (kind === 'doctrine') { tab = 'doctrine'; view.row.doctrine = id; view.rows.doctrine = 'all'; }
  else if (kind === 'shout') { tab = 'shouts'; view.agent = null; view.unread = null; }
  else if (kind === 'tab') tab = id;
  else if (kind === 'coordinate') { tab = 'shouts'; answer(Number(id), true); }
  else if (kind === 'decide') { tab = 'shouts'; answer(Number(id)); }
  if (kind === 'item') { view.tab = 'items'; view.itemsView = 'list'; pick(Number(id), root); }
  else { openTab(tab, ['spec', 'doctrine', 'shout'].includes(kind) ? id : null); render(); }
  if (kind === 'shout') void loadAddressedShout();
}

/** An item's state as a word, for a search result. */
const stateLabel = (i) => ({ building: 'building', verify: 'to verify', verified: 'verified', back: 'sent back', open: 'open', withdrawn: 'withdrawn' })[stateOf(i)] || stateOf(i);

/** A shout's kind as a word, for a search result. */
const shoutKind = (x) => (x.shout_decision ? 'decision' : x.shout_answers ? 'answer' : x.shout_evidence_kind ? 'evidence' : 'shout');

/** Everything on the board that matches the top bar's words: items, Spec rows, Doctrine rules and shouts, newest first. */
function findAll(words) {
  const p = data?.project, q = words.trim().toLowerCase();
  if (!p || !q) return [];
  const has = (...parts) => parts.join(' ').toLowerCase().includes(q);
  const ids = searchIds(p, q);
  const items = p.items.filter((item) => ids.has(item.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((item) => ({ go: 'item:' + item.id, id: '#' + item.id, text: item.title, note: stateLabel(item) }));
  // A Spec row or Doctrine rule is as new as the commit that added it (0 not yet committed; a standard rule, never added
  // here, last); rows one commit added together read newest first by their place in the file.
  const rows = (kind, list) => list.map((r, at) => ({ r, at })).filter(({ r }) => has(r.id, r.text))
    .sort((a, b) => (a.r.added ?? Infinity) - (b.r.added ?? Infinity) || b.at - a.at)
    .map(({ r }) => ({ go: kind + ':' + r.id, id: r.id, text: r.text, note: r.stage || r.status }));
  const shouts = p.shouts.filter((x) => has(x.shout_from, x.shout_to, x.shout_text)).map((x) => ({ go: 'shout:' + x.shout_id, id: '#' + x.shout_id, text: firstLine(x.shout_text), note: shoutKind(x) }));
  return [['Items', items], ['Spec', rows('spec', p.spec)], ['Doctrine', rows('doctrine', p.practice)], ['Shouts', shouts]].filter(([, list]) => list.length);
}

/** Draw the search's results under it: up to five a group, the highlighted one ready for Enter. */
function showFound() {
  const box = $('find-results'), words = $('q').value;
  const groups = findAll(words);
  view.found = groups.flatMap(([, list]) => list.slice(0, 5));
  view.foundAt = Math.min(view.foundAt || 0, Math.max(0, view.found.length - 1));
  let n = 0;
  box.innerHTML = groups.length ? groups.map(([name, list]) => '<h4>' + name + '<span>' + (list.length > 5 ? '5 of ' + list.length : list.length) + '</span></h4>'
    + list.slice(0, 5).map((hit) => '<button class="find-hit' + (n++ === view.foundAt ? ' on' : '') + '" data-find="' + esc(hit.go) + '" type="button" role="option"><code>' + esc(hit.id) + '</code><span>' + esc(hit.text) + '</span><small>' + esc(hit.note) + '</small></button>').join('')).join('')
    : '<div class="find-empty">Nothing on this board matches “' + esc(words.trim()) + '”.</div>';
  box.hidden = !words.trim();
  box.dataset.why = box.hidden ? 'no words' : '';
}

/** Put the search's results away, and say why on the box, so whoever finds them gone can name what closed them. */
function hideFound(why) {
  $('find-results').hidden = true;
  $('find-results').dataset.why = why;
}

/** Open what a result names, and put the results away. */
function openFound(target) {
  hideFound('opened');
  $('q').blur();
  go(target);
}

/** Show an item's detail, on another project's board when root names one. */
function pick(id, root = view.root) {
  view.adding = false;
  if (root !== view.root) return switchTo(root, id);
  if (itemDetails.get(root + '\\n' + id)?.error) itemDetails.delete(root + '\\n' + id);
  view.tab = 'items';
  keep('pb.tab', view.tab);
  view.item = id;
  view.addressDetail = String(id);
  address();
  render();
  reveal();
}

/** Where the list and the detail stack (under 900px), bring the detail into view. */
function reveal() {
  if (matchMedia('(max-width: 900px)').matches) $('detail').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

/**
 * A search looks through every state. Each keystroke with text in the box selects All, even after a
 * chip was clicked mid-search; emptying the box brings back the chip from before the search began.
 */
function search() {
  if ($('q').value.trim()) {
    if (view.before == null) view.before = view.state;
    view.state = 'all';
  } else if (view.before != null) {
    view.state = view.before;
    view.before = null;
  }
  render();
}

/**
 * Open or close the code a path:lines@commit reference names (B23). The first open asks the view for
 * those lines as they were at that commit; the answer stays with the page, so every refresh redraws
 * it, and a failed ask is tried again on the next open.
 */
async function code(ref, before) {
  const c = (view.code[view.root + '\\n' + before + '\\n' + ref] ??= { open: false });
  c.open = !c.open;
  render();
  if (!c.open || c.lines) return;
  c.error = null;
  if (snapshot) {
    c.error = 'Source code is not included in this relay snapshot; open the reference in the local project view.';
    render();
    return;
  }
  if (relayProject(view.root)) {
    c.error = 'Source code is unavailable in a relay view; open this reference in the local project view.';
    render();
    return;
  }
  try {
    const reply = await api(boardPath(view.root) + '/code?ref=' + encodeURIComponent(ref) + '&before=' + encodeURIComponent(before));
    Object.assign(c, reply.code);
  } catch (error) {
    c.error = String(error.message || error);
  }
  render();
}

/** Fetch the rest of a bounded local reference in API-sized windows after an explicit request. */
async function showAllCode(ref, before) {
  const root = view.root;
  const c = view.code[root + '\\n' + before + '\\n' + ref];
  const parts = codeReferenceParts(ref);
  if (!c || c.allLoading) return;
  if (relayProject(root)) { c.error = 'Source code is unavailable in a relay view; open this reference in the local project view.'; render(); return; }
  if (!parts) { c.error = 'Code reference has an invalid path, range or commit SHA.'; render(); return; }
  c.error = null;
  c.allLoading = true;
  render();
  try {
    const lines = [];
    for (let from = parts.from; from <= parts.to; from += 60) {
      const to = Math.min(parts.to, from + 59);
      const pageRef = parts.path + ':' + from + (to === from ? '' : '-' + to) + '@' + parts.commit;
      const page = await api(boardPath(root) + '/code?ref=' + encodeURIComponent(pageRef) + '&before=' + encodeURIComponent(before));
      lines.push(...page.code.lines);
    }
    if (lines.length !== parts.to - parts.from + 1) throw new Error('The local view returned an incomplete code range.');
    c.allLines = lines;
    c.all = true;
  } catch (error) {
    c.error = String(error.message || error);
  } finally {
    c.allLoading = false;
    render();
  }
}

/** Return an expanded preview to its first bounded window without closing the reference. */
function showLessCode(ref, before) {
  const c = view.code[view.root + '\\n' + before + '\\n' + ref];
  if (!c) return;
  c.all = false;
  render();
}

/** Translate person actions into their public literal intent and a familiar command label. */
function pageMove(command, args = {}) {
  /** Trim form values before constructing the move and its display label. */
  const text = (value) => String(value || '').trim();
  if (command === 'add') {
    const fields = { lane: text(args.lane), title: text(args.title) };
    const label = ['add', fields.lane, fields.title];
    for (const name of ['criterion', 'specs', 'brief']) if (text(args[name])) { fields[name] = text(args[name]); label.push('--' + name, fields[name]); }
    return { body: { verb: 'add', args: fields }, label: label.join(' ') };
  }
  if (command === 'shout') return { body: { verb: 'shout', args: { to: text(args.to), text: text(args.text) } }, label: ['shout', text(args.to), text(args.text)].join(' ') };
  if (command === 'coordinator-answer') return { body: { verb: 'answer', item: Number(args.id), args: { text: text(args.text) } }, label: ['answer', text(args.id), text(args.text)].join(' ') };
  if (command === 'answer') return { body: { verb: 'answer', item: Number(args.id), args: { text: text(args.text), as: 'person' } }, label: ['answer', text(args.id), text(args.text), '--as', 'person'].join(' ') };
  if (command === 'hold') return { body: { verb: 'hold', args: { lane: text(args.lane), reason: text(args.reason) } }, label: ['hold', text(args.lane), '--reason', text(args.reason)].join(' ') };
  if (command === 'release') return { body: { verb: 'hold', args: { lane: text(args.lane), off: true } }, label: ['hold', text(args.lane), '--off'].join(' ') };
  if (command === 'spec-approve') {
    const ids = text(args.ids);
    if (!ids) throw new Error('Choose at least one spec row to approve.');
    return { body: { verb: 'spec-approve', args: { ids } }, label: 'spec approve ' + ids };
  }
  if (command === 'spec-decline') {
    const ids = text(args.ids), reason = text(args.reason);
    if (!ids || !reason) throw new Error('Choose a spec row and enter a reason to decline it.');
    return { body: { verb: 'spec-decline', args: { ids, reason } }, label: 'spec decline ' + ids + ' --reason ' + reason };
  }
  if (command === 'sentinel-approve' || command === 'sentinel-decline') {
    const name = text(args.name), digest = text(args.digest), reason = text(args.reason);
    if (!name || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error('Refresh the pending sentinel before deciding it.');
    if (command === 'sentinel-decline' && !reason) throw new Error('Enter a reason to decline this sentinel.');
    const fields = { name, digest, ...(command === 'sentinel-decline' ? { reason } : {}) };
    return { body: { verb: command, args: fields }, label: 'sentinel ' + (command === 'sentinel-approve' ? 'approve ' : 'decline ') + name };
  }
  throw new Error('No view action ' + String(command) + '; choose add, shout, answer, hold or release.');
}

/** Describe an API-confirmed move without exposing its transport document in the page. */
function moveMessage(move, result) {
  if (move.verb === 'add') return 'added #' + result.item.item_id;
  if (move.verb === 'shout') return 'shouted to ' + move.args.to;
  if (move.verb === 'answer') return 'answered #' + move.item;
  if (move.verb === 'spec-approve') return 'approved rows ' + move.args.ids + ' (pending apply)';
  if (move.verb === 'spec-decline') return 'declined rows ' + move.args.ids + ' (pending apply)';
  if (move.verb === 'sentinel-approve') return 'approved sentinel ' + move.args.name;
  if (move.verb === 'sentinel-decline') return 'declined sentinel ' + move.args.name;
  return move.args.off ? 'released the ' + move.args.lane + ' lane' : 'holding the ' + move.args.lane + ' lane: ' + move.args.reason;
}

/**
 * One sentinel draft in Needs-you: a watch the person has not approved, with the proof Rigor drafted it from.
 * It says draft and waiting, never watching, so an unapproved check cannot pass for an approved one.
 */
function sentinelDraftRow(row) {
  const side = (label, proof) => label + ' commit ' + proof.commit.slice(0, 12) + ' exit ' + proof.exit;
  const evidence = row.evidence;
  const proof = evidence && evidence.proof ? 'Proof: ' + evidence.proof.check + ', ' + side('red', evidence.proof.red) + ', ' + side('green', evidence.proof.green) + '.' : '';
  const repeats = evidence ? 'Drafted from ' + evidence.occurrences + (evidence.occurrences === 1 ? ' repeat of ' : ' repeats of ') + evidence.key + (evidence.items.length ? ' on ' + evidence.items.map((item) => '#' + item.id).join(', ') : '') + '.' : 'Proposed by an agent with no repeat cited.';
  const canDecide = !snapshot && (!readOnly || requests);
  const actions = canDecide ? '<div class="sentinel-decision-actions"><button class="approve-row" data-sentinel-decision="approve" data-sentinel-name="' + esc(row.ref) + '" data-sentinel-digest="' + esc(row.digest) + '" type="button">Approve</button><button class="decline-row" data-sentinel-decision="decline" data-sentinel-name="' + esc(row.ref) + '" data-sentinel-digest="' + esc(row.digest) + '" type="button">Decline</button></div>' : '';
  return '<li class="row ask" data-sentinel-draft="' + esc(row.ref) + '"><span class="dot ask"></span><div><div class="t"><span>' + esc(row.ref) + '</span>' + esc(row.text) + '</div>'
    + '<div class="muted sentinel-proof">' + esc(repeats + (proof ? ' ' + proof : '')) + '</div>'
    + '<div class="muted">Command: <code>' + esc(row.check) + '</code></div><div class="muted">Directory: ' + esc(row.directory) + '</div>'
    + '<div class="muted">Schedule: ' + esc(row.every) + '</div><div class="muted">Owner: ' + esc(row.owner) + '</div>'
    + '<div class="meta"><span class="why"><b>NEEDS YOU</b> a sentinel draft awaiting your approval, not watching yet</span></div>' + actions + '</div><span class="chip warn">Approve or Decline</span></li>';
}

/** One blueprint fit proposal: its decision, its new text or reason, and where it came from. */
function fitRow(f) {
  return '<div class="fit-row" data-fit="' + esc(f.target) + '"><div class="meta"><b>' + esc(f.target) + '</b><span class="chip">' + esc(f.decision) + '</span><span class="chip">unverified draft, recorded as ' + esc(f.recordedAs) + '</span></div>' + (f.text ? '<div>' + esc(f.text) + '</div>' : '') + (f.reason ? '<div>Reason: ' + esc(f.reason) + '</div>' : '') + '<div class="muted">Blueprint source: ' + esc(f.blueprint.name + ' v' + f.blueprint.version + ' ' + (f.kind === 'item' ? 'starter' : f.kind) + ' ' + f.key + ': ' + f.source) + '</div></div>';
}

/** Render escaped decision feedback beside the affected Spec row (B26, N26). */
function specFeedback(feedback) {
  return '<div class="spec-feedback ' + feedback.tone + '" role="status">' + esc(feedback.text) + '</div>';
}

/** Ask why a Spec row or Doctrine rule is declined; the reason, once given, is recorded where it was asked. */
function askDecline(kind, id, from, digest = '', anchor = null) {
  view.declining = id;
  view.declineKind = kind;
  view.declineFrom = from;
  view.declineDigest = digest;
  view.declineAnchor = anchor;
  // The dialog belongs to the board it was opened on, as Approve all's confirmation does (#612).
  view.declineRoot = view.root;
  $('spec-decline-title').textContent = 'Decline ' + id;
  $('spec-decline-reason').value = '';
  openModal($('spec-decline-dialog'), $('spec-decline-reason'));
}

/**
 * Close the decline dialog and return what it asked about. Closed by the person, focus returns to the list it was asked
 * from; closed because the page left its board, focus stays where the person put it.
 */
function closeDecline(left = false) {
  const asked = view.declining ? { id: view.declining, kind: view.declineKind, root: view.declineRoot, from: view.declineFrom, digest: view.declineDigest, anchor: view.declineAnchor } : null;
  view.declining = null;
  view.declineDigest = null;
  view.declineAnchor = null;
  closeModal($('spec-decline-dialog'));
  if (!left && asked?.anchor?.isConnected) asked.anchor.focus({ preventScroll: true });
  else if (!left && asked?.from === 'list') $(asked.kind + '-list').focus({ preventScroll: true });
  return asked;
}

/**
 * Ask in the page before one press approves every undecided row of a Spec section (B26, N26). The browser's own confirm
 * dialog can be dismissed or never shown, and then the press recorded nothing and said nothing; this one is the page's.
 */
function askApproveAll(section) {
  const ids = data.project.spec.filter((row) => row.section === section && ['pending', 'draft'].includes(row.status) && !row.decision).map((row) => row.id);
  // Every row was decided after the last redraw; this one drops the stale control.
  if (!ids.length) { render(); return; }
  // The confirmation belongs to the board it was opened on: its rows are that board's, and only that board records them.
  view.approvingAll = { root: view.root, section, ids };
  $('spec-approve-title').textContent = 'Approve all ' + ids.length + (ids.length === 1 ? ' undecided row in “' : ' undecided rows in “') + section + '”?';
  $('spec-approve-rows').textContent = 'Rows: ' + ids.join(', ');
  $('spec-approve-submit').textContent = 'Approve ' + ids.length + (ids.length === 1 ? ' row' : ' rows');
  openModal($('spec-approve-dialog'), $('spec-approve-submit'));
}

/**
 * Close the Approve all confirmation. Cancelled, focus returns to the section control that opened it; approved, to the
 * list, since the section's control leaves once its rows are decided. Closed because the page left its board, focus
 * stays where the person put it.
 */
function closeApproveAll(approved = false, left = false) {
  const asked = view.approvingAll;
  view.approvingAll = null;
  closeModal($('spec-approve-dialog'));
  if (left) return asked;
  const control = !approved && asked && [...$('spec-list').querySelectorAll('[data-section-approve]')].find((button) => button.dataset.sectionApprove === asked.section);
  (control || $('spec-list')).focus({ preventScroll: true });
  return asked;
}

/** Close, recording nothing, a confirmation or decline opened on another board than the one the page now shows. */
function closeIfLeft() {
  if (view.approvingAll && view.approvingAll.root !== view.root) closeApproveAll(false, true);
  if (view.declining && view.declineRoot !== view.root) closeDecline(true);
}

/** Close every dialog bound to a board, recording nothing: the page is leaving the board it was asked on. */
function leaveDialogs() {
  if (view.approvingAll) closeApproveAll(false, true);
  if (view.declining) closeDecline(true);
}

/**
 * Show a page dialog over an inert page: nothing behind it takes a click or focus while it is open, so the person
 * cannot act on the page, or switch the board, under a question the page is asking.
 */
function openModal(dialog, focus) {
  openPageDialog(dialog, focus, pageDialogs);
}

/** Hide a page dialog and give the page back its clicks and focus. */
function closeModal(dialog) {
  if (closePageDialog(dialog, pageDialogs) && deferredClickRender) requestAnimationFrame(() => { if (!pageDialogs.size && heldClickPointer === null && deferredClickRender) { deferredClickRender = false; render(); } });
}

/** Keep Tab and Shift+Tab cycling through an open page dialog's own controls. */
function trapFocus(event) {
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll('button, input, select, textarea, a[href]')].filter((control) => !control.disabled && control.offsetParent !== null);
  if (!controls.length) return;
  event.preventDefault();
  const at = controls.indexOf(document.activeElement);
  const next = at < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (at + (event.shiftKey ? controls.length - 1 : 1)) % controls.length;
  controls[next].focus();
}

/**
 * Record a Spec or Doctrine decision beside its row and retain the list's reading position (B26, N26). A Doctrine rule
 * goes to the board by its qualified id, doctrine:D1, as the command line names it (pullboard spec approve doctrine:D1).
 */
async function decideRow(kind, command, args, anchor) {
  if (snapshot || (readOnly && !requests)) return false;
  const requestMode = requests;
  const root = view.root, scroll = window.scrollY;
  const ids = String(args.ids).split(/\\s+/);
  const prefix = kind + ':';
  const rows = [...$(kind + '-list').querySelectorAll('[data-row]')];
  const index = rows.findIndex((row) => row.dataset.row === prefix + ids[0]);
  const next = rows.slice(index + 1).find((row) => !ids.includes(row.dataset.row.slice(prefix.length)))?.dataset.row.slice(prefix.length);
  const feedback = { kind, root, id: ids[0], next, from: anchor?.closest('#' + kind + '-detail') ? 'detail' : 'list', tone: '', text: 'Recording decision…' };
  view.specFeedback = feedback;
  render();
  // A waiting request keeps its row; let browser anchoring follow growth above it.
  if (!requestMode) window.scrollTo({ top: scroll, behavior: 'instant' });
  try {
    const move = pageMove(command, kind === 'doctrine' ? { ...args, ids: ids.map((id) => 'doctrine:' + id).join(' ') } : args);
    const result = requestMode ? await sendPersonRequest(root, move.body) : await api(boardPath(root) + '/moves', move.body);
    const request = requestMode && result?.result?.request;
    if (requestMode && (!request?.id || !['waiting', 'done', 'refused'].includes(request.status))) throw new Error('The request did not include its status; refresh the board to check it.');
    feedback.tone = requestMode ? request.status === 'done' ? 'ok' : request.status === 'refused' ? 'no' : '' : 'ok';
    feedback.text = requestMode ? requestNotice(request) : moveMessage(move.body, result.result);
    if (requestMode) { feedback.requestId = request.id; feedback.status = request.status; }
    // Decided from the list, the pick moves on to the next row before the board redraws without the decided one, so
    // the next key decides that one.
    if (feedback.from === 'list' && feedback.tone !== 'no' && next && view.row[kind] === ids[0] && root === view.root) view.row[kind] = next;
    await refresh();
  } catch (error) {
    feedback.tone = 'no';
    feedback.text = String(error.message || error);
  }
  if (root === view.root && view.specFeedback === feedback) {
    render();
    if (!requestMode) window.scrollTo({ top: scroll, behavior: 'instant' });
    // A phone row click jumps to its detail. A later list-key decision returns the next pick to view,
    // instead of restoring that detail's scroll position with the focused list still offscreen.
    if (feedback.from === 'list' && feedback.tone === 'ok' && next && view.row[kind] === next) {
      const picked = [...$(kind + '-list').querySelectorAll('[data-row]')].find((row) => row.dataset.row === prefix + next);
      const rect = picked?.getBoundingClientRect();
      // Center an offscreen pick: nearest can round a half-pixel edge just outside the viewport.
      if (rect && (rect.top < 0 || rect.bottom > innerHeight)) picked.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    if (!requestMode || feedback.status === 'done') setTimeout(() => { if (view.specFeedback === feedback) { view.specFeedback = null; render(); } }, 6000);
  }
  return requestMode ? Boolean(feedback.requestId) && feedback.status !== 'refused' : feedback.tone === 'ok';
}

/**
 * Run a public API move beside its action and let only the latest one own the console and timer. The move's own
 * reply is its outcome (#748): the board is read again afterwards, but that read covers every source on a hosted
 * page, and a slow or failing read of another board must neither hold back nor undo a move that went through.
 */
async function act(command, args, anchor) {
  const out = $('console');
  if (snapshot || (readOnly && !requests)) { out.hidden = false; out.className = 'console no'; out.textContent = snapshot ? 'This is a read-only snapshot.' : 'This is a read-only view.'; return false; }
  const requestMode = requests;
  // A form's result stands above its actions, or above the shout composer's bar, never inside that one row.
  if (anchor) {
    const target = anchor.matches('form')
      ? anchor.querySelector('.actions') || anchor.querySelector('.composer') || anchor.querySelector('[type="submit"]') || anchor
      : anchor.closest('#lanes') || anchor;
    target.insertAdjacentElement(anchor.matches('form') ? 'beforebegin' : 'afterend', out);
  }
  const run = (view.acting = (view.acting || 0) + 1);
  const root = view.root;
  const latest = () => run === view.acting && root === view.root;
  view.request = null;
  clearTimeout(view.closing);
  out.hidden = false;
  out.className = 'console';
  out.textContent = requestMode ? 'Request waiting…' : 'running…';
  out.scrollIntoView({ block: 'nearest' });
  try {
    // On the local view the person's word to the coordinator is the person's own request, not a shout the
    // coordinator sends itself; through the relay every action is already a sealed request.
    const asked = command === 'request' && !requestMode;
    const move = asked ? null : pageMove(command === 'request' ? 'shout' : command, command === 'request' ? { to: 'coordinator', text: args.text } : args);
    const result = asked ? await api(boardPath(root) + '/requests', { text: String(args.text || '').trim() })
      : requestMode ? await sendPersonRequest(root, move.body) : await api(boardPath(root) + '/moves', move.body);
    const request = requestMode && result?.result?.request;
    if (requestMode && (!request?.id || !['waiting', 'done', 'refused'].includes(request.status))) throw new Error('The request did not include its status; refresh the board to check it.');
    if (latest()) {
      out.className = 'console' + (requestMode ? request.status === 'done' ? ' ok' : request.status === 'refused' ? ' no' : '' : ' ok');
      out.textContent = requestMode ? requestNotice(request) : asked ? 'Sent to the coordinator.' : '$ pullboard ' + move.label + '\\n' + moveMessage(move.body, result.result);
      if (requestMode) view.request = { root, id: request.id, run };
      out.scrollIntoView({ block: 'center' });
      // What went through says so and then steps aside; a refusal stays until the person closes it.
      if (!requestMode || request.status === 'done') view.closing = setTimeout(() => { if (latest()) out.hidden = true; }, 6000);
    }
    // The result was already revealed. A late refresh must not scroll after the person aims at the next action.
    refresh().catch((error) => { $('live').textContent = 'offline: ' + String(error.message || error); });
    return !requestMode || request.status !== 'refused';
  } catch (error) {
    if (latest()) {
      out.className = 'console no';
      out.textContent = String(error.message || error);
      out.scrollIntoView({ block: 'center' });
    }
    return false;
  }
}

/**
 * Move every age on the page on to now, where it stands. A list is rebuilt only when the board
 * changes, so a click is never lost to a rebuild; on a quiet board the ages would otherwise stay
 * as old as the page.
 */
/** Shouts the person opened past their six lines, kept across refreshes. */
const openShouts = new Set();

/** Fold each shout taller than six lines, with 'more' to open it; measured only while Shouts shows. */
function foldShouts() {
  if ($('feed').offsetParent === null) return;
  document.querySelectorAll('#feed .shout, #decisions .shout').forEach((card) => {
    const text = card.querySelector('.text');
    card.classList.add('clamp');
    card.classList.toggle('clamp', card.classList.contains('open') || text.scrollHeight > text.clientHeight + 1);
  });
}

function tickAges() {
  document.querySelectorAll('[data-ago]').forEach((node) => { node.textContent = node.classList.contains('long') ? agoLong(node.dataset.ago) : ago(node.dataset.ago); });
  tickDays();
}

/**
 * Once the clock has passed midnight since the page named its days, rename them in place with no redraw (#644): the
 * day that was Today and the one that was Yesterday get their names for now, and the shouts, which carry no rule above
 * today's, get one above what is no longer today. Every other day was named by its date and stays true.
 */
function tickDays() {
  const then = daysNamedAt, now = new Date();
  if (then.toDateString() === now.toDateString()) return;
  const before = new Date(then);
  before.setDate(then.getDate() - 1);
  const names = { Today: dayName(then.toISOString()), Yesterday: dayName(before.toISOString()) };
  document.querySelectorAll('.feed .day, #feed > .day-rule span').forEach((node) => { if (names[node.textContent]) node.textContent = names[node.textContent]; });
  const first = $('feed')?.querySelector?.('.shout');
  if (first && !first.previousElementSibling?.classList?.contains('day-rule')) first.insertAdjacentHTML('beforebegin', '<div class="day-rule" role="separator"><span>' + names.Today + '</span></div>');
  daysNamedAt = now;
}

/** Open or close the project list where the sidebar is folded into a top bar (under 900px). */
function fold(open) {
  $('side').classList.toggle('open', open);
  $('proj-switch').setAttribute('aria-expanded', String(open));
}

/** Show another project and its item; history restores keep the tab their entry named. */
function switchTo(root, target = null, record = true) {
  // Switching board or project closes Approve all's confirmation and the decline dialog; neither records on either board.
  leaveDialogs();
  const generation = ++switchGeneration;
  answer(null);
  view.root = root;
  syncBoardMode(root);
  const item = typeof target === 'number' ? target : /^item:(\\d+)$/.exec(target || '');
  const requestedItem = typeof item === 'number' ? item : item ? Number(item[1]) : null;
  view.item = requestedItem;
  view.adding = false;
  if (record && view.item !== null) { view.tab = 'items'; keep('pb.tab', view.tab); }
  keep('pb.project', root);
  if (record) { view.addressDetail = requestedItem === null ? null : String(requestedItem); view.shout = null; address(); }
  fold(false);
  // The board that arrives is drawn even if it matches the last one seen, so the pick is made from it.
  seen = '';
  if (data) render();
  document.body.classList.add('switching');
  return refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }).finally(() => {
    if (generation === switchGeneration) document.body.classList.remove('switching');
    if (generation === switchGeneration && requestedItem !== null && view.item === requestedItem && view.root === root && view.tab === 'items') reveal();
  });
}

// The Shouts tab's own controls: a folded shout's more and less, every agent or only those at work, the agents
// panel hidden or shown, and an agent's name, which filters the feed to its shouts and addresses the composer to it.
$('shouts-pane').addEventListener('click', (event) => {
  if (event.target.closest('[data-credentials]')) { void loadCredentials(); return; }
  const revoke = event.target.closest('[data-revoke-token]');
  if (revoke) { void revokeCredential(revoke.dataset.revokeToken); return; }
  const more = event.target.closest('[data-more]'), pick = event.target.closest('[data-agent]');
  if (more) {
    const card = more.closest('.shout'), id = Number(card.dataset.shoutId);
    if (openShouts.has(id)) openShouts.delete(id); else openShouts.add(id);
    card.classList.toggle('open', openShouts.has(id));
    more.textContent = openShouts.has(id) ? 'less' : 'more';
    return;
  }
  if (event.target.closest('[data-to-clear]')) { addressTo('coordinator'); $('shout-text').focus(); return; }
  const folded = event.target.closest('[data-fold]');
  if (folded) { view.open[folded.dataset.fold] = !view.open[folded.dataset.fold]; render(); return; }
  if (event.target.closest('[data-all-agents]')) { view.allAgents = !view.allAgents; render(); return; }
  if (event.target.closest('[data-agents-toggle]')) { view.agentsHidden = !view.agentsHidden; keep('pb.agents', view.agentsHidden ? 'hidden' : 'shown'); render(); return; }
  if (event.target.closest('[data-unread]')) { view.unread = null; render(); return; }
  if (!pick) return;
  view.unread = null;
  view.agent = pick.dataset.agent && pick.dataset.agent !== view.agent ? pick.dataset.agent : null;
  if (!view.answering) addressTo(view.agent);
  render();
});
// Enter shouts; Shift+Enter starts a new line.
$('shout-text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('shout-form').requestSubmit(); } });
document.addEventListener('click', (event) => {
  // The open-board screens name their state in data-state and handle their own presses (#764).
  if (event.target.closest('#local-note')) return;
  if (view.filterOpen && !event.target.closest('.filter-control')) { view.filterOpen = false; render(); }
  const t = event.target.closest('[data-filter-toggle],[data-filter-choice],[data-status],[data-roadmap-jump],[data-shout-id],[data-roadmap-key],[data-roadmap-all],[data-roadmap-held],[data-root],[data-tab],[data-go],[data-item],[data-items-view],[data-state],[data-rows],[data-row],[data-row-decision],[data-sentinel-decision],[data-section-approve],[data-release],[data-shout],[data-new],[data-code],[data-code-all],[data-code-less],[data-stats-toggle],#proj-switch,#console');
  if (!event.target.closest('.side')) fold(false);
  if (!t) return;
  if (t.id === 'proj-switch') { fold(!$('side').classList.contains('open')); return; }
  if (t.id === 'console') { t.hidden = true; return; }
  if (t.tagName === 'A' && t.dataset.go?.startsWith('item:')) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
  }
  if (t.dataset.statsToggle !== undefined) {
    view.statsOpen = !view.statsOpen;
    render();
    $('proof-stats-summary').focus({ preventScroll: true });
    return;
  }
  if (t.dataset.status) { statusGo(t.dataset.status); return; }
  if (t.dataset.roadmapJump) { jumpToRoadmap(t.dataset.roadmapJump); return; }
  if (t.dataset.filterToggle !== undefined) { view.filterOpen = !view.filterOpen; render(); return; }
  if (t.dataset.filterChoice) {
    if (t.dataset.filterKind === 'state') view.state = t.dataset.filterValue;
    else view.lane = t.dataset.filterValue || null;
    view.filterOpen = false;
    render();
    $('filter-toggle').focus({ preventScroll: true });
    return;
  }
  if (t.dataset.itemsView) { view.itemsView = t.dataset.itemsView; view.addressDetail = null; address(); render(); return; }
  if ('roadmapKey' in t.dataset) {
    const key = t.dataset.roadmapKey, open = t.getAttribute('aria-expanded') !== 'true';
    view.roadmapOpen.set(JSON.stringify([view.root, key]), open);
    // The row or release opens in place, its block already drawn from the summary, and paints in this frame; the
    // full redraw, which fills its detail, follows that paint, so click to paint never waits on it (#1039).
    const panel = t.classList.contains('milestone-item') ? t.nextElementSibling : t.parentElement.querySelector(':scope > .milestone-body');
    t.setAttribute('aria-expanded', String(open));
    if (panel) panel.hidden = !open;
    requestAnimationFrame(() => setTimeout(() => {
      render();
      [...$('roadmap').querySelectorAll('[data-roadmap-key]')].find((head) => head.dataset.roadmapKey === key)?.focus({ preventScroll: true });
    }));
    return;
  }
  if ('roadmapAll' in t.dataset) { view.roadmapOnly = null; render(); return; }
  if ('roadmapHeld' in t.dataset) { view.roadmapHeld = view.roadmapHeld === t.dataset.roadmapHeld ? null : t.dataset.roadmapHeld; render(); return; }
  if (t.dataset.root) switchTo(t.dataset.root, t.dataset.go || '');
  else if (t.dataset.tab) { view.unread = null; view.roadmapOnly = null; openTab(t.dataset.tab); render(); }
  else if (t.dataset.go) go(t.dataset.go, t.dataset.board);
  else if (t.dataset.item) pick(Number(t.dataset.item));
  else if (t.dataset.state) { view.state = t.dataset.state; render(); }
  else if (t.dataset.rows) {
    const [kind, f] = t.dataset.rows.split(':');
    const addressed = view.addressDetail !== null;
    view.rows[kind] = f;
    view.addressDetail = null;
    render();
    if (addressed) { view.addressDetail = view.row[kind]; address(); }
  }
  else if (t.dataset.rowDecision) {
    const id = t.dataset.rowId, kind = t.dataset.rowKind;
    if (t.dataset.rowDecision === 'approve') decideRow(kind, 'spec-approve', { ids: id }, t);
    else askDecline(kind, id, t.closest('#' + kind + '-detail') ? 'detail' : 'list');
  }
  else if (t.dataset.sentinelDecision) {
    const name = t.dataset.sentinelName, digest = t.dataset.sentinelDigest;
    if (t.dataset.sentinelDecision === 'approve') act('sentinel-approve', { name, digest }, $('needs'));
    else askDecline('sentinel', name, 'needs', digest, t);
  }
  else if (t.dataset.sectionApprove) askApproveAll(t.dataset.sectionApprove);
  else if (t.dataset.shoutId && !event.target.closest('button,a,input,textarea,select')) { go('shout:' + t.dataset.shoutId); }
  else if (t.dataset.row) {
    const [kind, id] = t.dataset.row.split(':');
    view.row[kind] = id;
    view.addressDetail = id;
    address();
    render();
    $(kind + '-list').focus({ preventScroll: true });
    // Where the list and the detail stack, the picked row's detail, with its buttons, comes into view.
    if (matchMedia('(max-width: 900px)').matches) $(kind + '-detail').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  else if (t.dataset.codeAll) showAllCode(t.dataset.codeAll, t.dataset.before || '');
  else if (t.dataset.codeLess) showLessCode(t.dataset.codeLess, t.dataset.before || '');
  else if (t.dataset.code) code(t.dataset.code, t.dataset.before || '');
  else if (t.dataset.release) act('release', { lane: t.dataset.release }, t);
  else if (t.dataset.shout) { answer(null); addressTo(t.dataset.shout); $('shout-text').value = '#' + t.dataset.about + ': '; openTab('shouts'); showTab(); $('shout-text').focus(); }
  else if (t.dataset.new !== undefined) { view.adding = true; render(); $('add-title').focus(); }
});
// The viewport's scroll is fired at the document; the tests' stand-in document has no window.
document.addEventListener('scroll', updateRoadmapPanel, { passive: true });
/** Close the expanded stats card and return focus to the list's summary control on Escape. */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !view.statsOpen || view.tab !== 'items' || document.querySelector('[data-pane="items"]')?.hidden) return;
  event.preventDefault();
  view.statsOpen = false;
  render();
  $('proof-stats-summary').focus({ preventScroll: true });
});
/** Let a Roadmap row with independent inline links keep its keyboard button behavior. */
document.addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  const head = event.target.closest('.milestone-head');
  if (head && event.target === head) { event.preventDefault(); head.click(); return; }
  const row = event.target.closest('.milestone-item[role="button"]');
  if (event.target !== row) return;
  event.preventDefault();
  if (row.dataset.roadmapKey !== undefined) { row.click(); return; }
  go(row.dataset.go, row.dataset.board || view.root);
});
// In a focused Spec or Doctrine list the arrow keys move the pick, and A approves the picked row and D asks why it is
// declined, as the detail's buttons do, wherever the detail offers that decision.
for (const kind of ['spec', 'doctrine']) $(kind + '-list').addEventListener('keydown', (event) => {
  if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
  const ids = [...event.currentTarget.querySelectorAll('[data-row]')].map((row) => row.dataset.row.slice(kind.length + 1));
  const at = ids.indexOf(view.row[kind]);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = ids[Math.min(ids.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next && next !== view.row[kind]) { view.row[kind] = next; view.addressDetail = next; address(); render(); event.currentTarget.querySelector('.srow.on')?.scrollIntoView({ block: 'nearest' }); }
  } else if (event.key === 'Enter' && view.row[kind]) {
    event.preventDefault();
    $(kind + '-detail').scrollIntoView({ block: 'start', behavior: 'instant' });
  } else if ((event.key === 'a' || event.key === 'd') && view.row[kind] && $(kind + '-detail').querySelector('.approve-row')) {
    // Only a row still waiting on the person has a decision to make; the detail shows it.
    event.preventDefault();
    if (event.key === 'a') decideRow(kind, 'spec-approve', { ids: view.row[kind] }, event.currentTarget);
    else askDecline(kind, view.row[kind], 'list');
  }
});
// The form covers the picked item rather than dropping it, so Cancel brings it back.
$('new-item').addEventListener('click', () => { view.adding = true; render(); $('add-title').focus(); });
$('upgrade-note').addEventListener('click', (event) => {
  if (!event.target.closest('[data-upgrade-dismiss]')) return;
  const notice = releaseNotices.get(data.project?.root);
  if (notice) notice.releases = [];
  renderReleaseNotes(data.project);
});
$('add-cancel').addEventListener('click', () => { view.adding = false; render(); });
$('spec-decline-cancel').addEventListener('click', () => { closeDecline(); });
$('spec-decline-form').addEventListener('keydown', trapFocus);
// The row the dialog named is declined, with its reason, on the board it was opened on and only there.
$('spec-decline-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const reason = $('spec-decline-reason').value.trim();
  if (!view.declining || !reason) return;
  const asked = closeDecline();
  if (asked.root !== view.root) return;
  if (asked.kind === 'sentinel') {
    act('sentinel-decline', { name: asked.id, digest: asked.digest, reason }, $('needs'));
    return;
  }
  const anchor = asked.from === 'detail' ? $(asked.kind + '-detail') : [...$(asked.kind + '-list').querySelectorAll('[data-row]')].find((row) => row.dataset.row === asked.kind + ':' + asked.id);
  decideRow(asked.kind, 'spec-decline', { ids: asked.id, reason }, anchor);
});
$('spec-approve-cancel').addEventListener('click', () => { closeApproveAll(); });
$('spec-approve-form').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closeApproveAll(); } else trapFocus(event); });
// The rows the confirmation named are the rows approved, on the board it was opened on and only there; the decision's
// note beside them says what the board did.
$('spec-approve-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const asked = closeApproveAll(true);
  if (asked && asked.root === view.root) decideRow('spec', 'spec-approve', { ids: asked.ids.join(' ') });
});
$('answer-cancel').addEventListener('click', () => answer(null));
$('flow-hide').addEventListener('click', () => showFlow(false));
$('flow-show').addEventListener('click', () => showFlow(true));
$('flow-panel').hidden = keep('pb.flow') === 'hidden';
$('flow-show').hidden = !$('flow-panel').hidden;
// Each press moves on one, from the system's theme to light, then dark, and back; this browser keeps it.
$('side-toggle').addEventListener('click', () => {
  // A phone always shows the switcher, so there the logo is only the logo.
  if (!matchMedia('(width > 900px)').matches) return;
  const collapsed = !document.documentElement.dataset.side;
  collapseSide(collapsed);
  fold(false);
  keep('pb.side', collapsed ? 'collapsed' : 'open');
});
/** Pick the scheme the page does not show now, and keep it. */
function flipTheme() {
  const next = document.documentElement.dataset.scheme === 'dark' ? 'light' : 'dark';
  keep('pb.theme', next);
  theme(next);
}
$('theme').addEventListener('click', flipTheme);
$('ob-theme').addEventListener('click', flipTheme);
$('q').addEventListener('input', () => { search(); view.foundAt = 0; showFound(); });
// Leaving the field closes the results a moment later, so a press on a result lands first; coming back to the field
// before then keeps them, or a search begun straight after Esc would lose its new results to the old close.
let closingFound = 0;
$('q').addEventListener('focus', () => { clearTimeout(closingFound); if ($('q').value.trim()) showFound(); });
$('q').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { $('q').value = ''; search(); hideFound('escape'); $('q').blur(); return; }
  if (!view.found?.length || $('find-results').hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); view.foundAt = (view.foundAt + (event.key === 'ArrowDown' ? 1 : view.found.length - 1)) % view.found.length; showFound(); }
  else if (event.key === 'Enter') { event.preventDefault(); openFound(view.found[view.foundAt].go); }
});
// A press on a result opens it before the field loses focus and the results close.
$('find-results').addEventListener('mousedown', (event) => { const hit = event.target.closest('[data-find]'); if (hit) { event.preventDefault(); openFound(hit.dataset.find); } });
$('q').addEventListener('blur', () => {
  clearTimeout(closingFound);
  // Esc and opening a result already close explicitly; their blur must keep that reason.
  if ($('find-results').hidden) return;
  closingFound = setTimeout(() => hideFound('left the field'), 120);
});
// "/" goes to the search from anywhere but a field.
document.addEventListener('keydown', (event) => {
  if (!view.filterOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    view.filterOpen = false;
    render();
    $('filter-toggle').focus({ preventScroll: true });
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const choices = [...$('filter-menu').querySelectorAll('[data-filter-choice]')];
    const at = choices.indexOf(document.activeElement);
    if (choices.length) {
      event.preventDefault();
      const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length;
      choices[next].focus({ preventScroll: true });
    }
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.target.closest('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  $('q').focus();
  $('q').select();
});
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const root = view.root;
  const submitted = { lane: $('add-lane').value, title: $('add-title').value, criterion: $('add-criterion').value, specs: $('add-specs').value, brief: $('add-brief').value };
  if (await act('add', submitted, event.currentTarget) && view.root === root
      && $('add-lane').value === submitted.lane && $('add-title').value === submitted.title
      && $('add-criterion').value === submitted.criterion && $('add-specs').value === submitted.specs
      && $('add-brief').value === submitted.brief) {
    $('add-title').value = '';
    $('add-criterion').value = '';
    $('add-specs').value = '';
    $('add-brief').value = '';
  }
});
$('shout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = $('shout-text').value;
  const root = view.root;
  const ask = view.answering;
  const answerRoot = ask?.root ?? null;
  const answerId = ask?.id ?? null;
  if (ask && ask.root !== view.root) return answer(null);
  if (!(await (ask ? act(ask.ordinary ? 'coordinator-answer' : 'answer', { id: ask.id, text }, event.currentTarget) : ($('shout-to').value === 'coordinator' ? act('request', { text }, event.currentTarget) : act('shout', { to: $('shout-to').value, text }, event.currentTarget))))) return;
  const currentAnswer = view.answering;
  // An older completion must not erase a newer draft or answer selection.
  if (view.root !== root || $('shout-text').value !== text || (currentAnswer?.root ?? null) !== answerRoot
      || (currentAnswer?.id ?? null) !== answerId) return;
  $('shout-text').value = '';
  answer(null);
});
$('hold-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const root = view.root;
  const submitted = { lane: $('hold-lane').value, reason: $('hold-reason').value };
  if (await act('hold', submitted, event.currentTarget) && view.root === root
      && $('hold-lane').value === submitted.lane && $('hold-reason').value === submitted.reason) $('hold-reason').value = '';
});
// The first entry keeps the tab it opened on; Back and Forward show what each entry names.
address(false);
globalThis.addEventListener?.('popstate', fromAddress);
showTab();
if (snapshot) {
  $('replay-play').addEventListener('click', playReplay);
  $('replay-pause').addEventListener('click', pauseReplay);
  $('replay-speed').addEventListener('change', () => {
    if (snapshotReplay.playing) { clearTimeout(snapshotReplay.timer); snapshotReplay.timer = setTimeout(advanceReplay, 1000 / Number($('replay-speed').value)); }
  });
}
/** Copy a screen's command or sentence; a browser without the clipboard API copies from a selected field. */
async function copyWords(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { /* Older and embedded browsers refuse the clipboard API: copy from a selected field below. */ }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  return copied;
}
$('local-note').addEventListener('click', async (event) => {
  const button = event.target instanceof Element ? event.target.closest('button[data-copy]') : null;
  if (!button || !button.dataset.copy) return;
  button.textContent = await copyWords(button.dataset.copy) ? 'Copied' : 'Select and copy';
});
/**
 * Look for this machine's view again, by itself, while a screen waits on it or a signed-in person waits for a board:
 * the moment the view answers, the page opens the board, with no Try again (#764). Over a relay stream, a reload
 * starts both sources together.
 */
let relisting = false;
function lookAgain() {
  // This computer's view answered, then a read failed, as a busy view's can: read again every two seconds, so the
  // board shows the moment a list arrives (hostedListed clears the problem), never only on the slower fallback timer.
  if (hosted.local && localReached && !document.hidden && $('local-note').dataset.state === 'problem') {
    if (!relisting) { relisting = true; refresh().catch(() => {}).finally(() => { relisting = false; }); }
    return;
  }
  if (!hosted.local || relayPairing || localReached || localProblem || document.hidden) return;
  if (![...LOCAL_STATES, 'no-linked', 'unpaired'].includes($('local-note').dataset.state || '') || $('local-note').dataset.state === 'looking') return;
  connectLocal(true).then((local) => {
    if (local !== 'local') return;
    if (transport) { location.reload(); return; }
    transportModule = null;
    return refresh();
  }).catch((error) => localNote('problem', { detail: error.message }));
}
if (hosted.local && !snapshot) setInterval(lookAgain, 2000);

/** Open a newly approved board's Items view after its real list entry arrives. */
async function openApprovedBoard(boardId) {
  await refresh();
  const board = data?.projects.find(entry => entry.id === boardId && entry.ok);
  if (!board) throw new Error('The approved board did not load. Refresh the board list and try again.');
  view.tab = 'items';
  keep('pb.tab', view.tab);
  return switchTo(board.root);
}

/** Load the configured decrypting transport once, only when relay reads or pairing need it. */
let transportLoading = null;
async function loadTransport() {
  if (transport) return transport;
  if (!transportLoading) transportLoading = (async () => {
    const module = await pageStartup(document.documentElement).within(() => import(configuredTransportModule), 15_000, 'The relay client did not load within 15 seconds.');
    if (typeof module.createTransport !== 'function') throw new Error('The browser transport must export createTransport({ onUpdate }).');
    const configured = await module.createTransport({
      onUpdate: () => transport ? refresh().catch((error) => { $('live').textContent = 'offline: ' + error.message; }) : Promise.resolve(),
      onOpenBoard: openApprovedBoard, waitForRender: true, // A phone's transport keeps its shell until didRender (#899).
    });
    if (!configured || typeof configured.request !== 'function') throw new Error('The browser transport must provide request(path, body).');
    transportModule = configuredTransportModule;
    transport = configured;
    return transport;
  })();
  try { return await transportLoading; }
  catch (error) { transportLoadError = error; pageStartup(document.documentElement).say(error.message + ' Check your connection, then reload this page.'); throw error; }
  finally { transportLoading = null; }
}

/** Read local boards first; relay-only pages and pairing still load their configured client directly. */
async function startPage() {
  let local = 'unreachable';
  // The page opens on Finding your boards; it shows only if the look is slow (#948).
  if (hosted.local) revealNote($('local-note').dataset.state);
  if (hosted.local && !relayPairing) {
    if (localProblem) localNote('problem', { detail: localProblem });
    else local = await connectLocal();
    if (local === 'away') { document.body.classList.remove('loading'); return; }
    if (local === 'unreachable' && !hosted.relaySession) { document.body.classList.remove('loading'); hideRelayNotice(); return; }
  }
  if (hosted.local && local === 'local') transportModule = null;
  else if (configuredTransportModule) {
    // Signed out, a pairing link waits for sign-in, which its own state asks for.
    try { await loadTransport(); } catch (error) { if (!hosted.local || hosted.relaySession) throw error; document.body.classList.remove('loading'); localNote('signed-out'); return; }
  }
  // The page shows its screen only once the remote list has answered or failed, so the mark holds until then (#932).
  await refresh();
  document.body.classList.remove('loading');
}
startPage().catch((error) => {
  document.body.classList.remove('loading');
  $('live').textContent = 'cannot reach the view: ' + error.message;
  // Finding your boards never stays on a page that has stopped looking.
  if (hosted.local && $('local-note').dataset.state === 'looking') localNote('problem', { detail: 'Pullboard on this computer did not answer: ' + error.message });
});
// The relay transport keeps its own stream and timer. The local view reads on a timer only while it has no live
// stream, and its live line says so (#545). Each timer asks which the page uses as it fires: the hosted page starts
// out on the relay and turns to this machine's view once it reaches it (#513).
if (!snapshot) setInterval(() => { if (!document.hidden && (transport || (hosted.local && hosted.relaySession && configuredTransportModule))) refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }); }, 3000);
if (!snapshot) setInterval(() => { if (!document.hidden && !transport && !(hosted.local && hosted.relaySession && configuredTransportModule) && !connected()) refresh().catch(() => { $('live').textContent = 'offline: is pullboard view still running?'; }); }, FALLBACK_MS);
setInterval(tickAges, 60000);
`;
}
