/** Classify test files into the registry's kinds from their path and spawn evidence, purely [C7]. */

export const TEST_KINDS = ['cell unit', 'contract', 'journey', 'harness'];
export const JOURNEY_TAGS = ['keep', 'convert', 'delete'];

const GOLDEN = new Set(['init', 'add', 'next', 'submit', 'verify', 'land', 'release', 'upgrade']);

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
 * The golden user path a journey file walks, or null: the folder under journeys/ names the path, and relay and view
 * count only for the pairing and opening files inside them.
 * Why: a simple, visible rule, since the tags are a proposal the freeze script applies later [C7].
 *
 * @param {string} file journey path
 * @returns {string|null} the golden path name
 */
export function goldenPath(file) {
  const [, area, name] = /(?:^|\/)journeys\/([^/]+)\/(.*)$/u.exec(file) ?? [];
  if (!area) return null;
  if (GOLDEN.has(area)) return area;
  if (area === 'relay' && /pair/u.test(name)) return 'relay pair';
  if (area === 'view' && /open/u.test(name)) return 'view open';
  return null;
}

/**
 * Tag each journey row keep, convert or delete, with the rule that chose it.
 * Keep when it walks a golden path. Delete only when every spec id it cites is also cited by a non-journey test, so
 * another test proves the same ids. Everything else converts, as does a journey that cites none, since nothing else proves it [C7].
 *
 * @param {object[]} rows manifest rows with kind and specs
 * @returns {object[]} the rows, journeys now carrying tag and tagBecause
 */
export function tagJourneys(rows) {
  const proven = new Set(rows.filter(row => row.kind !== 'journey').flatMap(row => row.specs));
  return rows.map(row => {
    if (row.kind !== 'journey') return row;
    const path = goldenPath(row.file);
    if (path) return { ...row, tag: 'keep', tagBecause: `walks the golden path ${path}` };
    if (row.specs.length && row.specs.every(id => proven.has(id))) return { ...row, tag: 'delete', tagBecause: 'every spec id it cites is also cited by a cell unit or contract test' };
    return { ...row, tag: 'convert', tagBecause: row.specs.length ? 'cites a spec id no cell unit or contract test cites' : 'cites no spec id, so nothing else proves it' };
  });
}

/**
 * Turn per-file evidence into sorted manifest rows.
 *
 * @param {{ file: string, ms: number|null, specs?: string[], direct: Set<string>, via: Map<string, Set<string>> }[]} inputs
 * @returns {object[]} one row per file, sorted by file
 */
export function manifestRows(inputs) {
  return tagJourneys(inputs.map(({ file, ms, specs = [], direct, via }) => {
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
  }).sort((a, b) => (a.file < b.file ? -1 : 1)));
}
