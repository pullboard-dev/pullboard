/** The cells move plan: one move item per cell, leaf-first, from the dry run's path map [D3,CD60,CD64]. */
import { posix } from 'node:path';
import { Refused } from '../../../../kernel/index.js';
import { testFile } from '../cell/lint/inventory.js';

// RFC 0006 [CD14]: a cell name is one lowercase word; the dry run's hyphenated names get one word here.
export const CELL_NAMES = Object.freeze({
  'relay-client': 'link',
  'relay-outbox': 'outbox',
  'relay-keys': 'keys',
  'relay-page': 'pages',
  'runner-client': 'runners',
  'app:relay-server': 'app:relay',
});

// Cells whose move item is already on the board: #1395 moves mcp first as the move tooling's pilot.
export const EXISTING_ITEMS = Object.freeze({ mcp: 1395 });

// The dry run's name rules (dryrun/scripts/rules.mjs), first match wins, for modules newer than its map.
// Keys are paths under src/ without the extension; cells use the one-word names above.
const RULES = [
  // Plan additions for families newer than the dry run that no production import places (only tests, bin or strings use them).
  [/^(git-memory|git-adapter|git-launch-.*)$/u, 'git'],
  [/^native-board$/u, 'app:lib'],
  [/^(release-version|release-headlines)$/u, 'config'],
  [/^(audit-coverage.*|main-audit.*|release-gate.*)$/u, 'gate'],
  [/^(cell-.*|cells-.*|source-inventory|import-map|path-map.*)$/u, 'codemap'],
  // A repeated prefix is a folder [CD63]: the stale-state family stays together with the other upkeep sweeps.
  [/^stale-.*$/u, 'health'],
  [/^commands\//u, 'app:cli'],
  [/^(cli|cli-.*|help|cockpit|next-step.*|next-say|command-phase|tour|loop-command|first-refusal-window|static-prose-commands)$/u, 'app:cli'],
  [/^(view|view-.*|view\/.*|serve|background-view|badge|needs|needs-.*|resume-needs)$/u, 'app:view'],
  [/^(runner-worker|runner-stage|runner-stage-read|runner-custody|process-census|runner-private-check|runner-private-mode|private-check-worker)$/u, 'app:runner'],
  [/^index$/u, 'app:lib'],
  [/^(refused|discovery|registry-guards|literal-shell-words|js-lex)$/u, 'kernel'],
  [/-engine$/u, 'state'],
  [/^(moves\/.*|move-registry)$/u, 'moves'],
  [/^(machine|engine|engine-.*|move-.*|recorded-.*|implies|format-registry|formats\/.*)$/u, 'state'],
  [/^(board|board-.*|native-board-state|native-state-clock|history|exchange|local-state|memory-held)$/u, 'store'],
  [/^(sync|git-sync-format|local-fetch)$/u, 'sync'],
  [/^(git|worktree|committed-file-reader|trunk-revision)$/u, 'git'],
  [/^(commit-.*|hooks|why-file|guard-revert|infra-note)$/u, 'commits'],
  [/^(github-origin|intake-github|pr-.*|publish|ci-.*)$/u, 'github'],
  [/^(item-.*|claims|blocks|handoff|handoff-.*|companion|reopen-.*|submission-.*|submit-.*|withdraw|work-order|critical-path-.*|brief|decision-.*|resume|resume-sources|outside-.*|cross-repo-.*|parent-session|caught)$/u, 'items'],
  [/^(verdict-.*|check-accept|review-.*|next-review|bar-.*|proof-.*|evidence|rule-proof-.*|person-row-proof)$/u, 'verify'],
  [/^(land|land-.*|landing-.*|release-queue|main-red|main-failure-matches|manual-landing-.*|computed-conflict-.*)$/u, 'landing'],
  [/^(mechanical-merge|merge-only-.*|trunk-conflict|trunk-merge|recorded-conflict-context)$/u, 'merge'],
  [/^(gate|gate-.*|test-.*|tap-tests|affected-tests|perf-budgets|timing|check-baseline.*|check-mask|module-imports|static-import-style|browser-.*|gui-.*|chrome-clone-check|native-user-directory|child-journal-preload|timed-shell-worker|cpu-load-admission|shell-run)$/u, 'gate'],
  [/^(flake-.*|flakes|ci-flakes|native-flake.*|quarantine)$/u, 'flakes'],
  [/^(sandbox-.*|execution-environment|trusted-policy.*)$/u, 'sandbox'],
  [/^(runners|runner-.*|run)$/u, 'runners'],
  [/^(spec|spec-.*|row-.*|approved-rows|setup-rows|reference-.*|fact-.*|project-decisions|products|signature)$/u, 'spec'],
  [/^rigor.*$/u, 'rigor'],
  [/^(sentinel.*|serve-sentinel|health-sentinel)$/u, 'sentinels'],
  [/^doctrine.*$/u, 'doctrine'],
  [/^(person|person-.*|pairing|seal|sealed-pages|qr)$/u, 'person'],
  [/^(seat-.*|seats|agent-.*|lanes|lane-.*|line-.*|coordinator-hold|route-.*|item-sessions|computer-name|projects)$/u, 'seats'],
  [/^(queue|queue-.*)$/u, 'queue'],
  [/^(shout-.*|inbox-store|watch)$/u, 'shouts'],
  [/^(activity-.*|digest)$/u, 'activity'],
  [/^(health|health-.*|doctor)$/u, 'health'],
  [/^(stats|stats-.*|flow-.*)$/u, 'stats'],
  [/^(roadmap|milestones|focus-milestone|milestone-.*)$/u, 'roadmap'],
  [/^(relay-outbox.*|relay-sender.*|relay-ordering|relay-checkpoint.*|relay-baseline-settle|relay-conflict.*)$/u, 'outbox'],
  [/^(relay-page-.*|relay-presentation)$/u, 'pages'],
  [/^(relay-key|relay-device-keys|relay-pairing-client|relay-person-enrollment)$/u, 'keys'],
  [/^(relay|relay-.*)$/u, 'link'],
  [/^(train-mechanical-merge)$/u, 'merge'],
  [/^(recurring-jobs)$/u, 'health'],
  [/^(standard-doctrine)$/u, 'doctrine'],
  [/^(blueprint.*|blueprints\/.*|templates)$/u, 'blueprints'],
  [/^(config|settings|settings-.*|machine-home|gate-config|json|json-output)$/u, 'config'],
  [/^(api|api-.*)$/u, 'api'],
  [/^code-map$/u, 'codemap'],
  [/^mcp$/u, 'mcp'],
  [/^(resources)$/u, 'resources'],
  [/^(init|init-.*|skills|changelog|sweep)$/u, 'app:cli'],
];

// Node built-ins a pure core may import; anything else, or a clock, randomness or the environment, is shell [CD36].
const PURE_BUILTINS = new Set(['node:path', 'node:url', 'node:util', 'node:assert', 'node:assert/strict', 'node:buffer', 'node:string_decoder', 'node:querystring']);
const IMPURE_SOURCE = /\bprocess\.env\b|\bDate\.now\(|\bnew Date\(\s*\)|\bMath\.random\(|\bperformance\.now\(/u;
const DOCUMENT = /\.(?:md|mdx|rst|txt|adoc|html?)$/iu;

/** True for a path the plan places: a tracked module or asset under src/ or relay/, or any JS module under bin/. */
export function inPlanScope(file) {
  return /^(?:src|relay)\//u.test(file) || /^bin\/.*\.[cm]?js$/u.test(file);
}

/** The reason every stay row for a sealed engine snapshot carries, kept in one place so rows and the rule agree. */
export const MOVE_HISTORY_REASON = 'canonical engine identity retained in src during package moves';

/**
 * The reason a path is placed by rule, or null: any packages/state/data/history/<digits>.json is a stay with the stay rows' reason.
 * Each landing that adds an engine writes the next snapshot, so waiting for a plan row would jam that landing (#3225).
 * Every check that reports unplaced paths asks this one function, whether or not the plan lists the file.
 *
 * @param {string} file - A repository-relative path.
 * @returns {string|null} The placement reason, or null when the path is not an engine history snapshot.
 */
export function moveHistoryPlacement(file) {
  return /^packages\/state\/data\/history\/\d+\.json$/u.test(file) ? MOVE_HISTORY_REASON : null;
}

/** Translate a dry-run cell to its one-word plan name, so seeds and rules agree on one vocabulary. */
export function planCellName(cell) { return CELL_NAMES[cell] ?? cell; }

/** Name the folder a cell lives in: apps for what runs, packages for what apps use [CD12]. */
export function cellRoot(cell) {
  return cell.startsWith('app:') ? `apps/${cell.slice(4)}` : `packages/${cell}`;
}

/** Match the dry run's name rules for one path, or null; bin/ stays in place as the report found. */
export function ruleCell(file) {
  if (file.startsWith('relay/')) return 'app:relay';
  if (!file.startsWith('src/')) return null;
  const key = file.slice(4).replace(/\.(?:[cm]?js|json|css|md|html)$/u, '');
  for (const [pattern, cell] of RULES) if (pattern.test(key)) return cell;
  return null;
}

/**
 * Map each src/ asset to the modules that read it by listing or opening a directory the code names with
 * a repository path under src/, the path form the discovery and declaration readers use [#1778]. Only a direct child of
 * the listed directory counts, so a reader never claims a deeper tree it does not enumerate.
 */
export function assetReaders(sources, assets) {
  const readers = new Map();
  for (const [file, source] of sources) {
    if (testFile(file) || !/\b(?:readdirSync|readFileSync)\b/u.test(source)) continue;
    for (const match of source.matchAll(/\bjoin\(\s*root\s*,\s*'src'((?:\s*,\s*'[^']+')*)/gu)) {
      const directory = ['src', ...[...match[1].matchAll(/'([^']+)'/gu)].map(part => part[1])].join('/');
      for (const asset of assets) {
        if (posix.dirname(asset) !== directory) continue;
        readers.set(asset, new Set([...(readers.get(asset) ?? []), file]));
      }
    }
  }
  return readers;
}

/** The path inside a cell's src/ that keeps a moved file's subfolder (moves/, commands/, view/, formats/). */
function innerPath(file) {
  return file.replace(/^(?:src|relay)\//u, '');
}

/**
 * Place every in-scope path in exactly one cell, or in stays.
 * Seeded paths keep the dry run's cell; newer paths take the dry run's name rules, then the cell they share the
 * most production imports with (normalized by the square root of its size, as the dry run's map did), so a new
 * module joins its neighbours instead of a hand-typed list.
 */
export function placePaths({ paths, edges, seed, readers = new Map() }) {
  const placed = new Map(), stays = [];
  for (const file of paths) {
    if (file.startsWith('bin/')) { stays.push({ path: file, reason: 'bin/ stays in place during the move (dry run section 1)' }); continue; }
    const seeded = seed.files[file];
    if (seeded && seeded !== 'tooling') placed.set(file, { cell: planCellName(seeded), via: 'seed' });
    else {
      const ruled = ruleCell(file);
      if (ruled) placed.set(file, { cell: ruled, via: 'rule' });
    }
  }
  const neighbours = new Map();
  /** Record one undirected production import between two files. */
  function link(a, b) {
    if (a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      const row = neighbours.get(x) ?? new Map();
      row.set(y, (row.get(y) ?? 0) + 1);
      neighbours.set(x, row);
    }
  }
  for (const [file, rows] of edges) if (!testFile(file)) for (const { target } of rows) if (!testFile(target)) link(file, target);
  let pending = paths.filter(file => !file.startsWith('bin/') && !placed.has(file));
  while (pending.length) {
    const sizes = new Map();
    for (const { cell } of placed.values()) sizes.set(cell, (sizes.get(cell) ?? 0) + 1);
    const next = [];
    for (const file of pending) {
      const weights = new Map();
      for (const [other, count] of neighbours.get(file) ?? []) {
        const cell = placed.get(other)?.cell;
        // The kernel holds only ids, errors, registries and the plugin shape [CD31]; importing refused.js is no reason to join it.
        if (cell && cell !== 'kernel') weights.set(cell, (weights.get(cell) ?? 0) + count);
      }
      const ranked = [...weights].map(([cell, count]) => ({ cell, score: count / Math.sqrt(sizes.get(cell) ?? 1), app: cell.startsWith('app:') }))
        .sort((a, b) => a.app - b.app || b.score - a.score || a.cell.localeCompare(b.cell));
      if (ranked.length) next.push([file, ranked[0].cell]);
    }
    if (!next.length) break;
    for (const [file, cell] of next) placed.set(file, { cell, via: 'imports' });
    pending = pending.filter(file => !placed.has(file));
  }
  // An asset that no import reaches joins the one cell its readers occupy; readers in several cells leave it unplaced [#1778].
  for (const file of pending) {
    const cells = new Set([...(readers.get(file) ?? [])].map(reader => placed.get(reader)?.cell).filter(Boolean));
    if (cells.size === 1) placed.set(file, { cell: [...cells][0], via: 'rule' });
  }
  pending = pending.filter(file => !placed.has(file));
  if (pending.length) {
    throw new Refused('CELLS_UNPLACED', `no seed, name rule or import places ${pending.join(', ')}; add a name rule in packages/codemap/src/io/cells/plan.js and regenerate with node packages/codemap/src/io/cells/scripts/plan.js --write`);
  }
  for (const [file, cell] of Object.entries(seed.tests ?? {})) {
    if (paths.includes(file) || !edges.has(file)) continue;
    placed.set(file, { cell: planCellName(cell), via: 'seed' });
  }
  return { placed, stays };
}

/**
 * Choose core or shell for each moved module: core when it imports only pure built-ins, reads no clock, randomness
 * or environment, and imports only core modules of its own cell. A starting placement the move item may refine.
 */
function anatomy(placed, edges, sources) {
  const shell = new Set();
  for (const [file] of placed) {
    if (testFile(file)) continue;
    const source = sources.get(file) ?? '';
    const builtins = [...source.matchAll(/(?:from|import)\s*\(?\s*['"](node:[^'"]+)['"]/gu)].map(match => match[1]);
    if (!/\.[cm]?js$/u.test(file) || IMPURE_SOURCE.test(source) || builtins.some(name => !PURE_BUILTINS.has(name))) shell.add(file);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, { cell }] of placed) {
      if (shell.has(file) || testFile(file)) continue;
      if ((edges.get(file) ?? []).some(({ target }) => placed.get(target)?.cell === cell && shell.has(target))) { shell.add(file); changed = true; }
    }
  }
  return shell;
}

/** Compute a moved path's target inside its cell's accepted anatomy [CD15]. */
function targetPath(file, cell, shell) {
  const root = cellRoot(cell);
  if (testFile(file)) return `${root}/tests/${posix.basename(file)}`;
  return `${root}/src/${shell.has(file) ? 'io' : 'logic'}/${innerPath(file)}`;
}

/**
 * Order cells leaf-first: packages before apps (nothing imports an app [CD12]), then within each group the
 * Eades-Lin-Smyth heuristic for a small feedback set. A cell that imports no unordered cell goes next; a cell
 * nothing unordered imports goes last; otherwise the cell most imported relative to what it imports goes next.
 * Every import that still points forward is a cut its later cell names, because a cycle between cells would
 * raise the strict cycles ratchet [CD23].
 */
export function leafFirstOrder(cells, weight, tieBreak) {
  const order = [];
  for (const group of [cells.filter(cell => !cell.startsWith('app:')), cells.filter(cell => cell.startsWith('app:'))]) {
    const left = new Set(group), front = [], back = [];
    /** Sum import weight from one cell to the cells still unordered in its group. */
    const out = cell => [...left].reduce((sum, other) => sum + (other === cell ? 0 : weight(cell, other)), 0);
    /** Sum import weight into one cell from the cells still unordered in its group. */
    const into = cell => [...left].reduce((sum, other) => sum + (other === cell ? 0 : weight(other, cell)), 0);
    const pick = (list, score) => list.sort((a, b) => score(a) - score(b) || tieBreak(a) - tieBreak(b) || a.localeCompare(b))[0];
    while (left.size) {
      const list = [...left];
      const sinks = list.filter(cell => out(cell) === 0);
      if (sinks.length) { const cell = pick(sinks, () => 0); front.push(cell); left.delete(cell); continue; }
      const sources = list.filter(cell => into(cell) === 0);
      if (sources.length) { const cell = pick(sources, () => 0); back.unshift(cell); left.delete(cell); continue; }
      const cell = pick(list, candidate => out(candidate) - into(candidate));
      front.push(cell);
      left.delete(cell);
    }
    order.push(...refineOrder([...front, ...back], weight));
  }
  return order;
}

/** Sum the import weight that points from an earlier cell to a later one: the imports a plan must cut. */
export function backWeight(order, weight) {
  let total = 0;
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) total += weight(order[i], order[j]);
  return total;
}

/**
 * Lower the cut weight by sifting each cell to its best position until nothing improves, then move every cell
 * as early as the cells it imports allow, which only ever turns cuts into ordinary imports. Deterministic: ties
 * keep the earlier position.
 */
function refineOrder(start, weight) {
  let order = [...start], best = backWeight(order, weight), improved = true;
  while (improved) {
    improved = false;
    for (const cell of [...order]) {
      const rest = order.filter(other => other !== cell);
      for (let at = 0; at <= rest.length; at++) {
        const candidate = [...rest.slice(0, at), cell, ...rest.slice(at)];
        const cost = backWeight(candidate, weight);
        if (cost < best) { best = cost; order = candidate; improved = true; }
      }
    }
  }
  for (let index = 1; index < order.length; index++) {
    const cell = order[index];
    let at = index;
    while (at > 0 && weight(cell, order[at - 1]) === 0) at--;
    if (at < index) order = [...order.slice(0, at), cell, ...order.slice(at, index), ...order.slice(index + 1)];
  }
  return order;
}

/** Count directed cell-to-cell edges that lie on a cycle, as the cycles lint does. */
function cycleCount(graph) {
  let count = 0;
  /** Determine whether one cell reaches another through the given graph. */
  function reaches(from, target) {
    const seen = new Set([from]), stack = [from];
    while (stack.length) {
      const at = stack.pop();
      if (at === target) return true;
      for (const next of graph.get(at) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    return false;
  }
  for (const [from, targets] of graph) for (const target of targets) if (reaches(target, from)) count++;
  return count;
}

/**
 * Build the whole plan from the tracked paths, the real import edges and the dry run's seed.
 * Ratchet deltas are what a move behind shims changes in each #1393 count when it moves exactly this cell's paths
 * and leaves a re-export shim at every old path something outside the cell still imports.
 */
export function buildCellsPlan({ paths, edges, sources, seed, base }) {
  const assets = paths.filter(file => file.startsWith('src/') && !/\.[cm]?js$/u.test(file));
  const { placed, stays } = placePaths({ paths, edges, seed, readers: assetReaders(sources, assets) });
  const shell = anatomy(placed, edges, sources);
  const cellOf = file => placed.get(file)?.cell ?? null;
  const cells = [...new Set([...placed.values()].map(row => row.cell))].sort();
  const weights = new Map(), pairs = new Map(), importers = new Map();
  for (const [file, rows] of edges) for (const { target } of rows) {
    const list = importers.get(target) ?? [];
    list.push(file);
    importers.set(target, list);
    if (testFile(file) || testFile(target)) continue;
    const from = cellOf(file), to = cellOf(target);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
    const list2 = pairs.get(key) ?? [];
    list2.push(`${file}->${target}`);
    pairs.set(key, list2);
  }
  const dryRunOrder = seed.order ?? [];
  const order = leafFirstOrder(cells, (a, b) => weights.get(`${a}->${b}`) ?? 0, cell => {
    const at = dryRunOrder.indexOf(cell);
    return at < 0 ? dryRunOrder.length : at;
  });
  const position = new Map(order.map((cell, index) => [cell, index]));
  const moved = new Set(), graph = new Map();
  let cycles = 0;
  const plan = order.map((cell, index) => {
    const files = [...placed].filter(([, row]) => row.cell === cell).map(([file]) => file).sort();
    const own = new Set(files);
    const shims = files.filter(file => !testFile(file) && /\.[cm]?js$/u.test(file) && (importers.get(file) ?? []).some(other => !own.has(other)));
    const assetReads = files.filter(file => !/\.[cm]?js$/u.test(file) && (importers.get(file) ?? []).some(other => !own.has(other)));
    let internal = 0;
    for (const file of files) for (const { target } of edges.get(file) ?? []) if (own.has(target)) internal++;
    const imports = order.filter(other => other !== cell && weights.has(`${cell}->${other}`))
      .map(other => ({ cell: other, imports: weights.get(`${cell}->${other}`), before: position.get(other) < index }));
    const cuts = order.filter(other => position.get(other) < index && weights.has(`${other}->${cell}`))
      .map(other => ({ cell: other, imports: weights.get(`${other}->${cell}`), edges: pairs.get(`${other}->${cell}`).sort() }));
    moved.add(cell);
    graph.set(cell, new Set());
    for (const [key] of weights) {
      const [from, to] = key.split('->');
      if (moved.has(from) && moved.has(to)) graph.get(from)?.add(to);
    }
    const nextCycles = cycleCount(graph);
    const delta = nextCycles - cycles;
    cycles = nextCycles;
    const legacyMoved = files.filter(file => file.startsWith('src/')).length;
    const legacyShims = shims.filter(file => file.startsWith('src/')).length;
    const outsideMoved = files.length - legacyMoved;
    const root = cellRoot(cell), name = cell.replace(/^app:/u, '');
    const after = imports.filter(row => row.before).map(row => row.cell);
    const kind = cell.startsWith('app:') ? 'app' : 'package';
    const seedNames = Object.entries(CELL_NAMES).filter(([, value]) => value === cell).map(([key]) => key);
    const cutImports = cuts.reduce((sum, row) => sum + row.imports, 0);
    const signed = value => (value > 0 ? `+${value}` : String(value));
    const criterion = [
      `Cells move ${index + 1} of ${order.length} (RFC 0006; plan entry ${index + 1} in packages/codemap/data/plan/cells.json): the ${files.length === 1 ? 'path' : `${files.length} paths`} the entry lists for ${kind} ${name} move with git mv to their planned targets under ${root}, and ${root}/index.js is the front door, re-exporting the ${shims.length === 1 ? 'module' : `${shims.length} modules`} other code imports.`,
      `Each of those old paths keeps a re-export shim through ${root}/index.js, never a moved leaf directly; that front door remains reachable from a production app. Nothing else outside the cell changes except path-map.json and the cell lint baseline.`,
      ...(cuts.length ? [`First the ${cutImports === 1 ? 'import' : `${cutImports} imports`} from earlier cells into it that the entry lists as cuts ${cutImports === 1 ? 'is' : 'are'} gone, each cut by an item in the importing cell, so no cycle between cells forms.`] : []),
      `The cell lint counts change as the entry states (legacySource ${signed(legacyShims - legacyMoved)}, shims ${signed(legacyShims)}, boundaries ${signed(shims.length - internal)}) and none rises; node packages/codemap/src/io/cells/scripts/plan.js --moved ${cell} passes, and the full suite passes on Node 22.13 and 24.`,
    ].join(' ');
    return {
      order: index + 1,
      name: cell,
      kind,
      root,
      frontDoor: `${root}/index.js`,
      ...(seedNames.length ? { dryRunName: seedNames[0] } : {}),
      placedBy: Object.fromEntries(['seed', 'rule', 'imports'].map(via => [via, files.filter(file => placed.get(file).via === via).length])),
      paths: files.map(file => [file, targetPath(file, cell, shell), placed.get(file).via]),
      reexports: shims,
      imports,
      cuts,
      ratchets: {
        legacySource: legacyShims - legacyMoved,
        shims: legacyShims,
        boundaries: shims.length - internal,
        strays: (shims.length - legacyShims) - outsideMoved,
        documents: files.filter(file => DOCUMENT.test(file)).length,
        cyclesIfUncut: delta,
        assetReads: assetReads.length,
      },
      item: {
        lane: 'core',
        title: `Cells move ${index + 1}/${order.length}: ${name} moves into ${root} behind shims`,
        criterion,
        specs: ['C7', 'doctrine:CD60', 'doctrine:CD64'],
        check: `node packages/codemap/src/io/cells/scripts/plan.js --moved ${cell}`,
        after,
        ...(EXISTING_ITEMS[cell] ? { existing: EXISTING_ITEMS[cell] } : {}),
      },
    };
  });
  const movedPaths = plan.reduce((sum, cell) => sum + cell.paths.length, 0);
  return {
    version: 1,
    item: 1473,
    rfc: 'docs/rfcs/0006-cells.md',
    base,
    seed: { source: seed.source, sha256: seed.sha256, paths: Object.keys(seed.files).length, tests: Object.keys(seed.tests ?? {}).length },
    names: CELL_NAMES,
    totals: {
      cells: plan.length,
      movedPaths,
      stays: stays.length,
      placedBy: Object.fromEntries(['seed', 'rule', 'imports'].map(via => [via, plan.reduce((sum, cell) => sum + cell.placedBy[via], 0)])),
      shims: plan.reduce((sum, cell) => sum + cell.reexports.length, 0),
      cutImports: plan.reduce((sum, cell) => sum + cell.cuts.reduce((total, row) => total + row.imports, 0), 0),
      cutEdges: plan.reduce((sum, cell) => sum + cell.cuts.length, 0),
    },
    cells: plan,
    stays,
  };
}
