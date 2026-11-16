/**
 * The proof audit of the spec rows, S1 to S9 (item #57): for each row, one or more changes to src/
 * that break the row's rule, and the tagged test that must go red under each. The harness works on a
 * temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/spec-mutants.mjs
 */
import { audit } from './harness.mjs';

const PARSE = ['apps/cli/journeys/spec/main.test.js', 'rows parse with id, status, tier, text, gate, serves'];
const NEVER_DROPPED = ['apps/cli/journeys/spec/main.test.js', 'a row-like line that does not parse is an error'];
const UNIQUE = ['apps/cli/journeys/spec/main.test.js', 'ids are unique, retired ones included'];
const SERVES = ['apps/cli/journeys/spec/main.test.js', 'serves links must name real ids and never cycle'];
const GATES = ['apps/cli/journeys/spec/main.test.js', 'approved must-rows name their gate'];
const SIGNOFF = ['apps/cli/journeys/spec/main.test.js', 'a sign-off holds the text it approved'];
const BOTH_FILES = ['apps/cli/journeys/merged/e2e.test.js', 'spec check lints both files'];
const ONE_PAGE = ['apps/cli/journeys/view/main.test.js', 'one self-contained page with every tab and inherited doctrine row'];
const PERMANENT = ['apps/cli/journeys/spec/main.test.js', 'an id once committed or cited never leaves the spec'];
const DELETED = ['apps/cli/journeys/spec/e2e/next.test.js', 'a deleted spec row is refused at commit'];
const WONT = ['apps/cli/journeys/spec/main.test.js', 'a row marked wont stays with its id'];
const ROW_PARSED = '      spec.rows.push({ id, status, tier: tier ?? \'\', ...fields, section: section.name, line: lineNo });';

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['S1', 'a row that does not parse is dropped silently', [['packages/spec/src/logic/grammar.js', "      spec.problems.push({ line: lineNo, message: 'row does not parse: - ID [status, tier] text | gate: ... | serves: ...' });\n", '']], NEVER_DROPPED, 'red'],
  ['S1', 'a row loses what it serves', [['packages/spec/src/logic/grammar.js', ROW_PARSED, "      spec.rows.push({ id, status, tier: tier ?? '', ...fields, serves: [], section: section.name, line: lineNo });"]], PARSE, 'red'],
  ['S1', 'a row loses its gate', [['packages/spec/src/logic/grammar.js', ROW_PARSED, "      spec.rows.push({ id, status, tier: tier ?? '', ...fields, gate: '', section: section.name, line: lineNo });"]], PARSE, 'red'],
  ['S2', 'a duplicate id passes', [['packages/spec/src/io/main.js', '    if (seen.has(row.id)) {', '    if (false) {']], UNIQUE, 'red'],
  ['S2', "a new row may reuse a retired row's id", [['packages/spec/src/io/main.js', '    } else seen.set(row.id, row.line);', "    } else if (row.status !== 'retired') seen.set(row.id, row.line);"]], UNIQUE, 'red'],
  ['S2', 'a retired row may repeat a live id', [['packages/spec/src/io/main.js', '    if (seen.has(row.id)) {', "    if (seen.has(row.id) && row.status !== 'retired') {"]], UNIQUE, 'red'],
  ['S3', 'serves may name an id the spec lacks', [['packages/spec/src/io/main.js', '      if (!seen.has(target) && !spec.rows.some((other) => other.id === target)) {', '      if (false) {']], SERVES, 'red'],
  ['S3', 'serves links may cycle', [['packages/spec/src/io/main.js', '  if (cycle) {', '  if (false) {']], SERVES, 'red'],
  ['S4', 'an approved must-row may leave out its gate', [['packages/spec/src/io/main.js', "  if (row.status === 'approved' && row.tier === 'must' && !row.gate) {", '  if (false) {']], GATES, 'red'],
  ['S5', 'a sign-off counts whatever the row says now', [['packages/spec/src/io/main.js', '    if (textOf.get(signoff.id) === signoff.text) standing.met.push(signoff);', '    if (true) standing.met.push(signoff);']], SIGNOFF, 'red'],
  ['S5', 'a sign-off records no text', [['packages/spec/src/io/main.js', 'JSON.stringify({ id, by, on: on.slice(0, 10), text: byId.get(id).text, ...(note ? { note } : {}) })', 'JSON.stringify({ id, by, on: on.slice(0, 10), ...(note ? { note } : {}) })']], SIGNOFF, 'red'],
  ['S5', 'a row that is not approved can be signed', [['packages/spec/src/io/main.js', "    return row.status === 'approved' ? [] : [`${id} is ${row.status}; only approved rows are signed`];", '    return [];']], SIGNOFF, 'red'],
  ['S6', 'spec check lints SPEC.md only', [['apps/cli/src/io/commands/spec.js', 'const files = [[ctx.config.spec, spec], ...(practice.exists ? [[practice.name, practice]] : [])];', 'const files = [[ctx.config.spec, spec]];']], BOTH_FILES, 'red'],
  ['S7', 'the page leaves out its practice tab', [['apps/view/src/logic/main.js', '<label for="t-practice">Doctrine</label>', '']], ONE_PAGE, 'red'],
  ['S8', 'a committed id may leave the spec', [['packages/spec/src/io/main.js', "    .filter(([id]) => !present.has(id))\n    .map(([id, commit]) => ({", "    .filter(() => false)\n    .map(([id, commit]) => ({"]], PERMANENT, 'red'],
  ['S8', 'an id cited but never committed passes', [['packages/spec/src/io/main.js', '    if (!present.has(id) && !committed.has(id)) {', '    if (false) {']], PERMANENT, 'red'],
  ['S8', 'commit lets a row be deleted', [['packages/spec/src/io/main.js', '  return parseSpec(before, { strictGrammarVersion: false }).rows.map((row) => row.id).filter((id) => !kept.has(id));', '  return [];']], DELETED, 'red'],
  ['S9', 'a wont row can be cited', [['packages/spec/src/io/main.js', "    if (row.status === 'wont') return [`${id} is marked won't build; the person reopens it first`];", '']], WONT, 'red'],
  ['S9', 'a wont row counts as unmet', [['packages/spec/src/io/main.js', "      row.status === 'approved' &&\n      (!mustOnly || row.tier === 'must') &&", "      row.status !== 'retired' &&\n      (!mustOnly || row.tier === 'must') &&"]], WONT, 'red'],
];

audit(MUTANTS);
