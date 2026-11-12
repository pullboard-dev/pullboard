/**
 * The page's one client store (U94, #6613). The page embeds this source, so it reads nothing from its module.
 *
 * - The board state the page shows lives here; `set` takes each read and bumps `version` only when the read changed
 *   what the board says, so a read that repeats the board changes nothing downstream.
 * - Pages render from selectors: `select` keeps a computed value until one of its inputs changes.
 * - A part of the page is written only through `paint`, which leaves a part whose markup is unchanged alone: its
 *   scroll, focus and open disclosures stay. Ages alone never repaint a part; the page ticks them in place.
 * - A pane drawn from the current board and view is reused on a tab switch (`paneFresh`), so a switch draws
 *   nothing it already holds and asks the network for nothing.
 *
 * @returns {object} The store.
 */
export function pageStore() {
  const memo = new Map();
  const painted = new WeakMap();
  const panes = new Map();
  const AGES = /(<time\b[^>]*\bdata-ago="[^"]*"[^>]*>)[^<]*/gu;
  let board = null, version = 0, epoch = 0;
  /** The view's own choices as one comparable text; the tab and one-shot flags are not a pane's input. */
  const viewKey = ({ tab, seen, scrollPlace, ...choices }, extra) => {
    try { return JSON.stringify([choices, extra], (key, value) => (value instanceof Map || value instanceof Set ? [...value] : value)); }
    catch { return String(Math.random()); } // a view it cannot write down is never the one a pane was drawn from
  };
  return {
    get board() { return board; },
    get version() { return version; },
    /** Hold the board the page shows; changed says the read differs from the last one drawn. */
    set(next, changed = next !== board) {
      board = next;
      if (changed) version += 1;
      return board;
    },
    /** A selector's value, computed again only when an input is not the one it was computed from. */
    select(name, inputs, compute) {
      const kept = memo.get(name);
      if (kept && kept.inputs.length === inputs.length && kept.inputs.every((input, n) => Object.is(input, inputs[n]))) return kept.value;
      const value = compute(...inputs);
      memo.set(name, { inputs, value });
      return value;
    },
    /** Write a part's markup only when it differs from what this part last drew, apart from its ages. */
    paint(element, html) {
      if (!element) return false;
      const markup = String(html ?? ''), key = markup.replace(AGES, '$1');
      const kept = painted.get(element);
      // A part someone else rewrote since has a new first node, and is drawn again.
      if (kept && kept.key === key && kept.first === element.firstChild) return false;
      element.innerHTML = markup;
      painted.set(element, { key, first: element.firstChild });
      return true;
    },
    /** Note where each scrolled part stands before a draw. */
    scrollMark(elements) {
      return elements.filter(Boolean).map(element => [element, element.scrollTop || 0, element.scrollLeft || 0]).filter(([, top, left]) => top || left);
    },
    /** Put each part back where it stood when a draw moved it. */
    scrollRestore(marks) {
      for (const [element, top, left] of marks) {
        if (element.scrollTop !== top) element.scrollTop = top;
        if (element.scrollLeft !== left) element.scrollLeft = left;
      }
    },
    /** Any draw other than a tab switch may change what every pane shows. */
    invalidate() { epoch += 1; },
    /** What a pane was drawn from: the board's version, the view's choices and what has arrived since. */
    paneKey(view, extra) { return version + '|' + epoch + '|' + viewKey(view, extra); },
    paneDrawn(tab, key) { panes.set(tab, key); },
    paneFresh(tab, key) { return panes.get(tab) === key; },
  };
}
