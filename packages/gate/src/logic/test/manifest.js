/** Classify test files into the registry's kinds from their path and spawn evidence, purely [C7]. */

export const TEST_KINDS = ['cell unit', 'contract', 'journey', 'harness'];

const HARNESS = /(?:^|[/.-])(?:fixtures?|harness|testkit)(?:[/.-]|$)/u;
const JOURNEY = /(?:^|\/)journeys\//u;
const CELL_TESTS = /^(?:packages|apps)\/[^/]+\/tests?\//u;

/**
 * The kind of one test file and the rule that chose it.
 * Why: each kind has its own standard, so the rule is recorded and a wrong kind is visible, not silent.
 *
 * @param {{ file: string, spawns: { process: boolean, browser: boolean, board: boolean } }} row
 * @returns {{ kind: string, because: string }}
 */
export function testKind({ file, spawns }) {
  if (HARNESS.test(file)) return { kind: 'harness', because: 'tests a shared fixture' };
  if (JOURNEY.test(file)) return { kind: 'journey', because: 'lives under journeys/' };
  const outside = spawns.process || spawns.browser;
  if (!CELL_TESTS.test(file)) return outside ? { kind: 'journey', because: 'outside a cell and starts a process or browser' } : { kind: 'cell unit', because: 'outside a cell and starts nothing' };
  if (outside || spawns.board) return { kind: 'contract', because: 'in a cell and reaches git, a process, a browser or the board' };
  return { kind: 'cell unit', because: 'in a cell and starts nothing' };
}

/**
 * Turn per-file evidence into sorted manifest rows.
 *
 * @param {{ file: string, ms: number|null, specs?: string[], direct: Set<string>, via: Map<string, Set<string>> }[]} inputs
 * @returns {object[]} one row per file, sorted by file
 */
export function manifestRows(inputs) {
  return inputs.map(({ file, ms, specs = [], direct, via }) => {
    const started = category => direct.has(category) || [...via.values()].some(found => found.has(category));
    const spawns = {
      process: started('process') || started('runner'),
      browser: started('browser'),
      board: started('board'),
      direct: direct.has('process') || direct.has('runner') || direct.has('browser'),
      via: [...via].filter(([, found]) => found.has('process') || found.has('runner') || found.has('browser')).map(([path]) => path).sort(),
    };
    const { kind, because } = testKind({ file, spawns });
    return { file, kind, because, specs, unproven: specs.length === 0, cost: { ms }, spawns };
  }).sort((a, b) => (a.file < b.file ? -1 : 1));
}
