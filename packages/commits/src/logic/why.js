/**
 * The decisions, rows and items behind a file or a line, from the commits that landed on it [N29].
 *
 * A commit pins its item with a `Pullboard-Item: #N` trailer; the items it names carry the rows they
 * serve and the answered decisions that imply them. One query over Git history and the board.
 */
import { tryGit } from "../../../git/index.js";
import { mainCheckout } from "../../../git/index.js";
import { Refused } from "../../../kernel/light.js";
import { originOf } from "./origin.js";
import {
  historicalPaths,
  mappedPath,
  readPathMap,
} from "../../../codemap/light.js";

/**
 * Split `path` or `path:line` into the file and an optional line.
 *
 * @param {string} target
 * @returns {{ file: string, line: number | null }}
 */
export function parseFileTarget(target) {
  const match = /^(.+?):([1-9]\d*)$/u.exec(target);
  return match ? { file: match[1], line: Number(match[2]) } : { file: target, line: null };
}

/**
 * The item ids named by the landed commits that touched a file or line, oldest first.
 *
 * @param {string} root the repository root
 * @param {{ file: string, line: number | null }} target
 * @returns {number[]}
 */
export function itemsTouching(root, { file, line }) {
  const trunk = mainCheckout(root);
  if (!trunk?.commit) return [];
  const map = readPathMap(root, { commit: trunk.commit });
  const range = line === null ? ['--', ...historicalPaths(map, file).map(path => `:(literal)${path}`)]
    : [`-L${line},${line}:${mappedPath(map, file)}`, '-s'];
  const log = tryGit(root, ['log', '--first-parent', '--diff-merges=first-parent', '--reverse', '--format=%x01%B', trunk.commit, ...range]);
  if (log.status !== 0) {
    if (line !== null && /no such path|file .* has only|there is no path/iu.test(log.stderr)) return [];
    if (/does not have any commits|unknown revision|bad revision|ambiguous argument/iu.test(log.stderr)) return [];
    throw new Refused('WHY_GIT', `git could not read the history of ${file}: ${log.stderr.split('\n')[0]}`);
  }
  const ids = [];
  for (const body of log.stdout.split('\x01')) {
    for (const match of body.matchAll(/^Pullboard-(?:Item|Companion):\s*#(\d+)\s*$/gmu)) ids.push(Number(match[1]));
  }
  return [...new Set(ids)];
}

/**
 * Everything behind a file or line: its items, the rows they serve and the decisions that imply them.
 *
 * @param {any} board
 * @param {string} root
 * @param {string} target `path` or `path:line`
 * @returns {{ file: string, line: number | null, items: object[], rows: object[], decisions: object[] }}
 */
export function whyFile(board, root, target) {
  const parsed = parseFileTarget(target);
  const ids = itemsTouching(root, parsed);
  const found = board.db.prepare(`
    WITH selected AS (
      SELECT item.* FROM item JOIN json_each(?) requested ON item.item_id = requested.value
    ), links AS (
      SELECT event.item_id, json_extract(event_detail, '$.decision.id') AS answer
      FROM event JOIN selected ON selected.item_id = event.item_id
      WHERE event_kind = 'fact' AND json_extract(event_detail, '$.decision.source') = 'answer'
      UNION
      SELECT event.item_id, json_extract(event_detail, '$.shout') AS answer
      FROM event JOIN selected ON selected.item_id = event.item_id WHERE event_kind = 'answer'
    )
    SELECT selected.item_id, item_title, item_status, item_spec_ids,
      answer.shout_id, answer.shout_text, answer.shout_at, recorded.event_detail
    FROM selected LEFT JOIN links ON links.item_id = selected.item_id
    LEFT JOIN shout answer ON answer.shout_id = links.answer
    LEFT JOIN event recorded ON recorded.event_kind = 'answer'
      AND json_extract(recorded.event_detail, '$.shout') = answer.shout_id
    ORDER BY selected.item_id, answer.shout_id`).all(JSON.stringify(ids));
  const itemMap = new Map();
  const rowMap = new Map();
  const decisionMap = new Map();
  for (const record of found) {
    const item = record.item_id;
    itemMap.set(item, { id: item, title: record.item_title, status: record.item_status, origin: 'unknown' });
    for (const id of record.item_spec_ids.split(',').filter(Boolean)) {
      if (!rowMap.has(id)) rowMap.set(id, { id, items: [], origin: 'unknown' });
      const row = rowMap.get(id);
      if (!row.items.includes(item)) row.items.push(item);
    }
    if (record.shout_id === null) continue;
    if (!decisionMap.has(record.shout_id)) {
      const detail = record.event_detail ? JSON.parse(record.event_detail) : {};
      const recorded = detail.provenance;
      decisionMap.set(record.shout_id, { id: record.shout_id, items: [],
        statement: recorded?.statement ?? record.shout_text, rationale: recorded?.rationale ?? '',
        decidedBy: recorded?.decidedBy ?? 'unknown', relayedBy: recorded?.relayedBy ?? null,
        origin: originOf(detail), at: record.shout_at });
    }
    const decision = decisionMap.get(record.shout_id);
    if (!decision.items.includes(item)) decision.items.push(item);
  }
  return { file: parsed.file, line: parsed.line, items: [...itemMap.values()], rows: [...rowMap.values()],
    decisions: [...decisionMap.values()].sort((left, right) => left.id - right.id) };
}
