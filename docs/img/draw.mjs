/**
 * The README's figures, drawn as SVG (I10). Each one is a card that carries its own light and dark
 * colors, so it reads on GitHub, on npm and in an editor's preview alike. The lifecycle is drawn
 * from src/machine.js, the one declaration of every state and move (M1): a state or a pair of
 * states this file has no place for is refused, never left out.
 *
 * After changing a figure or the lifecycle, redraw them from the repo root: node docs/img/draw.mjs
 * test/readme.test.js fails while a committed figure differs from what this draws.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MACHINE } from '../../src/machine.js';

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

/** One palette for every figure: light first, then the dark block that swaps it. */
const STYLE = `
text { font-family: ${SANS}; fill: #1f2328; }
.mono { font-family: ${MONO}; }
.card { fill: #ffffff; stroke: #d1d9e0; }
.head { font-size: 14px; font-weight: 600; }
.aside { font-size: 12px; fill: #59636e; }
.t1 { font-size: 14px; font-weight: 600; }
.t2 { font-size: 12px; fill: #59636e; }
.label { font-size: 12px; fill: #59636e; }
.code { font-size: 11.5px; fill: #59636e; }
.edge { fill: none; stroke: #8c959f; stroke-width: 1.5; }
.edge.back { stroke: #bc4c00; stroke-dasharray: 5 4; }
.edge.leader { stroke-width: 1; stroke-dasharray: 2 3; }
.tip { fill: #8c959f; }
.tip.back { fill: #bc4c00; }
.label.back { fill: #bc4c00; }
.frame { fill: none; stroke: #d1d9e0; stroke-dasharray: 4 4; }
.plain rect { fill: #f6f8fa; stroke: #d1d9e0; }
.person rect { fill: #ddf4ff; stroke: #54aeff; }
.person .t1 { fill: #0a3069; } .person .t2 { fill: #0550ae; }
.agent rect { fill: #fbefff; stroke: #c297ff; }
.agent .t1 { fill: #3e1f79; } .agent .t2 { fill: #6639ba; }
.check rect { fill: #fff8c5; stroke: #d4a72c; }
.check .t1 { fill: #4d2d00; } .check .t2 { fill: #7d4e00; }
.done rect { fill: #dafbe1; stroke: #4ac26b; }
.done .t1 { fill: #044f1e; } .done .t2 { fill: #116329; }
@media (prefers-color-scheme: dark) {
  text { fill: #f0f6fc; }
  .card { fill: #0d1117; stroke: #3d444d; }
  .aside, .t2, .label, .code { fill: #9198a1; }
  .edge { stroke: #6e7681; }
  .edge.back { stroke: #f0883e; }
  .tip { fill: #6e7681; }
  .tip.back, .label.back { fill: #f0883e; }
  .frame { stroke: #3d444d; }
  .plain rect { fill: #151b23; stroke: #3d444d; }
  .person rect { fill: #0c2d6b; stroke: #1f6feb; }
  .person .t1 { fill: #cae8ff; } .person .t2 { fill: #a5d6ff; }
  .agent rect { fill: #271052; stroke: #8957e5; }
  .agent .t1 { fill: #ecdeff; } .agent .t2 { fill: #d2a8ff; }
  .check rect { fill: #272115; stroke: #9e6a03; }
  .check .t1 { fill: #f8e3a1; } .check .t2 { fill: #e3b341; }
  .done rect { fill: #04260f; stroke: #238636; }
  .done .t1 { fill: #aff5b4; } .done .t2 { fill: #7ee787; }
}`;

const esc = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * A whole figure: its size, the words a screen reader says for it, and what is drawn on its card.
 *
 * @param {{ width: number, height: number, title: string, desc: string, body: string[] }} figure
 * @returns {string}
 */
function figure({ width, height, title, desc, body }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc>`,
    `<style>${STYLE}\n</style>`,
    '<defs>',
    '<marker id="tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="tip" d="M0 1 L9 5 L0 9 z"/></marker>',
    '<marker id="tip-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="tip back" d="M0 1 L9 5 L0 9 z"/></marker>',
    '</defs>',
    `<rect class="card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12"/>`,
    ...body,
    '</svg>',
    '',
  ].join('\n');
}

/**
 * A text line. `anchor` is start, middle or end; `cls` its classes.
 *
 * @param {number} x
 * @param {number} y
 * @param {string} words
 * @param {string} cls
 * @param {string} [anchor]
 */
const text = (x, y, words, cls, anchor = 'start') => `<text class="${cls}" x="${x}" y="${y}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}>${esc(words)}</text>`;

/**
 * A box with a title and an optional second line, centred. A stack draws two cards behind it, for
 * work several agents do at once; `final` draws a second border inside, for a state nothing leaves.
 *
 * @param {{ x: number, y: number, w: number, h: number, kind: string, title: string, sub?: string, mono?: boolean, stack?: boolean, final?: string }} box
 * @returns {string}
 */
function box({ x, y, w, h, kind, title, sub, mono = false, stack = false, final }) {
  const cx = x + w / 2;
  const behind = stack ? [10, 5].map((d) => `<rect x="${x + d}" y="${y - d}" width="${w}" height="${h}" rx="8"/>`).join('') : '';
  const inner = final ? `<rect x="${x + 4}" y="${y + 4}" width="${w - 8}" height="${h - 8}" rx="5" fill="none"/>` : '';
  const lines = sub
    ? [text(cx, y + h / 2 - 4, title, `t1${mono ? ' mono' : ''}`, 'middle'), text(cx, y + h / 2 + 14, sub, 't2', 'middle')]
    : [text(cx, y + h / 2 + 5, title, `t1${mono ? ' mono' : ''}`, 'middle')];
  return `<g class="${kind}"${final ? ` data-final="${esc(final)}"` : ''}>${behind}<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${inner}${lines.join('')}</g>`;
}

/**
 * A connector: a polyline through `points`, with an arrowhead unless `tip` is false.
 *
 * @param {number[][]} points
 * @param {{ back?: boolean, tip?: boolean, leader?: boolean }} [options]
 */
function edge(points, { back = false, tip = true, leader = false } = {}) {
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const cls = `edge${back ? ' back' : ''}${leader ? ' leader' : ''}`;
  return `<path class="${cls}" d="${d}"${tip ? ` marker-end="url(#${back ? 'tip-back' : 'tip'})"` : ''}/>`;
}

/** How a piece of work moves: from the rows the person approves to a merge, and back on a reject. */
export function drawLoop() {
  const W = 200;
  const H = 64;
  return figure({
    width: 840,
    height: 290,
    title: 'How work moves',
    desc: 'You approve spec rows. Each item freezes its bar when an agent claims it. Builders, one per lane, build in their own worktrees; the gate must be green at the commit they submit. A second agent verifies that commit: an accept merges with its receipt, a reject sends the work back to the builder with the reason.',
    body: [
      text(24, 34, 'How work moves', 'head'),
      box({ x: 40, y: 62, w: W, h: H, kind: 'person', title: 'You decide', sub: 'the rows of SPEC.md' }),
      box({ x: 320, y: 62, w: W, h: H, kind: 'plain', title: 'An item', sub: 'its bar frozen at claim' }),
      box({ x: 600, y: 62, w: W, h: H, kind: 'agent', title: 'Builders', sub: 'one per lane, own worktree', stack: true }),
      box({ x: 600, y: 200, w: W, h: H, kind: 'check', title: 'The gate', sub: 'tests green at the commit' }),
      box({ x: 320, y: 200, w: W, h: H, kind: 'agent', title: 'A verifier', sub: 'a second agent checks it' }),
      box({ x: 40, y: 200, w: W, h: H, kind: 'done', title: 'Merged', sub: 'with its receipt' }),
      edge([[240, 94], [316, 94]]),
      edge([[520, 94], [596, 94]]),
      edge([[700, 126], [700, 196]]),
      edge([[600, 232], [524, 232]]),
      edge([[320, 232], [244, 232]]),
      edge([[440, 200], [440, 166], [650, 166], [650, 140]], { back: true }),
      text(452, 158, 'a reject sends it back', 'label back'),
    ],
  });
}

/** Where each state sits, by id. A state missing here is refused, never left out. */
const PLACES = {
  open: [25, 150],
  claimed: [235, 150],
  submitted: [445, 150],
  verified: [655, 150],
  withdrawn: [445, 284],
};

/**
 * How the moves between each pair of states are drawn: the path, where its verbs go, and whether
 * it leads back. A pair of states missing here is refused. Moves that keep a state are written in
 * its box instead, after a ↻.
 */
const ROUTES = {
  'open>claimed': { points: [[185, 179], [231, 179]], label: [208, 171, 'middle'] },
  'claimed>submitted': { points: [[395, 179], [441, 179]], label: [418, 171, 'middle'] },
  'submitted>verified': { points: [[605, 179], [651, 179]], label: [628, 171, 'middle'] },
  'claimed>open': { points: [[335, 150], [335, 120], [145, 120], [145, 146]], back: true, label: [240, 94, 'middle'], wrap: 2 },
  'submitted>open': { points: [[545, 150], [545, 66], [115, 66], [115, 146]], back: true, label: [330, 58, 'middle'] },
  'open>withdrawn': { points: [[105, 208], [105, 313], [441, 313]], label: [210, 305, 'middle'] },
  'claimed>withdrawn': { points: [[315, 208], [315, 313]], tip: false },
  'submitted>withdrawn': { points: [[525, 208], [525, 280]] },
};

/** Where the guards every move into a final state passes are listed, by state id. */
const GUARD_NOTES = {
  verified: { x: 640, y: 26, w: 176, leader: [[735, 122], [735, 146]] },
  withdrawn: { x: 640, y: 284, w: 176, leader: [[640, 313], [609, 313]] },
};

/**
 * Split words joined by ' · ' into `count` lines, as evenly as their order allows.
 *
 * @param {string[]} words
 * @param {number} count
 * @returns {string[]}
 */
function wrapped(words, count) {
  const size = Math.ceil(words.length / count);
  return Array.from({ length: Math.ceil(words.length / size) }, (_, i) => words.slice(i * size, (i + 1) * size).join(' · '));
}

/**
 * An item's life, drawn from the lifecycle declaration: every state, every move's verb between
 * each pair of states, the moves that keep a state, the final states, and the refusals every move
 * into a final state can raise.
 *
 * @param {any} [machine]
 * @returns {string}
 */
export function drawLifecycle(machine = MACHINE) {
  const W = 160;
  const H = 58;
  for (const state of machine.states) {
    if (!PLACES[state.id]) throw new Error(`no place for state ${state.id}: add it to PLACES in docs/img/draw.mjs`);
  }
  /** @type {Map<string, string[]>} */
  const verbs = new Map();
  for (const move of machine.moves) {
    for (const from of move.from) {
      const key = `${from}>${move.to}`;
      if (from !== move.to && !ROUTES[key]) throw new Error(`no route for ${from} > ${move.to}: add it to ROUTES in docs/img/draw.mjs`);
      const verb = move.by.includes('clock') ? `${move.verb} (clock)` : move.verb;
      if (!verbs.get(key)?.includes(verb)) verbs.set(key, [...(verbs.get(key) ?? []), verb]);
    }
  }
  const finals = machine.states.filter((state) => state.final).map((state) => state.id);
  const body = [text(24, 34, "An item's life", 'head'), text(140, 34, `starts ${machine.initial}; ends ${finals.join(' or ')}`, 'aside')];
  for (const state of machine.states) {
    const [x, y] = PLACES[state.id];
    const keeps = verbs.get(`${state.id}>${state.id}`);
    body.push(box({ x, y, w: W, h: H, kind: state.id === 'verified' ? 'done' : 'plain', title: state.id, sub: keeps ? `↻ ${keeps.join(' · ')}` : undefined, final: state.final ? state.id : undefined }));
  }
  for (const [key, said] of verbs) {
    const [from, to] = key.split('>');
    if (from === to) continue;
    const route = ROUTES[key];
    body.push(edge(route.points, { back: route.back, tip: route.tip !== false }));
    if (!route.label) continue;
    const [x, y, anchor] = route.label;
    wrapped(said, route.wrap ?? 1).forEach((line, i) => body.push(text(x, y + i * 15, line, `label${route.back ? ' back' : ''}`, anchor)));
  }
  for (const id of finals) {
    const note = GUARD_NOTES[id];
    if (!note) throw new Error(`no place for the guards into ${id}: add it to GUARD_NOTES in docs/img/draw.mjs`);
    const codes = machine.exitGuards[id].map((guard) => machine.guards.find((each) => each.id === guard).refuse);
    body.push(`<g class="plain"><rect x="${note.x}" y="${note.y}" width="${note.w}" height="${30 + codes.length * 16}" rx="8"/></g>`);
    body.push(text(note.x + 12, note.y + 20, `every way into ${id}`, 'label'));
    codes.forEach((code, i) => body.push(text(note.x + 12, note.y + 38 + i * 16, code, 'code mono')));
    body.push(edge(note.leader, { tip: false, leader: true }));
  }
  body.push(text(24, 374, '↻ a move that keeps the state · dashed: back to open · double border: final · codes: the refusal each guard raises', 'aside'));
  return figure({
    width: 840,
    height: 392,
    title: "An item's life",
    desc: `Drawn from src/machine.js. An item starts ${machine.initial} and ends ${finals.join(' or ')}. ${[...verbs]
      .filter(([key]) => key.split('>')[0] !== key.split('>')[1])
      .map(([key, said]) => `${key.replace('>', ' to ')}: ${said.join(', ')}`)
      .join('. ')}.`,
    body,
  });
}

/** Where things live: the main checkout, the lane worktrees beside it, and the one board they share. */
export function drawLayout() {
  const files = [
    ['SPEC.md', 'what to build, one row per id'],
    ['PRACTICE.md', 'the house rules'],
    ['pullboard.json', 'gate, lanes, commit rules'],
    ['AGENTS.md, .claude/', 'how agents work here'],
    ['.githooks/', 'commit and push checks'],
  ];
  const trees = [
    ['../repo-web-1', 'builder · web lane'],
    ['../repo-api-1', 'builder · api lane'],
    ['../repo-review-1', 'verifier · built none of it'],
  ];
  return figure({
    width: 840,
    height: 404,
    title: 'Where things live',
    desc: 'The main checkout is the coordinator. It holds SPEC.md, PRACTICE.md, pullboard.json, AGENTS.md and the git hooks. Inside .git, shared by every worktree, are the board, board.sqlite, and the pinned submitted commits. Beside it, each agent works in its own worktree: builders in their lanes and a verifier that built none of it, all on the same board. pullboard view lists every project on this machine.',
    body: [
      text(24, 34, 'Where things live', 'head'),
      '<rect class="frame" x="24" y="52" width="400" height="328" rx="10"/>',
      text(44, 80, 'your repo: the main checkout', 't1'),
      text(44, 98, 'the coordinator files, merges and talks with you', 'aside'),
      ...files.flatMap(([name, what], i) => [text(44, 130 + i * 22, name, 'mono label'), text(204, 130 + i * 22, what, 'label')]),
      '<g class="plain"><rect x="44" y="236" width="360" height="126" rx="8"/></g>',
      text(60, 260, '.git, shared by every worktree', 't1 mono'),
      text(60, 288, 'pullboard/board.sqlite', 'mono label'),
      text(60, 305, 'items, claims, verdicts, shouts', 'aside'),
      text(60, 333, 'refs/pullboard/items', 'mono label'),
      text(60, 350, 'every submitted commit, pinned', 'aside'),
      ...trees.map(([name, role], i) => box({ x: 480, y: 60 + i * 80, w: 336, h: 56, kind: 'agent', title: name, sub: role, mono: true })),
      ...trees.map((_, i) => edge([[480, 88 + i * 80], [452, 88 + i * 80]], { tip: false })),
      edge([[452, 88], [452, 300], [408, 300]]),
      text(470, 300, 'one board: every worktree reads and writes it', 'aside'),
      box({ x: 480, y: 320, w: 336, h: 56, kind: 'person', title: '~/.pullboard/projects.json', sub: 'pullboard view: every project here', mono: true }),
    ],
  });
}

/** Starting with an agent: four steps for the person, then the agent runs the team. */
export function drawAgentStart() {
  const yours = [
    ['pullboard init', "in your project's git repo"],
    ['Commit what init wrote', 'git add -A, then git commit'],
    ['Open a new session', 'Claude Code, in that folder'],
    ['Say what to build', '"use pullboard to build …"'],
  ];
  const theirs = [
    ['Spec with you', 'only you approve a row', 'agent'],
    ['Lanes and a plan', 'items with frozen bars', 'agent'],
    ['A builder per lane', 'subagents in worktrees', 'agent'],
    ['A verifier', 'built none of it, checks each', 'agent'],
    ['Merge and report', 'verified work only', 'done'],
  ];
  return figure({
    width: 840,
    height: 476,
    title: 'Starting with an agent',
    desc: 'You run pullboard init in your git repo, commit what it wrote, open a new Claude Code session in that folder and say what to build. That agent becomes the coordinator: it takes the spec with you, and only you approve a row; it proposes lanes and plans items with frozen bars; it starts a builder subagent per lane in its own worktree and a verifier that built none of it; it merges verified work only, and reports.',
    body: [
      text(24, 34, 'Starting with an agent', 'head'),
      '<rect class="frame" x="24" y="52" width="388" height="400" rx="10"/>',
      '<rect class="frame" x="428" y="52" width="388" height="400" rx="10"/>',
      text(44, 78, 'You, once', 't1'),
      text(448, 78, 'The agent, as coordinator', 't1'),
      ...yours.map(([title, sub], i) => box({ x: 44, y: 92 + i * 96, w: 348, h: 56, kind: 'person', title, sub })),
      ...yours.slice(1).map((_, i) => edge([[218, 148 + i * 96], [218, 184 + i * 96]])),
      ...theirs.map(([title, sub, kind], i) => box({ x: 448, y: 92 + i * 72, w: 348, h: 56, kind, title, sub })),
      ...theirs.slice(1).map((_, i) => edge([[622, 148 + i * 72], [622, 160 + i * 72]])),
      edge([[392, 408], [420, 408], [420, 120], [444, 120]]),
    ],
  });
}

/** How a question climbs from an agent to its coordinator and, if needed, to the person. */
export function drawChain() {
  const agent = 140;
  const coordinator = 420;
  const person = 700;
  const flows = [
    { from: agent, to: coordinator, y: 154, label: 'question' },
    { from: coordinator, to: agent, y: 204, label: 'answer' },
    { from: coordinator, to: person, y: 254, label: 'pass decision up' },
    { from: person, to: coordinator, y: 304, label: 'person answers' },
    { from: coordinator, to: agent, y: 354, label: 'return answer to asker' },
  ];
  return figure({
    width: 840,
    height: 416,
    title: 'Questions go one step up',
    desc: 'An agent asks its coordinator. The coordinator answers or passes a decision to the person. The person answers through the coordinator, who returns the answer to the original asker. An agent cannot ask the person directly.',
    body: [
      text(24, 34, 'Questions go one step up', 'head'),
      box({ x: 50, y: 58, w: 180, h: 54, kind: 'agent', title: 'Agent', sub: 'asks its coordinator' }),
      box({ x: 330, y: 58, w: 180, h: 54, kind: 'check', title: 'Coordinator', sub: 'answers or passes it up' }),
      box({ x: 610, y: 58, w: 180, h: 54, kind: 'person', title: 'Person', sub: 'answers when asked' }),
      edge([[agent, 116], [agent, 383]], { tip: false, leader: true }),
      edge([[coordinator, 116], [coordinator, 383]], { tip: false, leader: true }),
      edge([[person, 116], [person, 383]], { tip: false, leader: true }),
      ...flows.flatMap(({ from, to, y, label }) => [
        edge([[from, y], [to, y]]),
        text((from + to) / 2, y - 8, label, 'label', 'middle'),
      ]),
      text(420, 400, 'Agents cannot send a decision straight to the person.', 'aside', 'middle'),
    ],
  });
}

/** Every figure the README links, by file name under docs/img. */
export const FIGURES = { loop: drawLoop, lifecycle: drawLifecycle, layout: drawLayout, 'agent-start': drawAgentStart, chain: drawChain };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, draw] of Object.entries(FIGURES)) {
    writeFileSync(join(import.meta.dirname, `${name}.svg`), draw());
    console.log(`drew docs/img/${name}.svg`);
  }
}
