/**
 * Several blueprints in one init or blueprint add [S1,I1]: --blueprint repeats, and the blueprints
 * land in the order given. A board takes at most one product blueprint and one architecture
 * blueprint, one per deployable (research U110), and any number of practice and beyond-code ones.
 * A rule or question text two of them share is drafted once, by the first, and the later blueprint
 * cites that row. Every starter item keeps the name of the blueprint that filed it.
 */
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  bundledBlueprints,
  readBlueprint,
} from './main.js';
import {
  CONFIG_FILE,
  configFromSource,
} from '../../../config/index.js';
import { Refused } from '../../../kernel/index.js';
import { storeName } from './store-names.js';

/**
 * The kinds a board takes one of, by the slot each fills. Why infrastructure is here: #719 renamed
 * it architecture and loads it as such, but a kind line written by name still says what it read.
 */
const ONE_PER_BOARD = { product: 'product', infrastructure: 'architecture', architecture: 'architecture' };

/**
 * The slot a blueprint fills, product or architecture, or null for a kind a board takes any number of.
 *
 * @param {{ kind?: string }} blueprint
 * @returns {string | null}
 */
export function blueprintSlot(blueprint) {
  return ONE_PER_BOARD[blueprint.kind] ?? null;
}

/**
 * The blueprints a repo's board already has and the slot each fills, read from its SPEC.md: the
 * kind line each one's add leaves, with slot null for a kind a board takes any number of. A board
 * an older Pullboard set up has a blueprint's marker alone. Its kind then comes from the bundled
 * file of that name, else from its own file at the repo root (<name>.json or <name>.blueprint.json),
 * checked like any blueprint; else the slot is unknown, which may be the product or architecture
 * slot, so readBlueprints refuses either until the kind is recorded. Nothing without a spec.
 *
 * @param {string} root - The repository root.
 * @returns {{ name: string, slot: string | null }[]}
 */
export function installedBlueprints(root) {
  let specFile = 'SPEC.md';
  try { specFile = configFromSource(readFileSync(join(root, CONFIG_FILE), 'utf8')).spec; }
  catch (error) {
    // No pullboard.json yet, or one init will refuse on its own: the default spec file is read.
    if (!(error instanceof SyntaxError) && error?.code !== 'ENOENT') throw error;
  }
  const file = join(root, String(specFile));
  if (!existsSync(file)) return [];
  const found = new Map();
  const legacy = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const kind = /^<!-- pullboard-blueprint-kind (\S+) (\S+) -->$/u.exec(line.trim());
    const marker = /^<!-- pullboard-blueprint (\S+) \d+(?: adding .*)? -->$/u.exec(line.trim());
    if (kind) found.set(kind[1], blueprintSlot({ kind: kind[2] }));
    else if (marker) legacy.push(marker[1]);
  }
  for (const name of legacy) if (!found.has(name)) found.set(name, legacySlot(name, root));
  return [...found].map(([name, slot]) => ({ name, slot }));
}

/**
 * The slot of a blueprint whose marker has no kind line: from the bundled file of that name, else
 * from its own file at the repo root when that file names it, else "unknown".
 *
 * @param {string} name
 * @param {string} root
 * @returns {string | null}
 */
function legacySlot(name, root) {
  if (bundledBlueprints().includes(name)) return blueprintSlot(readBlueprint(name, root));
  for (const candidate of [`${storeName(name)}`, `${name}.blueprint.json`]) {
    if (!existsSync(join(root, candidate))) continue;
    try {
      const blueprint = readBlueprint(join(root, candidate), root);
      if (blueprint.name === name) return blueprintSlot(blueprint);
    } catch (error) {
      // A file there that is no valid blueprint says nothing about this one's kind.
      if (!(error instanceof Refused)) throw error;
    }
  }
  return 'unknown';
}

/**
 * Read every named blueprint, in the order given, before anything is written, so an unknown name
 * or a clash leaves the repository as it was. The same blueprint version named twice is read once.
 * A second product or architecture blueprint is refused with BLUEPRINT_KIND_TAKEN naming both,
 * whether the first is named in the same command or already on the board; adding again the
 * blueprint the board already has is no clash, since that add changes nothing.
 *
 * @param {string[]} references - Bundled names or paths, as --blueprint gave them.
 * @param {string} cwd
 * @param {string} command - The command to name in the next step, such as "init".
 * @param {{ name: string, slot: string | null }[]} [installed] - The board's own, from installedBlueprints.
 * @returns {{ reference: string, blueprint: import('./main.js').Blueprint }[]}
 */
export function readBlueprints(references, cwd, command, installed = []) {
  const read = [];
  for (const reference of references) {
    const blueprint = readBlueprint(reference, cwd);
    if (read.some((entry) => entry.blueprint.name === blueprint.name && entry.blueprint.version === blueprint.version)) continue;
    const slot = blueprintSlot(blueprint);
    const onBoard = slot && installed.find((entry) => [slot, 'unknown'].includes(entry.slot) && entry.name !== blueprint.name);
    if (onBoard?.slot === 'unknown') {
      throw new Refused('BLUEPRINT_KIND_TAKEN',
        `${onBoard.name} and ${blueprint.name} may both be ${slot} blueprints: this board has ${onBoard.name}, added before Pullboard recorded a blueprint's kind, and a board takes one ${slot} blueprint; record its kind by adding its file again, which changes nothing else: pullboard blueprint add <${onBoard.name} file>`,
        `record ${onBoard.name}'s kind with pullboard blueprint add <${onBoard.name} file>, then run pullboard ${command} again`);
    }
    if (onBoard) {
      throw new Refused('BLUEPRINT_KIND_TAKEN',
        `${onBoard.name} and ${blueprint.name} are both ${slot} blueprints, and this board already has ${onBoard.name}; a board takes one ${slot} blueprint, so add ${blueprint.name} on a board of its own`,
        `keep ${onBoard.name} and leave ${blueprint.name} out of pullboard ${command}`);
    }
    const holder = slot && read.find((entry) => blueprintSlot(entry.blueprint) === slot);
    if (holder) {
      const keep = read.map((entry) => `--blueprint ${entry.reference}`).join(' ');
      throw new Refused('BLUEPRINT_KIND_TAKEN',
        `${holder.blueprint.name} and ${blueprint.name} are both ${slot} blueprints, and a board takes one ${slot} blueprint; keep one of them: pullboard ${command} ${keep}`,
        `name one ${slot} blueprint: pullboard ${command} ${keep}`);
    }
    read.push({ reference, blueprint });
  }
  return read;
}

/**
 * The result blueprint add gives for several blueprints: the first blueprint's own fields, as one
 * add gives them, with the rows, items, lanes and stored checks of all of them, and each one's own
 * summary in blueprints, in the order they landed.
 *
 * @param {any[]} added - Each blueprint's summary from its add, in order.
 * @returns {any}
 */
export function combinedSummary(added) {
  return { ...added[0], rows: added.flatMap((entry) => entry.rows), items: added.flatMap((entry) => entry.items),
    gate: added.find((entry) => entry.gate)?.gate ?? null, marked: added.every((entry) => entry.marked),
    proposedLanes: [...new Map(added.flatMap((entry) => entry.proposedLanes).map((lane) => [lane.name, lane])).values()],
    checksNotRun: added.flatMap((entry) => entry.checksNotRun), blueprints: added };
}

/**
 * What init's JSON result says about one blueprint it added.
 *
 * @param {any} added - The blueprint's summary from its add.
 * @returns {any}
 */
export function initBlueprintResult(added) {
  return { name: added.blueprint.name, title: added.blueprint.title, section: added.section, waiting: added.rows.filter((row) => ['draft', 'pending'].includes(row.status)).length,
    items: added.items.length, gate: added.gate, checksNotRun: added.checksNotRun, shared: added.shared ?? [] };
}

/**
 * The line init and blueprint add print for rows a blueprint shares with one added before it:
 * the rows it cites from there instead of drafting them again. Empty when it shares none.
 *
 * @param {any} added - The blueprint's summary from its add.
 * @returns {string[]}
 */
export function sharedRowLines(added) {
  const shared = added.shared ?? [];
  if (!shared.length) return [];
  return [`${added.blueprint.name} shares ${shared.map((row) => row.id).join(', ')} with an earlier blueprint, so each is drafted once`];
}

/**
 * The note fact blueprint add records on each starter item it files, so the item keeps the name of
 * its blueprint: the blueprint's name and version and the starter's key, as JSON after a fixed
 * prefix. The text is the link #734 reads back with blueprint starters, so either reads the other.
 *
 * @param {{ name: string, version: number }} blueprint
 * @param {string} key - The starter's key in the blueprint.
 * @returns {string}
 */
export function blueprintStarterNote(blueprint, key) {
  return `blueprint starter: ${JSON.stringify({ blueprint: blueprint.name, version: blueprint.version, key })}`;
}

/**
 * Add each blueprint in turn with one shared map of the rows drafted so far, by text, so a text
 * two of them share is drafted once, by the first.
 *
 * @template T
 * @param {T[]} list - The blueprints to add, in order.
 * @param {(entry: T, drafted: Map<string, string>) => Promise<any>} add - Adds one and returns its summary.
 * @returns {Promise<any[]>} Each blueprint's summary, in order.
 */
export async function landEach(list, add) {
  const drafted = new Map();
  const landed = [];
  for (const entry of list) landed.push(await add(entry, drafted));
  return landed;
}

/**
 * The lines init prints for one blueprint it added: the summary, the starters that could not go to
 * the lane they asked for, the checks stored and not run, and the rows it shares with one before it.
 *
 * @param {any} added - The blueprint's summary from its add.
 * @param {string[]} laneNotes - askedLaneNotes for its starters.
 * @returns {string[]}
 */
export function initBlueprintLines(added, laneNotes) {
  const waiting = added.rows.filter((row) => ['draft', 'pending'].includes(row.status)).length;
  const proposed = added.proposedLanes.length ? ` in the ${added.proposedLanes.map((lane) => lane.name).join(' and ')} lane, proposed above; add it with the command printed there` : '';
  return [`added the ${added.blueprint.title} blueprint: ${waiting} ${waiting === 1 ? 'row waits' : 'rows wait'} for your approval in SPEC.md (${added.section}), `
    + `${added.items.length} starter ${added.items.length === 1 ? 'item' : 'items'} filed${proposed}${added.gate ? `, gate set to ${added.gate}` : ''}`,
  ...laneNotes.map((note) => `  ${note}`),
  ...(added.checksNotRun.length ? [`  checks stored, not run: ${added.checksNotRun.map((id) => `#${id}`).join(', ')}; no check baseline ran, so read each check before work starts: pullboard show <id>`] : []),
  ...sharedRowLines(added).map((line) => `  ${line}`)];
}
