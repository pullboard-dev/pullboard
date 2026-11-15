/**
 * The Activity page's interaction rules as one pure step (#6916): one slot is open on the page at a time; the slot shows
 * one tab, Events or (after a bar or row click) the Item; x and Esc close the item; a filter keeps one hour open.
 * Each call returns the next state and leaves the old one alone, so the page can draw from either.
 * The page embeds this function's source text, so it reads only its arguments and language globals [N26].
 *
 * @param {object} ui - { filter, lane, page, open, tab, item, itemHour, pages, evBefore, cell }.
 * @param {object} action - { type: 'hour'|'tab'|'item'|'close'|'filter'|'lane'|'page'|'pager'|'cell', ... }.
 * @param {object} flow - The activityFlow model, for the hours a filter must keep open.
 * @returns {object} The next state.
 */
export function activityStep(ui, action, flow) {
  const next = { ...ui, pages: { ...(ui.pages ?? {}) } };
  const matches = (hour, state) => hour.events.some(entry => state.lane ? flow.laneIds(state.lane.stage, state.lane.sub).has(entry.id) : state.filter === 'all' || entry.kind === state.filter);
  /** After a filter, keep an hour open: the open one when it has matches, else the newest hour that does. */
  const settle = () => {
    next.pages = {};
    const open = flow.hours.find(hour => hour.h0 === next.open);
    if (!open || !matches(open, next)) { const found = flow.hours.find(hour => matches(hour, next)); next.open = found ? found.h0 : null; next.page = found ? Math.floor(flow.hours.indexOf(found) / 3) : next.page; }
    next.item = null; next.itemHour = null; next.tab = 'ev'; next.evBefore = false;
  };
  switch (action.type) {
    case 'hour': // an hour's header or Events tab: the open events tab closes the slot; the item tab goes back to events; another hour takes the slot
      if (next.open === action.hour && next.tab === 'ev') { next.open = null; next.item = null; next.itemHour = null; next.evBefore = false; }
      else if (next.open === action.hour) { next.tab = 'ev'; next.evBefore = true; }
      else { next.open = action.hour; next.tab = 'ev'; next.item = null; next.itemHour = null; next.evBefore = false; }
      return next;
    case 'item': // a bar or an event row: the item opens in the card it was clicked in; a second click on it closes it
      if (next.item === action.item && next.itemHour === action.hour && next.tab === 'item') return activityStep(ui, { type: 'close' }, flow);
      next.evBefore = next.open === action.hour && (next.tab === 'ev' || next.evBefore);
      next.item = action.item; next.itemHour = action.hour; next.open = action.hour; next.tab = 'item';
      return next;
    case 'tab':
      if (action.tab === 'item' && next.item !== null) next.tab = 'item';
      return next;
    case 'close': // x or Esc: the item goes; the events tab it came from stays, otherwise the slot closes
      if (next.item === null) return next;
      next.item = null; next.itemHour = null;
      if (next.evBefore) next.tab = 'ev'; else next.open = null;
      next.evBefore = false;
      return next;
    case 'filter': next.filter = action.filter || 'all'; next.lane = null; settle(); return next;
    case 'lane': next.filter = 'all'; next.lane = { stage: action.stage, sub: action.sub }; settle(); return next;
    case 'page': next.page = Math.max(0, (next.page || 0) + action.by); next.open = null; next.item = null; next.itemHour = null; next.tab = 'ev'; next.evBefore = false; return next;
    case 'pager': next.pages[action.hour] = Math.max(1, action.to); return next;
    case 'cell': next.cell = next.cell === action.cell ? null : action.cell; return next;
    default: return next;
  }
}

/** The state a page starts in: the newest hour that has events open on them, nothing filtered, nothing opened. */
export function activityStart(flow) {
  return { filter: 'all', lane: null, page: 0, open: (flow.hours.find(hour => hour.events.length) ?? flow.hours[0])?.h0 ?? null, tab: 'ev', item: null, itemHour: null, pages: {}, evBefore: false, cell: null };
}
