/** Cell-level project fixture: a real Git repo, its policy files and a real SQLite board, with no pullboard init, hooks or CLI [C7]. */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { closeBoard } from '../apps/lib/src/core/native-board.js';
import { fixtureCommittedGraph } from './testkit-fixture.js';
import { openKitBoard } from './testkit-fixture.js';

/** The two-lane policy the e2e project uses, so a converted test keeps the project it asserted against. */
export const CELL_CONFIG = Object.freeze({
  gate: 'true',
  spec: 'SPEC.md',
  verify: 'any',
  lease: '2h',
  landing: { perItem: false, manualOverride: true },
  lanes: { web: { owns: ['web/'], specs: ['G1'] }, api: { owns: ['api/'], specs: ['G2'] } },
  shared: ['docs/'],
});

export const CELL_SPEC = `# Demo spec

## G · Goals
- G1 [approved, must] The page renders. | gate: web test
- G2 [approved, must] The API answers. | gate: api test
`;

/**
 * A private Git repository holding pullboard.json and SPEC.md in one plain commit; git is isolated from the machine.
 * Cleanup goes through `t.after`. No hooks are installed and no `pullboard init` runs.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ config?: object, spec?: string }} [policy] - The pullboard.json object and SPEC.md text; the e2e project's by default.
 * @returns {{ root: string, boardFile: string, commit: string, put: (path: string, body: string) => void, commitAll: () => string }}
 */
export function cellRepo(t, { config = CELL_CONFIG, spec = CELL_SPEC } = {}) {
  const graph = fixtureCommittedGraph('pullboard-cell-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  graph.put('pullboard.json', JSON.stringify(config, null, 2) + '\n');
  graph.put('SPEC.md', spec);
  const commit = graph.commit();
  mkdirSync(join(graph.root, '.git', 'pullboard'), { recursive: true });
  return { root: graph.root, boardFile: join(graph.root, '.git', 'pullboard', 'board.sqlite'), commit, put: graph.put, commitAll: graph.commit };
}

/**
 * Open a real board through the board composition root (never the library front door, which also exports the CLI's main),
 * creating the production schema the way any first open does, and close it after the test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} file - A board.sqlite path, a cellRepo's boardFile, or ':memory:'.
 * @param {{ now: () => Date }} [clock]
 * @param {object} [options] - openBoard options such as gitRoot.
 * @returns {object} The open board.
 */
export function cellBoard(t, file, clock, options) {
  const board = openKitBoard(file, clock, options);
  t.after(() => { try { closeBoard(board); } catch { /* A test that closed it itself already released it. */ } });
  return board;
}

/**
 * Open a board the test closes itself, for tests that reopen a file to prove what persisted.
 *
 * @param {string} file
 * @param {{ now: () => Date }} [clock]
 * @returns {object} The open board.
 */
export function openCellBoard(file, clock) {
  return openKitBoard(file, clock);
}

export { closeBoard as closeCellBoard };
