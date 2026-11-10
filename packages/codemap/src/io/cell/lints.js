import { cellRoots } from './lint/roots.js';
import {
  readPathMap,
  pathMapFromFiles,
} from '../../logic/path/map.js';
import { cellSourceSnapshot } from './snapshot.js';
import { exportReachability } from './lint/exports.js';
/** Report migration debt from accepted RFC 0006; report reads never initialize or rewrite ratchets [C7,CD64]. */
import { cellInventory } from './lint/inventory.js';
import { temporaryCellEdges } from './lint/inventory.js';
import { cellOf } from './lint/inventory.js';
import { committedCellTransition } from './lint/inventory.js';
import { cycleEdges } from './lint/inventory.js';
import { testFile } from './lint/inventory.js';
import { lex } from '../../../../kernel/index.js';
import { rootAllowed } from '../../logic/allowlist.js';
import { strayNextStep } from '../../logic/allowlist.js';

export const CELL_METRICS = Object.freeze(['boundaries', 'cycles', 'shims', 'legacySource', 'fileSize', 'strays', 'documents', 'unreachable', 'unreachablePackages', 'unreachableExports', 'unknown']);
const TRANSITION_FILE = 'packages/codemap/data/plan/transition.json';

/** Recognize only an exact package core entry declared by its indexed plan shard; malformed metadata grants nothing. */
function declaredPureEntries(files) {
  const entries = new Set();
  try {
    const index = JSON.parse(files.get('packages/codemap/data/plan/cells.json')?.toString('utf8') ?? 'null');
    for (const row of index?.cells ?? []) {
      if (!Number.isSafeInteger(row.order) || typeof row.name !== 'string'
        || row.file !== `packages/codemap/data/plan/${String(row.order).padStart(2, '0')}-${row.name.replace(':', '-')}.json`) continue;
      const cell = JSON.parse(files.get(row.file)?.toString('utf8') ?? 'null');
      // An app cell may declare only a light door; a pure front door stays a package's.
      if (cell?.name === row.name && cell.order === row.order && (/^packages\/[a-z][a-z0-9-]*$/u.test(cell.root)
        || cell.pureFrontDoor === undefined && /^apps\/[a-z][a-z0-9-]*$/u.test(cell.root))
        && cell.frontDoor === `${cell.root}/index.js` && [cell.pureFrontDoor, cell.lightFrontDoor].filter(Boolean).length === 1
        && (cell.pureFrontDoor ?? cell.lightFrontDoor) === `${cell.root}/light.js`) entries.add(cell.pureFrontDoor ?? cell.lightFrontDoor);
      // A declared browser.js sits beside the index and any light.js, so it is an entry too, never a stray.
      if (cell?.name === row.name && cell.pureDoor === `${cell.root}/browser.js` && /^packages\/[a-z][a-z0-9-]*$/u.test(cell.root)) entries.add(cell.pureDoor);
    }
  } catch { /* An unreadable declaration never widens the accepted anatomy. */ }
  return entries;
}

/** Count stable finding identities, so moving an existing debt elsewhere cannot silently pay for a new one. */
export function cellLintReport(root, parsers, { inventory } = {}) {
  const source = inventory ?? cellInventory(root, parsers);
  const { files, edges } = source;
  const unknown = [...source.unknown];
  const pureEntries = declaredPureEntries(files);
  const metrics = Object.fromEntries(CELL_METRICS.map(name => [name, { count: 0, findings: [] }]));
  /** Add an explicit weighted finding; file-size debt records excess lines, not merely one oversized file. */
  function add(metric, key, count = 1, detail = '') {
    metrics[metric].count += count;
    metrics[metric].findings.push({ key, count, detail });
  }
  const temporary = temporaryCellEdges(files);
  for (const row of temporary.edges) add('shims', `temporary:${row.importer}->${row.target}`, 1, `contract #${row.contractItem}; expires ${row.expires} UTC`);
  for (const reason of temporary.problems) unknown.push({ file: 'packages/codemap/data/plan/temporary-edges.json', reason });
  const rootInfo = cellRoots(files);
  unknown.push(...rootInfo.unknown);
  const graph = new Map(), reachable = new Set(), pending = [...rootInfo.roots];
  for (const file of files.keys()) {
    const pathMapMetadata = /^packages\/codemap\/data\/plan\/path-map\/[a-z][a-z0-9-]*\.json$/u.test(file);
    const cellBaselineMetadata = /^packages\/codemap\/data\/baselines\/lints\/cells\/[a-z][a-z0-9-]*\.json$/u.test(file);
    const transitionMetadata = file === TRANSITION_FILE;
    const shimBaselineMetadata = file === 'packages/codemap/data/baselines/lints/shim-counts.json';
    const cell = cellOf(file), tail = cell ? file.slice(cell.length + 1) : null;
    if (file.startsWith('src/')) add('legacySource', file);
    if (cell) {
      const top = tail.split('/')[0];
      if ((!['index.js', 'src', 'tests', 'contract', 'data', 'journeys'].includes(top) && !pureEntries.has(file))
        || top === 'index.js' && tail !== 'index.js'
        || top === 'src' && !/^src\/(?:logic|io)\//u.test(tail)) add('strays', file, 1, `outside accepted cell anatomy; next: ${strayNextStep(file)}`);
      if (/\.(?:md|mdx|rst|txt|adoc|html?)$/iu.test(file)) add('documents', file);
      // The baseline's own flat shards and descriptor are literal tool data: ordinary stray debt, as the planner records them.
      if (/^packages\/codemap\/data\/baselines\/lints\/(?:index|[a-zA-Z]+-\d{3})\.json$/u.test(file)) add('strays', file, 1, 'literal tool metadata');
      if (!testFile(file)) graph.set(cell, graph.get(cell) ?? new Set());
    } else if (!pathMapMetadata && !cellBaselineMetadata && !shimBaselineMetadata && !transitionMetadata && !rootAllowed(file)) add('strays', file, 1, `outside cells and the root allowlist; next: ${strayNextStep(file)}`);
    const source = files.get(file).toString('utf8');
    if (!files.get(file).includes(0) && Buffer.from(source).equals(files.get(file))) {
      const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
      if (lines > 500) add('fileSize', file, lines - 500, lines > 1500 ? 'exceeds hard 1500-line maximum' : 'exceeds 500-line aim');
    }
    if (file.startsWith('src/') && /\.[cm]?js$/u.test(file)) {
      const code = lex(source).code.replace(/\s/gu, '');
      if (/^(?:export(?:\*|\{[^}]*\})from(?:''|"");)+$/u.test(code) && edges.get(file)?.length) add('shims', file);
    }
  }
  for (const [file, imports] of edges) for (const { target, specifier } of imports) {
    const from = cellOf(file), to = cellOf(target);
    if (!(from && from === to) && (specifier.startsWith('.') || specifier.startsWith('#') && specifier.slice(1).includes('/') || target.startsWith('apps/'))) {
      add('boundaries', `${file}->${target}`, 1, specifier);
    }
    if (from && to && from !== to && !testFile(file) && !testFile(target)) graph.get(from)?.add(to);
  }
  for (const edge of cycleEdges(graph)) add('cycles', edge);
  while (pending.length) {
    const file = pending.pop();
    if (reachable.has(file) || testFile(file)) continue;
    reachable.add(file);
    for (const { target } of edges.get(file) ?? []) if (!testFile(target)) pending.push(target);
  }
  for (const file of files.keys()) if (file !== TRANSITION_FILE && file !== 'packages/codemap/data/baselines/lints/shim-counts.json' && !/^packages\/codemap\/data\/plan\/path-map\/[a-z][a-z0-9-]*\.json$/u.test(file)
    && !/^packages\/codemap\/data\/baselines\/lints\/cells\/[a-z][a-z0-9-]*\.json$/u.test(file)
    && (cellOf(file) || /^(?:src|bin|relay)\//u.test(file)) && !testFile(file) && !reachable.has(file)) add('unreachable', file, 1, 'not reached from an app front door by known production imports');
  const packages = new Set([...files.keys()].map(cellOf).filter(cell => cell?.startsWith('packages/')));
  for (const cell of [...packages].sort()) if (!reachable.has(cell + '/index.js')) add('unreachablePackages', cell, 1, 'package front door is not reached from an app');
  const exports = exportReachability(files, edges, reachable);
  for (const row of exports.debt) add('unreachableExports', row.key, 1, row.reason);
  unknown.push(...exports.unknown);
  const marker = committedCellTransition(root);
  if (marker.problem) unknown.push({ file: TRANSITION_FILE, reason: marker.problem });
  for (const row of unknown) add('unknown', `${row.file}:${row.specifier ?? ''}:${row.reason}`, 1, row.reason);
  for (const value of Object.values(metrics)) value.findings.sort((a, b) => a.key.localeCompare(b.key));
  const hasPathMap = files.has('path-map.json') || [...files.keys()].some(file => file.startsWith('packages/codemap/data/plan/path-map/'));
  const snapshot = cellSourceSnapshot(root);
  const pathMap = snapshot ? Object.fromEntries(pathMapFromFiles(snapshot.files, snapshot.entries))
    : hasPathMap ? Object.fromEntries(readPathMap(root)) : {};
  // #1527 ends at the first committed package move; #1781's exact marker preserves advisory growth until #1770 deletes it.
  const witness = Object.entries(pathMap).find(([, target]) => target.startsWith('packages/')) ?? null;
  const transition = marker.active
    ? { item: 1781, until: 1770, active: true, witness: TRANSITION_FILE }
    : { item: 1527, until: 1395, active: !marker.present && witness === null, witness };
  return { version: 1, metrics, unknown, transition, shimTargets: Object.fromEntries(metrics.shims.findings.map(row => [row.key, edges.get(row.key)?.[0]?.target ?? row.key])), rootMode: rootInfo.mode, roots: rootInfo.roots, pathMap, qualification: 'Known production file and individual export reach from declared transitional entrypoints or real app front doors; tests never seed reach. Opaque bindings/loaders remain named debt, not proven reachable.' };
}
