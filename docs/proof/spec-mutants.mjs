/**
 * The proof audit of the spec rows, S1 to S9 (item #57): for each row, one or more changes to src/
 * that break the row's rule, and the tagged test that must go red under each. The harness works on a
 * temporary copy, never a real checkout.
 *
 * Run it from the repo root: node docs/proof/spec-mutants.mjs
 */
import { audit } from './harness.mjs';

const PARSE = ['test/spec.test.js', 'rows parse with id, status, tier, text, gate, serves'];
const NEVER_DROPPED = ['test/spec.test.js', 'a row-like line that does not parse is an error'];
const UNIQUE = ['test/spec.test.js', 'ids are unique, retired ones included'];
const SERVES = ['test/spec.test.js', 'serves links must name real ids and never cycle'];
const GATES = ['test/spec.test.js', 'approved must-rows name their gate'];
const SIGNOFF = ['test/spec.test.js', 'a sign-off holds the text it approved'];
const BOTH_FILES = ['test/e2e.test.js', 'spec check lints both files'];
const ONE_PAGE = ['test/view.test.js', 'one self-contained page with every tab and every row'];
const PERMANENT = ['test/spec.test.js', 'an id once committed or cited never leaves the spec'];
const DELETED = ['test/e2e.test.js', 'a deleted spec row is refused at commit'];
const WONT = ['test/spec.test.js', 'a row marked wont stays with its id'];
const ROW_PARSED = '      spec.rows.push({ id, status, tier: tier ?? \'\', ...fields, section: section.name, line: lineNo });';

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['S1', 'a row that does not parse is dropped silently', [['src/spec.js', "      spec.problems.push({ line: lineNo, message: 'row does not parse: - ID [status, tier] text | gate: ... | serves: ...' });\n", '']], NEVER_DROPPED, 'red'],
  ['S1', 'a row loses what it serves', [['src/spec.js', ROW_PARSED, "      spec.rows.push({ id, status, tier: tier ?? '', ...fields, serves: [], section: section.name, line: lineNo });"]], PARSE, 'red'],
  ['S1', 'a row loses its gate', [['src/spec.js', ROW_PARSED, "      spec.rows.push({ id, status, tier: tier ?? '', ...fields, gate: '', section: section.name, line: lineNo });"]], PARSE, 'red'],
  ['S2', 'a duplicate id passes', [['src/spec.js', '    if (seen.has(row.id)) {', '    if (false) {']], UNIQUE, 'red'],
  ['S2', "a new row may reuse a retired row's id", [['src/spec.js', '    } else seen.set(row.id, row.line);', "    } else if (row.status !== 'retired') seen.set(row.id, row.line);"]], UNIQUE, 'red'],
  ['S2', 'a retired row may repeat a live id', [['src/spec.js', '    if (seen.has(row.id)) {', "    if (seen.has(row.id) && row.status !== 'retired') {"]], UNIQUE, 'red'],
  ['S3', 'serves may name an id the spec lacks', [['src/spec.js', '      if (!seen.has(target) && !spec.rows.some((other) => other.id === target)) {', '      if (false) {']], SERVES, 'red'],
  ['S3', 'serves links may cycle', [['src/spec.js', '  if (cycle) {', '  if (false) {']], SERVES, 'red'],
  ['S4', 'an approved must-row may leave out its gate', [['src/spec.js', "  if (row.status === 'approved' && row.tier === 'must' && !row.gate) {", '  if (false) {']], GATES, 'red'],
  ['S5', 'a sign-off counts whatever the row says now', [['src/spec.js', '    if (textOf.get(signoff.id) === signoff.text) standing.met.push(signoff);', '    if (true) standing.met.push(signoff);']], SIGNOFF, 'red'],
  ['S5', 'a sign-off records no text', [['src/spec.js', 'JSON.stringify({ id, by, on, text: byId.get(id).text })', 'JSON.stringify({ id, by, on })']], SIGNOFF, 'red'],
  ['S5', 'a row that is not approved can be signed', [['src/spec.js', "    return row.status === 'approved' ? [] : [`${id} is ${row.status}; only approved rows are signed`];", '    return [];']], SIGNOFF, 'red'],
  ['S6', 'spec check lints SPEC.md only', [['src/cli.js', 'const files = [[ctx.config.spec, spec], ...(practice.exists ? [[ctx.config.practice, practice]] : [])];', 'const files = [[ctx.config.spec, spec]];']], BOTH_FILES, 'red'],
  ['S7', 'the page leaves out its practice tab', [['src/view.js', '<label for="t-practice">Practice</label>', '']], ONE_PAGE, 'red'],
  ['S8', 'a committed id may leave the spec', [['src/spec.js', "    .filter(([id]) => !present.has(id))\n    .map(([id, commit]) => ({", "    .filter(() => false)\n    .map(([id, commit]) => ({"]], PERMANENT, 'red'],
  ['S8', 'an id cited but never committed passes', [['src/spec.js', '    if (!present.has(id) && !committed.has(id)) {', '    if (false) {']], PERMANENT, 'red'],
  ['S8', 'commit lets a row be deleted', [['src/spec.js', '  return parseSpec(before).rows.map((row) => row.id).filter((id) => !kept.has(id));', '  return [];']], DELETED, 'red'],
  ['S9', 'a wont row can be cited', [['src/spec.js', "    if (row.status === 'wont') return [`${id} is marked won't build; the person reopens it first`];", '']], WONT, 'red'],
  ['S9', 'a wont row counts as unmet', [['src/spec.js', "      row.status === 'approved' &&\n      (!mustOnly || row.tier === 'must') &&", "      row.status !== 'retired' &&\n      (!mustOnly || row.tier === 'must') &&"]], WONT, 'red'],
];

audit(MUTANTS);
