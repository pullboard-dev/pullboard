/** A landing gate-step harness: the state gateGroup needs, built over a real git project and board [C7,#3974]. */
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { landingPorts } from './ports.js';
import {
  fileFixtureItem,
  openKitBoard,
} from '../testkit.js';
import { gateGroup } from '../../../../../packages/landing/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { headTree } from '../../../../../packages/git/index.js';

/** The passing JUnit document the fixture gate writes: one testcase and no failure or error child. */
export const PASSING_JUNIT = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="0"><testsuite name="suite" tests="1" failures="0"><testcase classname="suite" name="passes [C7]" time="0.001"/></testsuite></testsuites>\n';

/**
 * Build the landing state one gate step needs: a board holding a batch item, the project's git root, a smoked tree, the
 * landing ports, a recording write service and the runner services. `config.junitReport` names the report the gate writes.
 * Why a harness: gateGroup is only reachable with this whole state, so each case would otherwise rebuild it by hand.
 *
 * @param {any} helpers - createE2eHelpers() result
 * @param {{ report?: string, junitReport?: string }} [options] - the JUnit text the gate writes and the config key naming it
 */
export function landingStep(helpers, { report = PASSING_JUNIT, junitReport = 'junit.xml' } = {}) {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(junitReport)}, ${JSON.stringify(report)})`;
  const box = helpers.project(`node -e ${JSON.stringify(script)}`, helpers.sandbox(), { withWorktree: false });
  delete box.env.NODE_TEST_CONTEXT;
  // The report is a build output, so git ignores it and the gate leaves the landing checkout clean.
  writeFileSync(join(box.repo, '.gitignore'), `${junitReport}\n`);
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: ignore the junit report');
  const root = box.repo;
  const id = fileFixtureItem(box, root, { lane: 'web', title: 'Landing step fixture item' }).item_id;
  const board = openKitBoard(join(root, '.git/pullboard/board.sqlite'));
  const config = { ...JSON.parse(readFileSync(join(root, 'pullboard.json'), 'utf8')), junitReport, affectedTests: null, registryGuards: [], submitInvariants: [] };
  const commit = headCommit(root);
  const writes = [];
  const lines = [];
  const state = { board, config, root,
    batch: { version: 1, id: randomUUID(), state: 'merging', root, base: commit, tip: commit, branch: 'refs/heads/main', owner: 'coordinator-fixture', items: [{ id, commit }], revision: 0 },
    gates: new Map(), smoked: new Set([headTree(root)]), landingPorts, say: line => lines.push(line),
    write: async (operation, [args]) => { writes.push(operation); return args.batch ? { ...args.batch, revision: args.revision + 1 } : args; } };
  mkdirSync(join(box.dir, 'logs'), { recursive: true });
  return { ...box, state, writes, lines,
    /** Run one landing gate group against the built state. */
    run: (label = 'group') => gateGroup(state, label, {}),
    close: () => board.db.close() };
}
