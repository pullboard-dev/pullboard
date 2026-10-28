/** Source-only view test policy. Roles do not change browser admission or supply execution evidence [N26,C7]. */
import { posix } from 'node:path';
import { lex, lineAt } from '../js-lex.js';

/** Reviewed renderer coverage; a journey never substitutes for these data-in/HTML-out witnesses. */
export const VIEW_RENDERER_COVERAGE = Object.freeze([
  { module: 'src/view/segmented-control.js', names: ['segmentedToggle'], tests: ['test/cockpit/segmented-control-pure.test.js'] },
  { module: 'src/view/agents-panel-model.js', names: ['agentsPanelModel'], tests: ['test/cockpit/agents-panel-pure.test.js'] },
  { module: 'src/view/agents-panel-render.js', names: ['agentsPanelHtml'], tests: ['test/cockpit/agents-panel-pure.test.js'] },
  { module: 'src/view/timeline-render.js', names: ['timelineHtml'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/items-selection.js', names: ['selectItemsView'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/rule-list-model.js', names: ['ruleListModel'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/record-row.js', names: ['recordRowHtml'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/pipeline-render.js', names: ['pipelineHtml'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/lifecycle-diagram.js', names: ['lifecycleDiagramHtml'], tests: ['test/cockpit/view-pure.test.js'] },

  { module: 'src/view/dashboard-model.js', names: ['dashboardModel'], tests: ['test/cockpit/dashboard-model.test.js'] },
  { module: 'src/view/dashboard-render.js', names: ['dashboardHtml'], tests: ['test/cockpit/dashboard-render.test.js'] },
  { module: 'src/view/activity-model.js', names: ['activityModel'], tests: ['test/cockpit/activity-sentences.test.js'] },
  { module: 'src/view/activity-render.js', names: ['activityHtml'], tests: ['test/cockpit/activity-sentences.test.js'] },
  { module: 'src/view/activity-words.js', names: ['activityWords'], tests: ['test/cockpit/activity-sentences.test.js'] },
  { module: 'src/view/needs-panel.js', names: ['needsPanelModel', 'needsPanelHtml'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/needs-list.js', names: ['needsEntries', 'renderNeedsRow'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/roadmap-summary.js', names: ['roadmapSummary', 'roadmapHeaders'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/roadmap-block.js', names: ['roadmapBlock'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/home.js', names: ['homeRules'], tests: ['test/cockpit/view-pure.test.js'] },
  { module: 'src/view/agent-floor-model.js', names: ['agentFloorModel'], tests: ['test/cockpit/agent-floor.test.js'] },
  { module: 'src/view/agent-floor-render.js', names: ['agentFloorHtml'], tests: ['test/cockpit/agent-floor.test.js'] },
]);
const SAFE_BUILTINS = new Set(['node:test', 'node:assert', 'node:assert/strict', 'node:path', 'node:url', 'node:util']);
const BROWSER_CALLS = /\b(?:openSnapshotChrome|closeSnapshotChrome|stableChrome|chromeExecutable|openPage|requireBrowserSlot|guardChromeGroup|startView|machine|project|spawn|spawnSync|execFile|execFileSync|fork|fetch|WebSocket|XMLHttpRequest)\s*\(/gu;

/** Resolve one already-parsed relative import without touching the filesystem. */
export function viewImportTarget(file, request) {
  if (request.startsWith('node:')) return request;
  if (!request.startsWith('./') && !request.startsWith('../')) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), request));
  return target.startsWith('../') || target.startsWith('/') ? null : target;
}

/** Quote an identifier for a source-code-only regular expression. */
function pattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

/** Distinguish property names from ambient identifier reads without hiding shorthand or spread reads. */
function propertyName(code, index, name) {
  const before = code.slice(0, index).trimEnd();
  if (before.endsWith('.') && !before.endsWith('..')) return true;
  return /[,{]$/u.test(before) && /^\s*:/u.test(code.slice(index + name.length));
}

/** Identify a direct named/namespace import used as an actual call, ignoring strings and comments.
 * This proves a structural witness only. Review and mutation controls establish assertion quality.
 */
export function rendererCalled(source, file, module, name) {
  const { code, strings } = lex(source);
  for (const match of code.matchAll(/\bimport\s*(\{[^}]*\}|\*\s+as\s+\w+)\s*from\b/gu)) {
    const end = match.index + match[0].length;
    const literal = strings.find(entry => entry.start >= end && !source.slice(end, entry.start).trim());
    if (!literal || viewImportTarget(file, literal.text) !== module) continue;
    let binding = null;
    if (match[1].startsWith('*')) binding = match[1].match(/as\s+(\w+)/u)?.[1] + '.' + name;
    else for (const part of match[1].slice(1, -1).split(',')) {
      const bits = part.trim().split(/\s+as\s+/u);
      if (bits[0] === name) binding = bits[1] || name;
    }
    if (binding && new RegExp('\\b' + binding.split('.').map(pattern).join('\\s*\\.\\s*') + '\\s*\\(', 'u').test(code)) return true;
  }
  return false;
}

/** Validate explicit roles and named pure-render coverage over an immutable source/edge inventory.
 * Adapter and journey roles require recorded purposes and never satisfy renderer coverage.
 * Unknown reach is a refusal, not a reason to assume a logic test is browser-free.
 */
export function viewTestProblems({ sources, edges, unknown = new Map(), roots, roles, coverage = VIEW_RENDERER_COVERAGE, rendererExports = [] }) {
  const problems = [];
  /** Add a diagnostic that names both the logic root and the reached source. */
  const issue = (root, file, line, text) => problems.push({ path: root, line: 1, text: file + ':' + line + ': ' + text });
  for (const root of roots) {
    const role = roles[root];
    if (!role || !['logic', 'adapter', 'journey'].includes(role.kind) || !role.reason?.trim()) {
      issue(root, root, 1, 'declare a reviewed logic/adapter/journey role and concrete purpose'); continue;
    }
    if (role.kind !== 'logic') continue;
    const pending = [root], visited = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      if (!sources.has(file)) { issue(root, file, 1, 'missing reached source; logic purity is unknown'); continue; }
      if (unknown.has(file)) { issue(root, file, 1, 'unknown reach: ' + unknown.get(file)); continue; }
      const source = sources.get(file), { code } = lex(source);
      for (const match of code.matchAll(/\b(?:process|global|globalThis|window|document|navigator|eval|Function)\b/gu)) {
        if (!propertyName(code, match.index, match[0])) issue(root, file, lineAt(source, match.index), 'logic reaches ambient execution/DOM port ' + match[0]);
      }
      for (const match of code.matchAll(/\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/gu)) issue(root, file, lineAt(source, match.index), 'logic reads the ambient clock; pass a clock reading as data');
      for (const match of code.matchAll(BROWSER_CALLS)) issue(root, file, lineAt(source, match.index), 'logic reaches browser/process/IO fixture call ' + match[0].trim());
      for (const request of edges.get(file) ?? []) {
        if (request.startsWith('node:')) {
          if (!SAFE_BUILTINS.has(request)) issue(root, file, 1, 'logic reaches boundary-capable builtin ' + request);
          continue;
        }
        const target = viewImportTarget(file, request);
        if (!target) { issue(root, file, 1, 'unresolved/nonliteral import ' + request); continue; }
        if (/^(?:test\/cockpit\/fixture|test\/(?:chrome-fixture|e2e-helpers))\.[cm]?js$/u.test(target)) issue(root, file, 1, 'logic imports a native/browser journey fixture ' + target);
        else pending.push(target);
      }
    }
  }
  for (const row of rendererExports) for (const name of row.names) {
    if (!coverage.some(entry => entry.module === row.module && entry.names.includes(name))) issue(row.module, row.module, 1, 'renderer export ' + name + ' lacks an explicit logic coverage mapping');
  }
  for (const row of coverage) for (const name of row.names) {
    const witnesses = row.tests.filter(file => roles[file]?.kind === 'logic' && sources.has(file)
      && rendererCalled(sources.get(file), file, row.module, name));
    if (!witnesses.length) issue(row.tests[0] || row.module, row.module, 1,
      'missing logic witness for ' + name + '; journey/adapter labels cannot replace pure renderer coverage');
  }
  return problems.sort((a, b) => a.path.localeCompare(b.path) || a.text.localeCompare(b.text));
}
