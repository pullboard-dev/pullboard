/** The cost analytics read: short database slices with a turn for the event loop between them, and one answer per unchanged board [6663]. A changed board answers from the last answer at once while the next builds [7362]. */
import * as store from '../../../store/index.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

/**
 * Answer one window. Each read is short and the loop gets a turn between them, so a shout or item read never waits behind
 * the whole answer; an unchanged board (same newest event) answers from the kept answer, and a repeat while one is
 * being built shares it. Why a changed board answers from its last answer: the board's newest event moves every few
 * seconds, so every read after a move built the whole answer on the request, 1.4 s on the live board at load 39 [7362].
 *
 * @param {{ root: string }} board
 * @param {string} window today, 7d or 30d
 * @param {{ read: (work: (current: any) => any) => any, now: Date, modelPresentation: Function, answers: Map<string, Promise<any>>, costWindowStart: Function, costAnalyticsSliced: Function, coordinatorUsage?: Function }} io
 * @returns {Promise<any>}
 */
export function readCostAnalytics(board, window, { read, now, modelPresentation, answers, costWindowStart, costAnalyticsSliced, coordinatorUsage }) {
  const from = costWindowStart(window, now);
  const revision = read(current => store.costRevision(current)), key = `${board.root}|${window}|${from.toISOString()}|${revision}`;
  const kept = answers.get(key), last = answers.get(`${board.root}|${window}|last`);
  if (kept && (kept.settled || !last)) return kept;
  if (kept) return last;
  const answer = (async () => {
    await turn();
    const agents = read(current => store.listAgents(current)), events = [];
    await turn();
    for (let after = 0, page = []; ; after = page.at(-1).event_id) {
      page = read(current => store.costKindEvents(current, after, 3000));
      if (!page.length) break;
      events.push(...page); await turn();
    }
    const ids = read(current => store.costLandedIds(current, from.toISOString())), items = [];
    const landed = new Set(ids);
    for (const kind of ['merged', 'submit', 'accept', 'reject', 'reopen']) {
      for (let after = 0, page = []; ; after = page.at(-1).event_id) {
        page = read(current => store.costMoveEvents(current, kind, after, 3000));
        if (!page.length) break;
        for (const event of page) if (landed.has(event.item_id)) events.push(event);
        await turn();
      }
    }
    for (let start = 0; start < ids.length; start += 300) {
      read(current => items.push(...store.costItems(current, ids.slice(start, start + 300))));
      await turn();
    }
    // The coordinator claims no item, so its usage rides beside the item totals as one entry the Cost overview draws; absent port, absent entry (#9834) [C7].
    const coordinator = coordinatorUsage ? read(current => coordinatorUsage(current)) : undefined;
    const analytics = await costAnalyticsSliced({ items, agents, events, window, now, modelPresentation }, turn);
    return coordinator ? { ...analytics, coordinator } : analytics;
  })();
  for (const old of answers.keys()) if (old.startsWith(`${board.root}|${window}|`) && !old.endsWith('|last')) answers.delete(old);
  answers.set(key, answer);
  answer.then(() => { answer.settled = true; answers.set(`${board.root}|${window}|last`, answer); }, () => { if (answers.get(key) === answer) answers.delete(key); });
  return last ?? answer;
}
