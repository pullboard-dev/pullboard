/**
 * Draw a list of cards whose rows are patched by key (#6679). The page embeds this source, so it reads nothing from its
 * module.
 *
 * - The cards come as html with an empty `<li data-slot="key">` where each row goes; the rows' markup comes by key.
 * - A row whose markup is the one its node was made from keeps that node. Only a changed row gets a new node, made with
 *   the other changed rows in one parse, so a live update touches the rows that changed and no others.
 * - When the cards around the rows changed, they are drawn off the page with their slots filled from the kept nodes.
 * - With ageless, a row whose markup differs only in an age's words keeps its node: the page ticks ages in place (#6851).
 *
 * @param {{ host: object, doc: object, nodes: Map<string, { html: string, node: object }>, drawn: ({ scope: string, html: string }|null),
 *   html: string, rows: Map<string, string>, scope: string, ageless?: boolean }} input - host: the element the cards live in; doc: the
 *   document that makes templates; nodes and drawn: what the last call returned; html: the cards; rows: each row's
 *   markup by key; scope: what the rows belong to, whose change starts over; ageless: compare rows without their ages' words.
 * @returns {{ nodes: Map<string, { html: string, node: object }>, drawn: { scope: string, html: string } }} What to pass next time.
 */
export function patchKeyedRows({ host, doc, nodes, drawn, html, rows, scope, ageless = false }) {
  // A document that cannot parse markup into nodes (a bare test page) draws the cards whole, rows in their slots.
  if (!doc.createElement('template').content) {
    const text = (value) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    host.innerHTML = html.replace(/<li data-slot="([^"]*)"><\/li>/g, (slot, key) => rows.get(text(key)) ?? '');
    return { nodes: new Map(), drawn: null };
  }
  const same = drawn !== null && drawn.scope === scope;
  const known = same ? nodes : new Map();
  const words = (markup) => (ageless ? markup.replace(/(<time\b[^>]*\bdata-ago="[^"]*"[^>]*>)[^<]*/gu, '$1') : markup);
  const fresh = [...rows].filter(([key, markup]) => !known.has(key) || words(known.get(key).html) !== words(markup));
  const replaced = fresh.map(([key]) => [key, known.get(key)?.node]);
  if (fresh.length) {
    const made = doc.createElement('template');
    made.innerHTML = fresh.map(([, markup]) => markup).join('');
    fresh.forEach(([key, markup], n) => known.set(key, { html: markup, node: made.content.children[n] }));
  }
  for (const key of [...known.keys()]) if (!rows.has(key)) known.delete(key);
  if (!same || drawn.html !== html || replaced.some(([, old]) => old && !old.parentNode)) {
    const frame = doc.createElement('template');
    frame.innerHTML = html;
    for (const slot of frame.content.querySelectorAll('li[data-slot]')) slot.replaceWith(known.get(slot.dataset.slot).node);
    host.replaceChildren(frame.content);
  } else {
    for (const [key, old] of replaced) if (old) old.replaceWith(known.get(key).node);
  }
  return { nodes: known, drawn: { scope, html } };
}
