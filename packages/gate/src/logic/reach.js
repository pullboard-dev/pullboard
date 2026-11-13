/**
 * Package modules that reach the CLI front door in the selection graph [C7]. A packages/ module whose closure
 * holds apps/cli/index.js or apps/cli/src/io/landing/audit.js drags the whole CLI into the closure of every test that reaches
 * it, so no cell closure is real and selection cannot be cell-scoped; a ratchet keeps that reach from growing.
 */

export const CLI_FRONT_DOORS = Object.freeze(['apps/cli/index.js', 'apps/cli/src/io/landing/audit.js']);

const TEST_SIDE = /(?:\.(?:test|spec)\.[cm]?js$|(?:^|\/)(?:test|tests)\/)/u;

/** Whether a path is a product module of a package, never a test or test helper. */
function packageModule(path) {
  return path.startsWith('packages/') && !TEST_SIDE.test(path);
}

/**
 * Every package module that reaches a CLI front door, with one shortest import path to it.
 *
 * @param {{ reverse: Map<string, Iterable<string>> }} graph - A selection graph from codeMapGraph.
 * @returns {Map<string, string[]>} Module to its path, the module first and a front door last.
 */
export function packageCliReach(graph) {
  // A walk back from the front doors names, for each reacher, its next hop toward the nearest door.
  const next = new Map(CLI_FRONT_DOORS.map(door => [door, null]));
  const queue = [...CLI_FRONT_DOORS];
  for (let at = 0; at < queue.length; at += 1) {
    for (const importer of graph.reverse.get(queue[at]) ?? []) {
      if (!next.has(importer)) { next.set(importer, queue[at]); queue.push(importer); }
    }
  }
  const reach = new Map();
  for (const module of [...next.keys()].filter(packageModule).sort()) {
    const path = [module];
    while (next.get(path.at(-1))) path.push(next.get(path.at(-1)));
    reach.set(module, path);
  }
  return reach;
}

/**
 * The package modules that reach a CLI front door at the candidate but did not on main, each with its path.
 *
 * @param {{ reverse: Map<string, Iterable<string>> }} main - The selection graph at main.
 * @param {{ reverse: Map<string, Iterable<string>> }} candidate - The selection graph at the candidate.
 * @returns {{ module: string, path: string[] }[]}
 */
export function newPackageCliReach(main, candidate) {
  const before = packageCliReach(main);
  return [...packageCliReach(candidate)].filter(([module]) => !before.has(module)).map(([module, path]) => ({ module, path }));
}

/**
 * The modules a test closure reaches whose import the selection graph cannot read (a computed import, a CommonJS
 * loader), present at the candidate but not on main, each with the number of test files that reach it. Why: one
 * such module leaves every test that reaches it without a closure key, so landing reruns them all in silence (#5840).
 *
 * @param {{ unknown: Map<string, string> }} main - The selection graph at main.
 * @param {{ unknown: Map<string, string>, reverse: Map<string, Iterable<string>> }} candidate - The graph at the candidate.
 * @param {(path: string) => boolean} isTest - Whether a path is a test file with a closure of its own.
 * @returns {{ module: string, reason: string, tests: number }[]}
 */
export function newKeylessImports(main, candidate, isTest) {
  const rows = [];
  for (const [module, reason] of [...candidate.unknown].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (main.unknown.has(module)) continue;
    const reached = new Set([module]);
    for (const path of reached) for (const importer of candidate.reverse.get(path) ?? []) reached.add(importer);
    const tests = [...reached].filter(isTest).length;
    if (tests) rows.push({ module, reason, tests });
  }
  return rows;
}
