/**
 * The README's figures, drawn as SVG (I10). Each one is a card that carries its own light and dark
 * colors, so it reads on GitHub, on npm and in an editor's preview alike. The lifecycle is drawn
 * from packages/state/src/io/machine.js, the one declaration of every state and move (M1): a state or a pair of
 * states this file has no place for is refused, never left out.
 *
 * After changing a figure or the lifecycle, redraw them from the repo root: node docs/img/draw.mjs
 * apps/cli/journeys/doctrine/readme.test.js fails while a committed figure differs from what this draws.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MACHINE } from '../../packages/state/index.js';
import { themeVariants } from './theme.mjs';

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
 * Split a ' · ' list too wide for a box of width `w` into two lines, filling the first; one line otherwise.
 * Why: a state that keeps several moves (↻ release · escalate · refreeze) outgrew its box and the card.
 *
 * @param {string} sub
 * @param {number} w
 * @returns {string[]}
 */
function wrapList(sub, w) {
  const fits = Math.floor((w - 16) / (12 * 0.56));
  const parts = sub.split(' · ');
  if (sub.length <= fits || parts.length < 2) return [sub];
  let first = parts[0];
  let used = 1;
  while (used < parts.length - 1 && `${first} · ${parts[used]}`.length <= fits) first = `${first} · ${parts[used++]}`;
  return [first, parts.slice(used).join(' · ')];
}

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
  const subs = sub ? wrapList(sub, w) : [];
  const lines = subs.length === 2
    ? [text(cx, y + h / 2 - 8, title, `t1${mono ? ' mono' : ''}`, 'middle'), text(cx, y + h / 2 + 8, subs[0], 't2', 'middle'), text(cx, y + h / 2 + 22, subs[1], 't2', 'middle')]
    : sub
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
  'claimed>verified': { points: [[375, 150], [375, 134], [695, 134], [695, 146]], label: [490, 126, 'middle'] },
  'submitted>verified': { points: [[605, 179], [651, 179]], label: [628, 171, 'middle'] },
  'verified>submitted': { points: [[695, 208], [695, 230], [575, 230], [575, 208]], label: [635, 223, 'middle'] },
  'open>submitted': { points: [[165, 208], [165, 248], [495, 248], [495, 208]], label: [405, 241, 'middle'] },
  'open>verified': { points: [[185, 198], [205, 198], [205, 268], [735, 268], [735, 212]], label: [650, 261, 'middle'] },
  'claimed>open': { points: [[335, 150], [335, 120], [145, 120], [145, 146]], back: true, label: [240, 94, 'middle'], wrap: 2 },
  'submitted>open': { points: [[545, 150], [545, 66], [115, 66], [115, 146]], back: true, label: [330, 58, 'middle'] },
  'verified>open': { points: [[815, 179], [830, 179], [830, 8], [15, 8], [15, 179], [25, 179]], back: true, label: [425, 30, 'middle'] },
  'open>withdrawn': { points: [[105, 208], [105, 313], [441, 313]], label: [210, 305, 'middle'] },
  'claimed>withdrawn': { points: [[315, 208], [315, 313]], tip: false },
  'submitted>withdrawn': { points: [[525, 208], [525, 280]] },
  'verified>withdrawn': { points: [[675, 208], [675, 246], [585, 246], [585, 280]] },
};

/** Where the guards every move into a guarded state passes are listed, by state id. */
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
 * into a guarded state can raise.
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
  const guardedStates = machine.states.filter((state) => (machine.exitGuards[state.id] ?? []).length > 0).map((state) => state.id);
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
  for (const id of guardedStates) {
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
    desc: `Drawn from packages/state/src/io/machine.js. An item starts ${machine.initial} and ends ${finals.join(' or ')}. ${[...verbs]
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
    ['DOCTRINE.md', 'the house rules'],
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
    desc: 'The main checkout is the coordinator. It holds SPEC.md, DOCTRINE.md, pullboard.json, AGENTS.md and the git hooks. Inside .git, shared by every worktree, are the board, board.sqlite, and the pinned submitted commits. Beside it, each agent works in its own worktree: builders in their lanes and a verifier that built none of it, all on the same board. pullboard view lists every project on this machine.',
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


/** Draw the approved judgement figure inside the shared accessible light/dark card [I10]. */
export function drawHolds() {
  return figure({
    width: 960,
    height: 374,
    title: 'Judgement accumulates',
    desc: "You approve decisions once, as spec rows, doctrine and answers. The board keeps them as the project's record, with a frozen bar for each item, every verdict and its reason, and the exact commit each verdict checked. A builder agent and a second agent both receive the item's frozen bar, and either can query the whole record at any time: the approved rows, every frozen bar, earlier proofs and every verdict with its reason; the builder hands over its exact commit, and the second agent checks it against the bar and writes the verdict and reason back to the record. Only your calls come back to you. Every item adds to the record, and every new session starts from all of it.",
    // Keep the approved layout and palette together; the shared wrapper still supplies its card.
    body: [
      `<style>
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{fill:#fff;stroke:#dce5df}.title{font-size:16px;font-weight:650;fill:#101714}.sub{font-size:12px;fill:#4f5b55}
.zone{fill:none;stroke:#c9d4cd;stroke-dasharray:4 4}.zl{font-size:10.5px;font-weight:650;letter-spacing:.08em;fill:#65746b}
.b{stroke-width:1}.h{font-size:13px;font-weight:650;fill:#101714}.m{font-size:11.5px;fill:#4f5b55}
.you{fill:#e8f0f8;stroke:#9bb7d4}.plain{fill:#fff;stroke:#c9d4cd}.rows{fill:#efe9ff;stroke:#b9a6f0}.lay{fill:#f6f8f7;stroke:#c9d4cd}.ver{fill:#dff4e8;stroke:#9fd6b6}.bld{fill:#fdf6e3;stroke:#e2c98a}.youL{fill:#e8f0f8;stroke:#9bb7d4}.youL2{fill:#f3f7fb;stroke:#9bb7d4;stroke-dasharray:3 2}.bldL{fill:#fdf6e3;stroke:#e2c98a}.chkL{fill:#efe9ff;stroke:#b9a6f0}.key{font-size:10.5px;fill:#65746b}.chk{fill:#efe9ff;stroke:#b9a6f0}
.ln{stroke:#65746b;stroke-width:1.5;fill:none}.ln.d{stroke-dasharray:5 4}.hd{fill:#65746b}
.pill{fill:#fff;stroke:#dce5df}.pt{font-size:11px;fill:#4f5b55}
.cap{font-size:12.5px;fill:#4f5b55}
@media(prefers-color-scheme:dark){.card{fill:#111714;stroke:#34443a}.title,.h{fill:#e9eeeb}.sub,.m,.pt,.cap{fill:#b6c3bc}.zone{stroke:#3a4a40}.zl{fill:#9cafa3}
.you{fill:#14243a;stroke:#3f6a96}.plain{fill:#111714;stroke:#3a4a40}.rows{fill:#231d3a;stroke:#6b57b8}.lay{fill:#18201c;stroke:#3a4a40}.ver{fill:#163829;stroke:#2f7a55}.bld{fill:#2e2614;stroke:#8a6f2c}.youL{fill:#14243a;stroke:#3f6a96}.youL2{fill:#101b2b;stroke:#3f6a96;stroke-dasharray:3 2}.bldL{fill:#2e2614;stroke:#8a6f2c}.chkL{fill:#231d3a;stroke:#6b57b8}.key{fill:#9cafa3}.chk{fill:#231d3a;stroke:#6b57b8}
.ln{stroke:#9cafa3}.hd{fill:#9cafa3}.pill{fill:#111714;stroke:#34443a}}
</style>`,
      `<defs>
<linearGradient id="grow" x1="0" x2="1"><stop offset="0" stop-color="#087546" stop-opacity="0.08"/><stop offset="1" stop-color="#087546" stop-opacity="0.85"/></linearGradient>
</defs>`,
      `<text class="title" x="24" y="34">Judgement accumulates</text>
<text class="sub" x="24" y="54">Every piece of work starts from everything decided and proved before it.</text>
<rect class="zone" x="24" y="92" width="190" height="252" rx="10"/><text class="zl" x="38" y="112">YOU</text>
<rect class="zone" x="304" y="92" width="352" height="252" rx="10"/><text class="zl" x="318" y="112">THE BOARD · THE PROJECT'S RECORD</text>
<rect class="zone" x="746" y="92" width="190" height="252" rx="10"/><text class="zl" x="760" y="112">AGENTS · ONE LANE EACH</text>
<rect class="you b" x="38" y="122" width="162" height="60" rx="8"/><text class="h" x="119" y="147" text-anchor="middle">Your decisions</text><text class="m" x="119" y="165" text-anchor="middle">rows · doctrine · answers</text>
<rect class="plain b" x="38" y="252" width="162" height="60" rx="8"/><text class="h" x="119" y="277" text-anchor="middle">Only your calls</text><text class="m" x="119" y="295" text-anchor="middle">questions passed up</text>
<rect class="youL b" x="322" y="122" width="316" height="38" rx="7"/><text class="h" x="336" y="146">Approved rows</text><text class="m" x="624" y="146" text-anchor="end">what must be true</text>
<rect class="youL2 b" x="322" y="168" width="316" height="38" rx="7"/><text class="h" x="336" y="192">Frozen bars</text><text class="m" x="624" y="192" text-anchor="end">one per item, from the rows</text>
<rect class="chkL b" x="322" y="260" width="316" height="38" rx="7"/><text class="h" x="336" y="284">Verdicts</text><text class="m" x="624" y="284" text-anchor="end">every accept and reject, with the reason</text>
<rect class="bldL b" x="322" y="214" width="316" height="38" rx="7"/><text class="h" x="336" y="238">Proofs</text><text class="m" x="624" y="238" text-anchor="end">the exact commit each verdict checked</text>
<rect x="322" y="310" width="316" height="7" rx="3.5" fill="url(#grow)"/>
<text class="m" x="480" y="334" text-anchor="middle">each item adds to the record · each session starts from it</text>
<rect class="bld b" x="760" y="122" width="162" height="60" rx="8"/><text class="h" x="841" y="147" text-anchor="middle">Builder</text><text class="m" x="841" y="165" text-anchor="middle">builds to the bar</text>
<rect class="chk b" x="760" y="252" width="162" height="60" rx="8"/><text class="h" x="841" y="277" text-anchor="middle">Second agent</text><text class="m" x="841" y="295" text-anchor="middle">checks it against the bar</text>
<path class="ln" d="M200 141 H316"/><path class="hd" d="M322 141 l-8 -4.5 v9 z"/>
<rect class="pill" x="219" y="131" width="80" height="20" rx="10"/><text class="pt" x="259" y="145" text-anchor="middle">approve once</text>
<path class="ln" d="M638 187 H736 V152 H754"/><path class="hd" d="M760 152 l-8 -4.5 v9 z"/>
<path class="ln" d="M736 187 V262 H754"/><path class="hd" d="M760 262 l-8 -4.5 v9 z"/>
<circle cx="736" cy="187" r="3" class="hd"/>
<path class="ln d" d="M922 282 H946 V66 H480 V86"/><path class="hd" d="M480 92 l-4.5 -8 h9 z"/>
<path class="ln d" d="M922 152 H946"/><circle cx="946" cy="152" r="3" class="hd"/>
<rect class="pill" x="652" y="56" width="96" height="20" rx="10"/><text class="pt" x="700" y="70" text-anchor="middle">query any time</text>
<rect class="pill" x="653" y="177" width="70" height="20" rx="10"/><text class="pt" x="688" y="191" text-anchor="middle">frozen bar</text>
<path class="ln" d="M841 182 V246"/><path class="hd" d="M841 252 l-4.5 -8 h9 z"/>
<rect class="pill" x="799" y="207" width="84" height="20" rx="10"/><text class="pt" x="841" y="221" text-anchor="middle">exact commit</text>
<path class="ln" d="M760 279 H644"/><path class="hd" d="M638 279 l8 -4.5 v9 z"/>
<rect class="pill" x="661" y="269" width="96" height="20" rx="10"/><text class="pt" x="709" y="283" text-anchor="middle">verdict + reason</text>
<path class="ln d" d="M304 282 H206"/><path class="hd" d="M200 282 l8 -4.5 v9 z"/>
<rect class="pill" x="223" y="272" width="64" height="20" rx="10"/><text class="pt" x="255" y="286" text-anchor="middle">your calls</text>`,
    ],
  });
}

/* The Software factory: one night on Pullboard's own board, what a board runs, and why it holds. */
const FACTORY_STYLE = `
text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{fill:#fff;stroke:#dce5df}.title{font-size:16px;font-weight:650;fill:#101714}.sub{font-size:12px;fill:#4f5b55}
.zone{fill:none;stroke:#c9d4cd;stroke-dasharray:4 4}.zl{font-size:10.5px;font-weight:650;letter-spacing:.08em;fill:#65746b}
.h{font-size:13px;font-weight:650;fill:#101714}.m{font-size:11.5px;fill:#4f5b55}.n{font-size:18px;font-weight:650;fill:#101714;font-variant-numeric:tabular-nums}
.nb{font-size:30px;font-weight:700;fill:#0b5d3a;font-variant-numeric:tabular-nums}.hl{font-weight:700;fill:#0b5d3a}.stamp{fill:none;stroke:#1f8a5a;stroke-width:2}.stamp.in{stroke-width:1;opacity:.55}.stw{font-size:24px;font-weight:800;letter-spacing:.14em;fill:#1f8a5a}.sts{font-size:10px;font-weight:800;letter-spacing:.24em;fill:#1f8a5a}
.you{fill:#e8f0f8;stroke:#9bb7d4}.plain{fill:#fff;stroke:#c9d4cd}.rows{fill:#efe9ff;stroke:#b9a6f0}.ver{fill:#dff4e8;stroke:#9fd6b6}.bld{fill:#fdf6e3;stroke:#e2c98a}.lay{fill:#f6f8f7;stroke:#c9d4cd}
.ln{stroke:#65746b;stroke-width:1.5;fill:none}.ln.d{stroke-dasharray:5 4}.hd{fill:#65746b}.dot{fill:#65746b}.ship{fill:#1f8a5a}
.pill{fill:#fff;stroke:#dce5df}.pill.ok{fill:#dff4e8;stroke:#9fd6b6}.pt{font-size:11px;fill:#4f5b55}.pt.ok{fill:#0b5d3a;font-weight:600}
.h.sm{font-size:12.5px}.okl{stroke:#1f8a5a}
.ico{fill:none;stroke:#65746b;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
@media(prefers-color-scheme:dark){.card{fill:#111714;stroke:#34443a}.title,.h,.n{fill:#e9eeeb}.sub,.m,.pt{fill:#b6c3bc}.zone{stroke:#3a4a40}.zl{fill:#9cafa3}
.you{fill:#14243a;stroke:#3f6a96}.plain{fill:#111714;stroke:#3a4a40}.rows{fill:#231d3a;stroke:#6b57b8}.ver{fill:#163829;stroke:#2f7a55}.bld{fill:#2e2614;stroke:#8a6f2c}.lay{fill:#18201c;stroke:#3a4a40}
.ln{stroke:#9cafa3}.hd,.dot{fill:#9cafa3}.ship{fill:#4cc38a}.pill{fill:#111714;stroke:#34443a}.pill.ok{fill:#163829;stroke:#2f7a55}.pt.ok{fill:#8fe0b6}.nb,.hl{fill:#8fe0b6}.stamp{stroke:#4cc38a}.stw,.sts{fill:#4cc38a}.ico{stroke:#9cafa3}.okl{stroke:#4cc38a}}`;

/** The Software factory figures share one wrapper: draw.mjs's card and palette, then their own style, as holds does. */
const softwareFigure = (width, height, title, desc, body) => figure({ width, height, title, desc, body: [
  `<style>${FACTORY_STYLE}\n</style>`,
  '<defs><marker id="tip-f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="hd" d="M0 1 L9 5 L0 9 z"/></marker></defs>',
  ...body,
] });
// a pill label centred on (cx, cy), sized to its words
const pill = (cx, cy, words, ok = false) => { const w = words.length * 6.1 + 18; return `<rect class="pill${ok ? ' ok' : ''}" x="${cx - w / 2}" y="${cy - 11}" width="${w}" height="22" rx="11"/>${text(cx, cy + 4, words, `pt${ok ? ' ok' : ''}`, 'middle')}`; };

// One night on Pullboard's own board: 16 Oct 2026, 04:17Z to 13:51Z (11:17 pm to 8:51 am, Chicago).
const NIGHT = { claims: 22, rejected: 2, sentBack: 12, coordinatorMoves: 205, hours: 9.6, from: '11:17 pm', to: '8:51 am', agents: 38, submitted: 30, accepted: 27, merged: 11, release: '0.8.27', releaseAt: '7:56 am', frac: (12 * 60 + 56 - (4 * 60 + 17)) / (13 * 60 + 51 - (4 * 60 + 17)) };

// What landed on main that night: main at 04:17Z (4168633, 0.8.26) against main at 13:51Z (7160df0, 0.8.27),
// first-parent history of github.com/pullboard-dev/pullboard. Features and fixes are the night's landing merges.
const BUILT = { features: 6, fixes: 5, code: '+817', codeFiles: 17, tests: '+1,596', testCases: 17,
  highlights: ['The view signs in and links every board', 'pullboard.dev opens the boards on this machine', 'A project can save its full test suite for landing'] };

/** One night on Pullboard's own board: what the agents did while the person was away, and what landed. */
export function drawFactory() {
  const W = 840, H = 564;
  const bx = 48, bw = 132, bh = 48, by = 110;
  const l0 = bx + bw, l1 = W - 48 - bw, ly = by + bh / 2;
  const rx = l0 + (l1 - l0) * NIGHT.frac;
  const tiles = [
    ['ver', String(BUILT.features), 'features shipped'],
    ['bld', String(BUILT.fixes), 'fixes landed'],
    ['rows', BUILT.code, `lines of product code`],
    ['you', BUILT.tests, `lines of tests`],
    ['lay', NIGHT.release, 'released to npm'],
  ];
  const tw = (W - 96 - 4 * 12) / 5;
  const flow = [
    { cls: 'lay', head: 'Coordinator', sub: 'answers, reopens' },
    { cls: 'bld', head: 'Builders', sub: `${NIGHT.claims} claims · ${NIGHT.submitted} submitted` },
    { cls: 'rows', head: 'A verifier agent', sub: `${NIGHT.accepted} accepted · ${NIGHT.rejected} rejected` },
    { cls: 'ver', head: 'main', sub: `${NIGHT.merged} work items merged` },
  ];
  const fw = 156, fg = (W - 96 - 4 * fw) / 3, fy = 263, fh = 48;
  return softwareFigure(W, H, 'You leave. It builds.', `One night on Pullboard's own board, 16 October 2026: ${NIGHT.agents} agents, ${NIGHT.hours} hours from ${NIGHT.from} to ${NIGHT.to}, with no moves from the person. ${NIGHT.agents} agents worked: a coordinator agent answered and reopened work, and landed what the verifier accepted; builders made ${NIGHT.claims} claims and ${NIGHT.submitted} submissions; a verifier agent accepted ${NIGHT.accepted} and rejected ${NIGHT.rejected}; ${NIGHT.sentBack} went back to their builders; ${NIGHT.merged} work items merged to main. What landed on main: ${BUILT.features} features and ${BUILT.fixes} fixes, ${BUILT.code} lines of product code across ${BUILT.codeFiles} files and ${BUILT.tests} lines of tests with ${BUILT.testCases} new test cases, and release ${NIGHT.release} on npm at ${NIGHT.releaseAt}. Among the features: ${BUILT.highlights.join('; ')}.`, [
    text(24, 34, 'You leave. It builds.', 'title'),
    text(24, 54, `One night on Pullboard’s own board, 16 Oct: ${NIGHT.hours} hours with no moves from the person.`, 'sub'),
    `<rect class="zone" x="24" y="72" width="${W - 48}" height="102" rx="10"/>`, text(38, 94, 'THE NIGHT', 'zl'),
    `<rect class="you" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8"/>`, text(bx + bw / 2, by + 21, 'You leave', 'h', 'middle'), text(bx + bw / 2, by + 37, NIGHT.from, 'm', 'middle'),
    `<rect class="you" x="${l1}" y="${by}" width="${bw}" height="${bh}" rx="8"/>`, text(l1 + bw / 2, by + 21, 'You’re back', 'h', 'middle'), text(l1 + bw / 2, by + 37, NIGHT.to, 'm', 'middle'),
    `<line class="ln d" x1="${l0}" y1="${ly}" x2="${l1}" y2="${ly}"/>`,
    pill((l0 + rx) / 2, ly, `${NIGHT.hours} hours · no moves from you`),
    ...(() => { const words = `${NIGHT.release} ships · ${NIGHT.releaseAt}`, pw = words.length * 6.1 + 18, cx = Math.min(rx, l1 - 10 - pw / 2); return [`<line class="ln" x1="${rx}" y1="${ly}" x2="${rx}" y2="${ly - 18}"/>`, `<circle class="ship" cx="${rx}" cy="${ly}" r="5"/>`, pill(cx, ly - 29, words, true)]; })(),
    // how the work moved: the coordinator organizes, builders claim and submit, a second agent checks, main takes what passes
    `<rect class="zone" x="24" y="186" width="${W - 48}" height="180" rx="10"/>`, text(38, 208, `WHAT THE AGENTS DID · ${NIGHT.agents} AGENTS`, 'zl'),
    ...flow.map((b, i) => { const x = 48 + i * (fw + fg); return `<rect class="${b.cls}" x="${x}" y="${fy}" width="${fw}" height="${fh}" rx="8"/>${text(x + fw / 2, fy + 21, b.head, 'h', 'middle')}${text(x + fw / 2, fy + 38, b.sub, 'm', 'middle')}`; }),
    ...flow.slice(1).map((_, i) => { const x1 = 48 + (i + 1) * fw + i * fg; return `<line class="ln" x1="${x1}" y1="${fy + fh / 2}" x2="${x1 + fg - 2}" y2="${fy + fh / 2}" marker-end="url(#tip-f)"/>`; }),
    `<path class="ln d" d="M${48 + 3 * (fw + fg) + fw / 2} ${fy} V${fy - 28} H${48 + (fw + fg) + fw / 2} V${fy - 2}" marker-end="url(#tip-f)"/>`,
    pill(48 + 2 * (fw + fg) + fw / 2 - 40, fy - 28, `${NIGHT.sentBack} sent back`),
    // the coordinator lands what the verifier accepted: a line under the boxes, from the coordinator up into main
    `<path class="ln d" d="M${48 + fw / 2} ${fy + fh} V${fy + fh + 28} H${48 + 3 * (fw + fg) + 36} V${fy + fh + 2}" marker-end="url(#tip-f)"/>`,
    pill(48 + 2 * (fw + fg) + fw / 2 - 40, fy + fh + 28, 'lands accepted work'),
    `<line class="ln" x1="${48 + 3 * (fw + fg) + fw / 2}" y1="${fy + fh}" x2="${48 + 3 * (fw + fg) + fw / 2}" y2="${376}" marker-end="url(#tip-f)"/>`,
    `<rect class="zone" x="24" y="378" width="${W - 48}" height="166" rx="10"/>`, text(38, 400, 'WHAT LANDED ON MAIN BY MORNING', 'zl'),
    ...tiles.map(([cls, n, words], i) => { const x = 48 + i * (tw + 12); return `<rect class="${cls}" x="${x}" y="416" width="${tw}" height="62" rx="8"/>${text(x + 14, 443, n, 'n')}${text(x + 14, 462, words, 'm')}`; }),
    text(48, 502, 'Among the features', 'h sm'),
    text(48, 524, BUILT.highlights.join('  ·  '), 'm'),
  ]);
}

const ICON = {
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  blueprint: '<path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v4h4M9 12h6M9 16h4"/>',
  mcp: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0Z"/><path d="M12 17v4"/>',
  machines: '<rect x="2.5" y="4" width="12" height="9" rx="1.5"/><path d="M6.5 16.5h4M8.5 13v3.5"/><rect x="15" y="8" width="6.5" height="11" rx="1.5"/><path d="M17.5 16.5h1.5"/>',
  verified: '<path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  team: '<circle cx="9" cy="8.5" r="3"/><circle cx="17" cy="9.5" r="2.4"/><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6M15.5 14.6c2.2 0 4 1.3 4.8 3.9"/>',
};
// Each glyph's drawn middle, top to bottom, in its 24-unit box; the icon centers there on its heading's capitals (13 px, baseline 15 below y).
const MID = { phone: 12, blueprint: 12, mcp: 12, machines: 11.5, verified: 12, team: 12.25 };
const ic = (name, x, y) => `<g class="ico" transform="translate(${x} ${(y + 15 - 13 * 0.35 - MID[name] * 0.75).toFixed(2)}) scale(0.75)">${ICON[name]}</g>`;

/** What a board runs in the pinned release: a team, a phone, blueprints, any agent and paired machines. */
export function drawWhat() {
  const W = 840, pad = 24, gap = 12, inner = W - pad * 2 - 2 * 16, top = 60;
  const col = (inner - 2 * gap) / 3, x0 = pad + 16;
  const bigW = col * 2 + gap, h1 = 84, h2 = 78, y2 = top + 32 + h1 + gap;
  const small = [
    { cls: 'you', icon: 'phone', head: 'Your board, on your phone', line: 'Answer what’s waiting, anywhere. Sealed: the relay can’t read it.', lines: ['Answer what’s waiting, anywhere.', 'Sealed: the relay can’t read it.'] },
    { cls: 'rows', icon: 'blueprint', head: 'Start from a blueprint', line: 'Pick the one for your project, then approve its rules.', lines: ['Pick the one for your project,', 'then approve its rules.'] },
    { cls: 'bld', icon: 'mcp', head: 'Plug in any agent', line: 'Keep Claude Code or Codex, and add any MCP client.', lines: ['Keep Claude Code or Codex,', 'and add any MCP client.'] },
    { cls: 'lay', icon: 'machines', head: 'Across your machines', line: 'Pair a machine once. Its agents share your board, in one order.', lines: ['Pair a machine once. Its agents', 'share your board, in one order.'] },
  ];
  const wrap = (s, n) => { const words = s.split(' '); const lines = ['']; for (const w of words) { if ((lines.at(-1) + ' ' + w).trim().length > n) lines.push(w); else lines[lines.length - 1] = (lines.at(-1) + ' ' + w).trim(); } return lines; };
  const tile = (t, x, y, w, h) => `<rect class="${t.cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/>${ic(t.icon, x + 12, y + 12)}${text(x + 40, y + 27, t.head, 'h')}${(t.lines ?? wrap(t.line, Math.floor((w - 52) / 6.2))).map((l, i) => text(x + 40, y + 46 + i * 15, l, 'm')).join('')}`;
  const H = y2 + h2 + 16 + pad;
  return softwareFigure(W, H, 'One board. Every agent. Every machine.', `One board. Every agent. Every machine. All of it is in Pullboard 0.9.0. Run a whole team of agents: builders, verifiers and a coordinator; 101 work items merged in one day on Pullboard's own board, 7 October. ${small.map((t) => `${t.head}: ${t.line}`).join(' ')}`, [
    text(24, 34, 'One board. Every agent. Every machine.', 'title'),
    `<rect class="zone" x="${pad}" y="${top - 6}" width="${W - pad * 2}" height="${H - top - pad + 6}" rx="10"/>`, text(pad + 14, top + 16, 'IN PULLBOARD 0.9.0', 'zl'),
    `<rect class="ver" x="${x0}" y="${top + 32}" width="${bigW}" height="${h1}" rx="8"/>`, ic('team', x0 + 12, top + 44),
    text(x0 + 40, top + 59, 'Run a whole team of agents', 'h'), text(x0 + 40, top + 78, 'Builders, verifiers and a coordinator.', 'm'),
    `<text class="m" x="${x0 + 40}" y="${top + 32 + 61}"><tspan class="hl">101</tspan> work items merged in one day · 7 Oct</text>`,
    // The verifier's accept, as a stamp: LGTM, ship it, from an agent that checked it.
    ...(() => { const cx = x0 + bigW - 96, cy = top + 32 + 42; return [`<g transform="rotate(-6 ${cx} ${cy})"><rect class="stamp" x="${cx - 64}" y="${cy - 27}" width="128" height="54" rx="7"/><rect class="stamp in" x="${cx - 59}" y="${cy - 22}" width="118" height="44" rx="4"/>${text(cx + 1.7, cy + 4, 'LGTM', 'stw', 'middle')}${text(cx + 1.2, cy + 17, 'SHIP IT', 'sts', 'middle')}</g>`]; })(),
    tile(small[0], x0 + bigW + gap, top + 32, col, h1),
    ...small.slice(1).map((t, i) => tile(t, x0 + i * (col + gap), y2, col, h2)),
  ]);
}

// Why it's safe to walk away: vibe coding against Pullboard, and what Pullboard's own board shows.
// 908 submitted, 227 sent back, 588 merged, 0 merged without an accept: pullboard stats --json, 4 to 16 Oct 2026.
const SB = { submitted: 908, sentBack: 227, merged: 588, unchecked: 0 };
const ROWS = [
  ['It said done. It wasn’t.', 'A second agent checks it, at the exact commit'],
  ['It forgot what you decided', 'Decisions live in your spec'],
  ['Two agents, one file', 'Each agent works in its own lane'],
  ['You review every line', 'Only your decisions reach you'],
];
/** Where vibe coding breaks, what holds instead, and how often a second agent sends work back. */
export function drawWhy() {
  const W = 840, zw = W / 2 - 24 - 6, zr = W / 2 + 6, bw = zw - 32, lx = 40, rx = zr + 16, top = 102, rh = 30, gap = 8;
  const zoneH = 38 + ROWS.length * (rh + gap) - gap + 16;
  const by = 72 + zoneH + 12;
  const H = by + 62 + 24;
  const X = (x, y) => `<path class="ln" d="M${x} ${y}l8 8M${x + 8} ${y}l-8 8"/>`;
  const C = (x, y) => `<path class="ln okl" d="M${x} ${y + 4}l3 3 6-7"/>`;
  return softwareFigure(W, H, 'Where vibe coding breaks, and what holds instead', `Where vibe coding breaks, and what holds instead. Pullboard enforces each fix, so none of it depends on you watching. Vibe coding: ${ROWS.map((r) => r[0]).join('; ')}. With Pullboard: ${ROWS.map((r) => r[1]).join('; ')}. On Pullboard's own board, 4 to 16 October 2026: 1 in 4 times an agent said done, a second agent sent it back (${SB.sentBack} of ${SB.submitted}), and ${SB.merged} merged, ${SB.unchecked} of them without an accept.`, [
    text(24, 34, 'Where vibe coding breaks, and what holds instead', 'title'),
    text(24, 54, 'Pullboard enforces each fix, so none of it depends on you watching.', 'sub'),
    `<rect class="zone" x="24" y="72" width="${zw}" height="${zoneH}" rx="10"/>`, text(38, 94, 'VIBE CODING', 'zl'),
    `<rect class="zone" x="${zr}" y="72" width="${zw}" height="${zoneH}" rx="10"/>`, text(zr + 14, 94, 'WITH PULLBOARD', 'zl'),
    ...ROWS.flatMap(([bad, good], i) => {
      const y = top + 8 + i * (rh + gap);
      return [
        `<rect class="plain" x="${lx}" y="${y}" width="${bw}" height="${rh}" rx="8"/>${X(lx + 12, y + 11)}${text(lx + 32, y + 20, bad, 'm')}`,
        `<rect class="ver" x="${rx}" y="${y}" width="${bw}" height="${rh}" rx="8"/>${C(rx + 12, y + 10)}${text(rx + 32, y + 20, good, 'h sm')}`,
      ];
    }),
    `<rect class="lay" x="24" y="${by}" width="${W - 48}" height="62" rx="10"/>`,
    text(44, by + 41, '1 in 4', 'nb'),
    text(150, by + 27, 'times an agent said “done”, a second agent sent it back.', 'h'),
    text(150, by + 45, `${SB.submitted} submitted · ${SB.sentBack} sent back · ${SB.merged} merged · ${SB.unchecked} merged without an accept · Pullboard’s own board, 4–16 Oct`, 'm'),
  ]);
}


/** Every figure the README links, by file name under docs/img. */
export const FIGURES = { loop: drawLoop, lifecycle: drawLifecycle, layout: drawLayout, 'agent-start': drawAgentStart, chain: drawChain, holds: drawHolds, factory: drawFactory, what: drawWhat, why: drawWhy };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, draw] of Object.entries(FIGURES)) {
    const { light, dark } = themeVariants(draw());
    writeFileSync(join(import.meta.dirname, `${name}.svg`), light);
    writeFileSync(join(import.meta.dirname, `${name}-dark.svg`), dark);
    console.log(`drew docs/img/${name}.svg and docs/img/${name}-dark.svg`);
  }
}
