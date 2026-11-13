/** The cost analytics read: short database slices with a turn for the event loop between them, and one answer per unchanged board [6663]. */
import * as store from '../../../store/index.js';

const turn = () => new Promise(resolve => setImmediate(resolve));

/**
 * Answer one window. Each read is short and the loop gets a turn between them, so a shout or item read never waits behind
 * the whole answer; an unchanged board (same newest event) answers from the kept answer, and a repeat while one is
 * being built shares it.
 *
 * @param {{ root: string }} board
 * @param {string} window today, 7d or 30d
 * @param {{ read: (work: (current: any) => any) => any, now: Date, modelPresentation: Function, answers: Map<string, Promise<any>>, costWindowStart: Function, costAnalyticsSliced: Function }} io
 * @returns {Promise<any>}
 */
export function readCostAnalytics(board, window, { read, now, modelPresentation, answers, costWindowStart, costAnalyticsSliced }) {
  const from = costWindowStart(window, now);
  const revision = read(current => store.costRevision(current)), key = `${board.root}|${window}|${from.toISOString()}|${revision}`;
  const kept = answers.get(key);
  if (kept) return kept;
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
    for (let start = 0; start < ids.length; start += 300) {
      const slice = ids.slice(start, start + 300);
      read(current => { events.push(...store.costItemEvents(current, slice)); items.push(...store.costItems(current, slice)); });
      await turn();
    }
    return costAnalyticsSliced({ items, agents, events, window, now, modelPresentation }, turn);
  })();
  for (const old of answers.keys()) if (old.startsWith(`${board.root}|${window}|`)) answers.delete(old);
  answers.set(key, answer);
  answer.catch(() => { if (answers.get(key) === answer) answers.delete(key); });
  return answer;
}
