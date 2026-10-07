/**
 * The proof that the README's figures hold (item #72: I10, M1). Each change below breaks one of
 * their rules, and its test must go red. The harness works on a temporary copy, never a real
 * checkout.
 *
 * Run it from the repo root: node docs/proof/readme-mutants.mjs
 */
import { audit } from './harness.mjs';

const LINKED = ['test/readme.test.js', 'the README links every figure draw.mjs draws'];
const CARD = ['test/readme.test.js', 'each figure carries its own light and dark colors'];
const DECLARED = ['test/readme.test.js', 'the lifecycle figure is drawn from the declaration'];
const LAYOUT_ALT =
  '![Where things live. The main checkout is the coordinator and holds SPEC.md, PRACTICE.md, pullboard.json, AGENTS.md and the git hooks. Inside .git, shared by every worktree, are the board and the pinned submitted commits. Beside it, each agent works in its own worktree, builders in their lanes and a verifier, all on the same board. pullboard view lists every project on this machine.](';

/** Row, the change, its edits as [file, from, to], the test that judges it, and the outcome expected. */
const MUTANTS = [
  ['I10', 'a committed figure drifts from what draw.mjs draws', [['docs/img/loop.svg', '>a reject sends it back<', '>a reject sends it home<']], LINKED, 'red'],
  ['I10', 'the README links a figure draw.mjs does not draw', [['README.md', '](docs/img/layout.svg)', '](docs/img/layout.png)']], LINKED, 'red'],
  ['I10', 'a figure says nothing to a reader who cannot see it', [['README.md', LAYOUT_ALT, '![figure](']], LINKED, 'red'],
  ['I10', 'the figures have no dark colors', [['docs/img/draw.mjs', '@media (prefers-color-scheme: dark) {', '@media print {']], CARD, 'red'],
  ['I10', 'the card does not cover the figure', [['docs/img/draw.mjs', '<rect class="card" x="0.5" y="0.5"', '<rect class="card" x="40" y="0.5"']], CARD, 'red'],
  ['I10', 'a label runs off the card', [['docs/img/draw.mjs', "text(452, 158, 'a reject sends it back', 'label back')", "text(752, 158, 'a reject sends it back', 'label back')"]], CARD, 'red'],
  ['M1', 'a state is left out of the lifecycle', [['docs/img/draw.mjs', '  for (const state of machine.states) {\n    const [x, y] = PLACES[state.id];', "  for (const state of machine.states.filter((each) => each.id !== 'withdrawn')) {\n    const [x, y] = PLACES[state.id];"]], DECLARED, 'red'],
  ['M1', 'a move between two states is not named', [['docs/img/draw.mjs', '    if (!route.label) continue;', "    if (!route.label || key === 'submitted>open') continue;"]], DECLARED, 'red'],
  ['M1', 'a move that keeps a state is not named', [['docs/img/draw.mjs', "sub: keeps ? `↻ ${keeps.join(' · ')}` : undefined", 'sub: undefined']], DECLARED, 'red'],
  ['M1', 'the final states are not marked', [['docs/img/draw.mjs', 'final: state.final ? state.id : undefined', 'final: undefined']], DECLARED, 'red'],
  ['M1', 'the refusals into a final state are left out', [['docs/img/draw.mjs', "    codes.forEach((code, i) => body.push(text(note.x + 12, note.y + 38 + i * 16, code, 'code mono')));\n", '']], DECLARED, 'red'],
  ['M1', 'a state with no place is left out, not refused', [['docs/img/draw.mjs', '    if (!PLACES[state.id]) throw new Error(', '    if (false) throw new Error(']], DECLARED, 'red'],
  ['M1', 'a pair of states with no route is left out, not refused', [['docs/img/draw.mjs', '      if (from !== move.to && !ROUTES[key]) throw new Error(', '      if (false) throw new Error(']], DECLARED, 'red'],
];

audit(MUTANTS);
