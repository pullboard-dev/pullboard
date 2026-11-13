/**
 * The view's search box, command palette and keyboard shortcuts [U94 item 6, #6616]. The page script inlines this
 * text and calls pbPalette(env) once; env names what the page owns (its tabs, its board in memory, go, the theme), so
 * nothing here fetches: item search reads the board the page already holds.
 *
 * Cmd+K or / opens the palette; g then a page letter jumps; ? lists the shortcuts; \ moves the navigation; Esc closes.
 * Typing in a field never triggers a shortcut.
 */
function pbPalette(env) {
  const doc = env.document;
  const KEYS = { progress: 'p', items: 'i', shouts: 's', roadmap: 'r', spec: 'e', doctrine: 'o', dashboard: 'd', activity: 'a', cost: 'c' };
  const WHAT = {
    progress: 'What is happening, in plain words', items: 'Every piece of work', shouts: 'Agents talking to the coordinator',
    roadmap: 'What ships next, in order', spec: 'What the product must do', doctrine: 'How the work must be done',
    dashboard: 'Every number on the board', activity: 'What happened, in order', cost: 'Time and tokens per item', settings: 'This view and your account',
  };
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const mod = env.mac ? '⌘' : 'Ctrl ';
  let pal = null, help = false, gAt = 0, from = null;
  const overlay = doc.createElement('div');
  overlay.id = 'pal-overlay';
  doc.body.appendChild(overlay);

  /** The pages the navigation holds now, each with its letter and what it is. */
  const pages = () => env.pages().map((p) => ({ ...p, key: KEYS[p.id] || null, what: WHAT[p.id] || '' }));

  /** What a query finds: pages, then items by id or title, then actions; an empty query lists the pages and the actions. */
  function results(query) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const p of pages()) if (!q || p.name.toLowerCase().includes(q)) out.push({ kind: 'Go to', label: p.name, sub: p.what, key: p.key ? 'g ' + p.key : '', run: () => env.go('tab:' + p.id) });
    if (q) {
      const bare = q.replace(/^#/, '');
      const hits = env.items().filter((i) => String(i.title || '').toLowerCase().includes(q) || (bare && String(i.id).includes(bare)))
        .sort((a, b) => (String(a.id) === bare ? 0 : 1) - (String(b.id) === bare ? 0 : 1) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      for (const i of hits.slice(0, 8)) out.push({ kind: 'Items', label: '#' + i.id + ' ' + i.title, sub: i.state || '', key: '', run: () => env.go('item:' + i.id) });
    }
    const actions = [
      ...(env.hasTab('settings') ? [{ label: 'Open settings', run: () => env.go('tab:settings') }] : []),
      { label: 'Switch between light and dark', run: () => env.theme() },
      { label: 'Move the navigation', key: '\\', run: () => env.movePlace() },
      { label: 'Show keyboard shortcuts', key: '?', run: () => { help = true; draw(); } },
    ];
    for (const a of actions) if (!q || a.label.toLowerCase().includes(q)) out.push({ kind: 'Actions', label: a.label, sub: '', key: a.key || '', run: a.run });
    return out;
  }

  const rowsHtml = (list, sel) => {
    let last = '';
    return list.map((r, i) => {
      const head = r.kind !== last ? '<div class="pal-sec">' + esc(r.kind) + '</div>' : '';
      last = r.kind;
      return head + '<button class="pal-r' + (i === sel ? ' on' : '') + '" type="button" role="option" aria-selected="' + (i === sel) + '" data-res="' + i + '"><span>' + esc(r.label) + '</span><small>' + esc(r.sub) + '</small>'
        + (r.key ? '<kbd>' + esc(r.key) + '</kbd>' : '') + '</button>';
    }).join('') || '<div class="pal-sec">No matches</div>';
  };

  function drawResults() {
    pal.list = results(pal.q);
    pal.sel = Math.min(pal.sel, Math.max(0, pal.list.length - 1));
    overlay.querySelector('.pal-res').innerHTML = rowsHtml(pal.list, pal.sel);
    overlay.querySelector('.pal-res .on')?.scrollIntoView?.({ block: 'nearest' });
  }

  function draw() {
    if (help) {
      overlay.innerHTML = '<div class="pal-veil" data-close="1"><div class="pal-help" role="dialog" aria-label="Keyboard shortcuts"><h2>Keyboard shortcuts</h2>'
        + '<div><span>Search or jump anywhere</span><kbd>' + mod + 'K</kbd></div><div><span>Search</span><kbd>/</kbd></div>'
        + pages().filter((p) => p.key).map((p) => '<div><span>Go to ' + esc(p.name) + '</span><kbd>g ' + p.key + '</kbd></div>').join('')
        + '<div><span>Move the navigation</span><kbd>\\</kbd></div><div><span>Show these shortcuts</span><kbd>?</kbd></div><div><span>Close</span><kbd>Esc</kbd></div></div></div>';
      return;
    }
    if (!pal) { overlay.innerHTML = ''; return; }
    overlay.innerHTML = '<div class="pal-veil" data-close="1"><div class="pal-box" role="dialog" aria-label="Search or jump to"><input id="pal-q" role="combobox" aria-expanded="true" aria-controls="pal-res" autocomplete="off" spellcheck="false" placeholder="Search items, or jump to a page…" value="' + esc(pal.q) + '"><div class="pal-res" id="pal-res" role="listbox"></div></div></div>';
    drawResults();
    const input = overlay.querySelector('#pal-q');
    input.focus();
    input.setSelectionRange?.(pal.q.length, pal.q.length);
  }

  function open() {
    from = doc.activeElement;
    help = false;
    pal = { q: '', sel: 0, list: [] };
    draw();
  }
  function close(restore = true) {
    const was = pal || help;
    pal = null; help = false; gAt = 0;
    draw();
    if (was && restore && from && from.isConnected && from.focus) from.focus({ preventScroll: true });
    from = null;
  }
  function choose(r) {
    if (!r) return;
    close(false);
    r.run();
  }

  overlay.addEventListener('input', (e) => { if (pal && e.target.id === 'pal-q') { pal.q = e.target.value; pal.sel = 0; drawResults(); } });
  overlay.addEventListener('click', (e) => {
    const row = e.target.closest?.('[data-res]');
    if (row && pal) return choose(pal.list[Number(row.dataset.res)]);
    if (e.target.dataset?.close) close();
  });
  overlay.addEventListener('mousemove', (e) => {
    const row = e.target.closest?.('[data-res]');
    if (!row || !pal || Number(row.dataset.res) === pal.sel) return;
    pal.sel = Number(row.dataset.res);
    overlay.querySelectorAll('.pal-r').forEach((r, i) => { r.classList.toggle('on', i === pal.sel); r.setAttribute('aria-selected', String(i === pal.sel)); });
  });

  /** A field, a text area, a menu or anything editable: shortcuts leave what is typed there alone. */
  const typingIn = (t) => Boolean(t && (t.closest?.('input, textarea, select, [contenteditable]') || t.isContentEditable));

  function onKey(e) {
    if (e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      if (pal) close(); else open();
      return;
    }
    if (e.key === 'Escape') {
      if (pal || help) { e.preventDefault(); e.stopPropagation(); close(); }
      gAt = 0;
      return;
    }
    if (pal) {
      const last = pal.list.length - 1;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        pal.sel = e.key === 'ArrowDown' ? Math.min(pal.sel + 1, last) : Math.max(pal.sel - 1, 0);
        drawResults();
      } else if (e.key === 'Enter') { e.preventDefault(); choose(pal.list[pal.sel]); }
      return;
    }
    if (e.key === '?' && help) { e.preventDefault(); close(); return; }
    if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (gAt) {
      const live = Date.now() - gAt < 900;
      gAt = 0;
      const p = live && pages().find((x) => x.key === e.key);
      if (p) { e.preventDefault(); env.go('tab:' + p.id); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); open(); }
    else if (e.key === '?') { e.preventDefault(); help = true; draw(); }
    else if (e.key === '\\') { e.preventDefault(); env.movePlace(); }
    else if (e.key === 'g') gAt = Date.now();
  }
  doc.addEventListener('keydown', onKey, true);

  // The visible search box: a borderless "Search or jump to…" with its shortcut beside it; a press opens the palette.
  const box = env.box;
  if (box) {
    box.placeholder = 'Search or jump to…';
    const hint = doc.createElement('kbd');
    hint.className = 'pal-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = mod + 'K';
    box.parentNode.appendChild(hint);
    box.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); open(); } });
  }
  return { open, close, results, onKey, isOpen: () => Boolean(pal), isHelp: () => help, choose, state: () => pal };
}
