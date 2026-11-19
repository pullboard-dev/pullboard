/**
 * Spec rows of other boards, cited qualified as `<board>:<id>` (e.g. `upgrades:U94`) [C2,S8]. A repo
 * names each other board in pullboard.json `specBoards` ({ "<board>": "<path to its repo or spec>" });
 * a qualified id resolves on that board's spec only, so another board's ids never enter this SPEC.md's
 * namespace and are never aliased into it. Commits that already cite another board's id bare carry a
 * recorded correction in `.pullboard/citations.jsonl`, which spec check reads in place of the header.
 */
import { fileSystemAdapter } from '../../../fs/index.js';
const disk = fileSystemAdapter();
import { join } from 'node:path';
import { resolve } from 'node:path';
import { CONFIG_FILE } from '../../../kernel/browser.js';
import { parseSpec } from '../logic/grammar.js';

export const CITATIONS_FILE = '.pullboard/citations.jsonl';
const BOARD_RE = /^[a-z][a-z0-9]*$/u;
const QUALIFIED_RE = /^([a-z][a-z0-9]*):([A-Za-z]+\d+(?:\.\d+)*)$/u;

/**
 * The board name and row id of a qualified citation, or null for a bare id or `doctrine:<id>`.
 *
 * @param {string} id
 * @returns {{ board: string, id: string } | null}
 */
export function qualifiedId(id) {
  const match = QUALIFIED_RE.exec(id);
  return match && match[1] !== 'doctrine' ? { board: match[1], id: match[2] } : null;
}

/**
 * Each board pullboard.json `specBoards` names, with its parsed spec, or spec null when the path is
 * not on this machine (spec check warns; it cannot resolve what it cannot read). A path is relative
 * to this repo's root and names either the other repo, whose pullboard.json `spec` (or SPEC.md) is
 * read, or its spec file directly.
 *
 * @param {string} root
 * @param {Record<string, string> | undefined} declared
 * @returns {Map<string, { name: string, path: string, spec: ReturnType<typeof parseSpec> | null }>}
 */
export function loadSpecBoards(root, declared) {
  const boards = new Map();
  for (const [name, path] of Object.entries(declared ?? {})) {
    if (!BOARD_RE.test(name) || name === 'doctrine' || typeof path !== 'string') continue;
    boards.set(name, { name, path, spec: readBoardSpec(resolve(root, path)) });
  }
  return boards;
}

/** Parse the spec at a repo folder or a spec file; null when it is not readable here. */
function readBoardSpec(path) {
  if (!disk.exists(path)) return null;
  let file = path;
  if (disk.stat(path).isDirectory()) {
    let name = 'SPEC.md';
    try { name = JSON.parse(disk.readFile(join(path, CONFIG_FILE), 'utf8')).spec ?? name; } catch { /* no config: SPEC.md */ }
    file = join(path, name);
  }
  if (!disk.exists(file)) return null;
  return parseSpec(disk.readFile(file, 'utf8'), { strictGrammarVersion: false });
}

/**
 * Problems with one qualified citation: an undeclared board, or a row its board's spec lacks or has
 * cut. A declared board whose spec is not on this machine has none; spec check warns about it.
 *
 * @param {{ boards?: Map<string, { spec: any }> }} spec - this repo's loaded spec
 * @param {string} id - a `<board>:<id>` citation
 * @returns {string[]}
 */
export function qualifiedIdProblems(spec, id) {
  const parts = qualifiedId(id);
  const board = parts && spec.boards?.get(parts.board);
  if (!board) return [`${id} uses an unknown namespace; use doctrine:<id> for a doctrine row, or <board>:<id> for a board named in pullboard.json specBoards`];
  if (!board.spec) return [];
  const row = board.spec.rows.find((entry) => entry.id === parts.id);
  if (!row) return [`${id} is not in the ${parts.board} board's spec`];
  if (row.status === 'retired') return [`${id} is retired`];
  if (row.status === 'wont') return [`${id} is marked won't build; the person reopens it first`];
  return [];
}

/**
 * The recorded citation corrections: each names a commit (full sha), the bare id its header cites,
 * and the qualified id it means. A line that does not parse, or that maps onto a bare id, is a problem,
 * because a correction may only qualify a citation, never alias it into this spec.
 *
 * @param {string} root
 * @returns {{ corrections: { commit: string, cites: string, means: string }[], problems: string[] }}
 */
export function readCitationCorrections(root) {
  const file = join(root, CITATIONS_FILE);
  if (!disk.exists(file)) return { corrections: [], problems: [] };
  const corrections = [];
  const problems = [];
  disk.readFile(file, 'utf8').split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { record = null; }
    if (!record || !/^[0-9a-f]{40}$/u.test(record.commit ?? '') || typeof record.cites !== 'string' || !qualifiedId(record.means ?? '')) {
      problems.push(`${CITATIONS_FILE}:${index + 1} needs {"commit":"<full sha>","cites":"<id>","means":"<board>:<id>"}`);
      return;
    }
    corrections.push({ commit: record.commit, cites: record.cites, means: record.means });
  });
  return { corrections, problems };
}

/**
 * The ids a commit cites after its recorded corrections: a corrected bare id reads as the qualified
 * id it means.
 *
 * @param {string} commit - the commit's sha, full or abbreviated
 * @param {string[]} ids - the ids its message cites
 * @param {{ commit: string, cites: string, means: string }[]} corrections
 * @returns {string[]}
 */
export function correctedCitations(commit, ids, corrections) {
  return ids.map((id) => corrections.find((entry) => entry.commit.startsWith(commit) && entry.cites === id)?.means ?? id);
}
