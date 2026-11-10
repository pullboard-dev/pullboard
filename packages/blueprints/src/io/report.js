/** What blueprint commands report back: a blueprint's starters on this board and the rows that wait [S1,I1]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as store from '../../../store/index.js';
import {
  blueprintMarker,
  bundledBlueprints,
  readBlueprint,
} from './main.js';
import { loadConfig } from '../../../config/index.js';
import { loadDoctrine } from '../../../doctrine/light.js';
import { Refused } from '../../../kernel/index.js';
import { loadSpec } from '../../../spec/index.js';

/**
 * @typedef {object} StarterState
 * @property {string} key - The starter's key in the blueprint.
 * @property {string} title - The starter's title.
 * @property {boolean} filed - The blueprint's own add filed this starter on the board.
 * @property {number | null} id - The filed item's id, or null when it is not filed.
 * @property {string | null} status - The filed item's status, or null when it is not filed.
 */

/**
 * The row id each rule, question and default key of a blueprint got on this board, read from its SPEC.md
 * section. Blueprint add numbers the rules, then the questions and defaults, in blueprint order, as the rows it
 * writes just before its finished marker for that name and version; a row the person rewords or
 * declines keeps its id, so the positions still name the same keys. Why the marker: two versions of
 * one blueprint share a title, so the first section by title is the older version's on an upgraded
 * board (#734 review). The rows are those after the section's heading, or after an earlier
 * blueprint's marker in it, up to this marker. With no marker, the first section by title. Empty
 * when the blueprint has no rows here.
 *
 * @param {{ name: string, version: number, title: string, rules: { key: string }[], questions: { key: string }[], defaults?: { key: string }[] }} blueprint
 * @param {{ sections: { name: string, line: number }[], rows: { id: string, section: string, line: number }[] }} spec - loadSpec's result.
 * @param {string} [source] - SPEC.md's text, where the markers are.
 * @returns {Record<string, string>}
 */
export function blueprintRowIds(blueprint, spec, source = '') {
  const lines = source.split(/\r?\n/u);
  const markerLine = lines.findIndex((line) => line.trim() === blueprintMarker(blueprint)) + 1;
  const titled = (entry) => /^[A-Z][A-Z0-9]*\s*[·.:-]/u.test(entry.name)
    && entry.name.replace(/^[A-Z][A-Z0-9]*\s*[·.:-]\s*/u, '') === blueprint.title.trim();
  let rows;
  if (markerLine) {
    const section = spec.sections.filter((entry) => entry.line < markerLine).at(-1);
    const sectionStart = section?.line ?? 0;
    const earlier = lines.slice(sectionStart, markerLine - 1).reduce((at, line, index) => (/^<!-- pullboard-blueprint \S+ \d+ -->$/u.test(line.trim()) ? sectionStart + index + 1 : at), sectionStart);
    rows = spec.rows.filter((row) => row.line > earlier && row.line < markerLine);
  } else {
    const section = spec.sections.find(titled);
    if (!section) return {};
    rows = spec.rows.filter((row) => row.section === section.name);
  }
  const keys = [...blueprint.rules, ...blueprint.questions, ...(blueprint.defaults ?? [])].map((entry) => entry.key);
  return Object.fromEntries(keys.flatMap((key, index) => (rows[index] ? [[key, rows[index].id]] : [])));
}

/** The start of the note fact blueprint add records on each starter item it files (blueprintStarterNote). */
const STARTER_LINK = 'blueprint starter: ';

/**
 * The starter link an item's thread records, or null when its add recorded none, as on an item
 * filed by hand or by an add from before links were recorded.
 *
 * @param {{ type: string, kind?: string, text?: string }[]} thread - The item's thread, from store.itemThread.
 * @returns {{ blueprint: string, version: number, key: string } | null}
 */
export function starterLink(thread) {
  for (const entry of thread) {
    if (entry.type !== 'fact' || entry.kind !== 'note' || !entry.text?.startsWith(STARTER_LINK)) continue;
    try {
      const link = JSON.parse(entry.text.slice(STARTER_LINK.length));
      if (typeof link?.blueprint === 'string' && Number.isInteger(link.version) && typeof link.key === 'string') return link;
    } catch (error) {
      // A note that only starts like a link is someone's own words; it links nothing.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

/**
 * Each of a blueprint's starter items and whether its add filed it on this board. An item is the
 * starter when the link its add recorded names this blueprint, this version and the starter's key.
 * An item with no recorded link at all, filed before adds recorded one, counts only when it carries
 * the starter's title and cites exactly the rows this blueprint's add gave the starter's keys, the
 * identity a resumed add uses; a starter that cites no rows must also match its criterion. That
 * fallback is used only when no linked item names the starter, and an item linked to another
 * blueprint, version or starter never counts. When several items match, a live one is named
 * before a withdrawn one, then the oldest.
 *
 * @param {{ name: string, version: number, items: { key: string, title: string, cites?: string[], criterion?: string }[] }} blueprint
 * @param {Record<string, any>[]} items - Every item on the board, as store.listItems returns them.
 * @param {Record<string, string>} rowIds - Row id by rule or question key, from blueprintRowIds.
 * @param {Map<number, { blueprint: string, version: number, key: string } | null>} links - Each item's recorded link, by item id.
 * @returns {StarterState[]}
 */
export function starterStates(blueprint, items, rowIds, links) {
  const order = (a, b) => Number(a.item_status === 'withdrawn') - Number(b.item_status === 'withdrawn') || a.item_id - b.item_id;
  return blueprint.items.map((starter) => {
    const title = starter.title.trim();
    const own = items.filter((item) => {
      const link = links.get(item.item_id);
      return link && link.blueprint === blueprint.name && link.version === blueprint.version && link.key === starter.key;
    });
    const cites = starter.cites ?? [];
    const specIds = cites.map((key) => rowIds[key]).filter(Boolean).join(',');
    const cited = cites.length
      ? (item) => specIds.length > 0 && item.item_spec_ids === specIds
      : (item) => item.item_spec_ids === '' && item.item_criterion === (starter.criterion ?? '');
    const unlinked = items.filter((item) => !links.get(item.item_id) && item.item_title === title && cited(item));
    const found = (own.length ? own : unlinked).sort(order)[0];
    const status = found?.item_status ?? null;
    return { key: starter.key, title, filed: Boolean(found), id: found?.item_id ?? null, status };
  });
}

/**
 * The lines pullboard blueprint starters prints: a heading with the count filed, then one line per
 * starter that names its item id and status when it is filed.
 *
 * @param {{ name: string, title: string, version: number }} blueprint
 * @param {StarterState[]} starters
 * @returns {string[]}
 */
export function starterLines(blueprint, starters) {
  const filed = starters.filter((starter) => starter.filed).length;
  const lines = [`${blueprint.title} (version ${blueprint.version}) has ${starters.length} starter ${starters.length === 1 ? 'item' : 'items'}; ${filed} filed on this board`];
  for (const starter of starters) {
    lines.push(starter.filed ? `  #${starter.id} ${starter.status}  ${starter.title}` : `  not filed  ${starter.title}`);
  }
  if (filed < starters.length) lines.push(`next: file the rest with pullboard blueprint add ${blueprint.name}`);
  return lines;
}

/**
 * Every row that waits for the person after init --blueprint: the blueprint's new rows in SPEC.md
 * and each doctrine row still draft or pending, such as a standard rule the repo inherits. Why the
 * doctrine rows: init writes the doctrine file too, and a pending rule there waits for the same
 * person, so a summary of the blueprint's rows alone hides one (the blueprint trial missed PB7).
 *
 * @param {{ id: string, status: string, text: string }[]} rows - The rows the blueprint added.
 * @param {{ rows: { id: string, status: string, text: string, file?: string }[] }} doctrine - loadDoctrine's result.
 * @param {string} specFile - The spec file's name, such as SPEC.md.
 * @returns {{ id: string, status: string, text: string, file: string }[]}
 */
export function waitingRows(rows, doctrine, specFile) {
  return [
    ...rows.filter((row) => ['draft', 'pending'].includes(row.status)).map(({ id, status, text }) => ({ id, status, text, file: specFile })),
    ...doctrine.rows.filter((row) => ['draft', 'pending'].includes(row.status))
      .map(({ id, status, text, file }) => ({ id, status, text, file: file ?? 'doctrine' })),
  ];
}

/**
 * The lines init prints for the rows that wait: a count, then one line per row with its file.
 *
 * @param {{ id: string, status: string, text: string, file: string }[]} waiting
 * @returns {string[]}
 */
export function waitingRowLines(waiting) {
  if (!waiting.length) return [];
  return [`  ${waiting.length} ${waiting.length === 1 ? 'row waits' : 'rows wait'} for the person:`,
    ...waiting.map((row) => `    ${row.id} ${row.status}  ${row.text}  (${row.file})`)];
}

/**
 * The rows that wait for the person after init added a blueprint, read from the repo init set up.
 *
 * @param {string} root - The repository root.
 * @param {{ rows: { id: string, status: string, text: string }[] }} added - What the add returned.
 * @returns {{ id: string, status: string, text: string, file: string }[]}
 */
export function initWaitingRows(root, added) {
  const config = loadConfig(root);
  return waitingRows(added.rows, loadDoctrine(root, config), config.spec);
}

/**
 * The line a repeat add prints: the blueprint is already here, and where its starters are listed.
 *
 * @param {{ name: string, title: string, version: number }} blueprint
 * @returns {string}
 */
export function alreadyAddedLine(blueprint) {
  return `the ${blueprint.title} blueprint (version ${blueprint.version}) is already on this board; nothing added; see its starters with pullboard blueprint starters ${blueprint.name}`;
}

/**
 * pullboard blueprint starters <name or file>: list a blueprint's starters and the item each one's
 * add filed. It reads the spec and the board and writes nothing. The caller passes its own context
 * and board opener, so this command reads the board exactly as every other command does.
 *
 * @param {any} io
 * @param {{ second?: string, rest: string[], context: (io: any) => any, withBoard: (ctx: any, work: (board: any) => any) => any }} args
 * @returns {number}
 */
export function startersCommand(io, { second, rest, context, withBoard }) {
  if (!second || rest.length) throw new Refused('USAGE', `pullboard blueprint starters <name or file>; bundled: ${bundledBlueprints().join(', ')}`);
  const blueprint = readBlueprint(second, io.cwd);
  const ctx = context(io);
  const rowIds = blueprintRowIds(blueprint, loadSpec(ctx.info.root, ctx.config), readFileSync(join(ctx.info.root, ctx.config.spec), 'utf8'));
  const starters = withBoard(ctx, (board) => {
    const items = store.listItems(board, { all: true });
    return starterStates(blueprint, items, rowIds, new Map(items.map((item) => [item.item_id, starterLink(store.itemThread(board, item.item_id))])));
  });
  io.result?.({ blueprint: { name: blueprint.name, title: blueprint.title, version: blueprint.version }, starters });
  starterLines(blueprint, starters).forEach((line) => io.say(line));
  return 0;
}
