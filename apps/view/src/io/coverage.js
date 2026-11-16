/** Source-only view test policy. Roles do not change browser admission or supply execution evidence [N26,C7]. */
import { posix } from 'node:path';
import { lex } from "../../../../packages/kernel/browser.js";
import { lineAt } from "../../../../packages/kernel/browser.js";
import { freeWindowOffsets } from "../logic/offsets.js";

/** Reviewed renderer coverage; a journey never substitutes for these data-in/HTML-out witnesses. */
export const VIEW_RENDERER_COVERAGE = Object.freeze([
  { module: 'apps/view/src/logic/needs/actions.js', names: ['agentApprovalActionsHtml', 'needsActionsHtml'], tests: ['apps/view/tests/logic/needs/actions.test.js'] },
  { module: 'apps/view/src/io/roadmap/render.js', names: ['readMilestoneModel', 'roadmapRemainingCount', 'milestoneRowHtml', 'roadmapCardsHtml'], tests: ['apps/view/tests/logic/summary/roadmap/pure.test.js'] },
  { module: 'apps/view/src/logic/render/verdict.js', names: ['verdictHtml', 'visibleVerdictNote'], tests: ['apps/view/tests/logic/render/verdict.test.js'] },
  { module: 'apps/view/src/logic/pipeline/model.js', names: ['replayItem', 'pipelineStage', 'pipelineSince', 'itemListFields', 'withdrawnFromStatus', 'itemStagePresentation', 'itemStageKey', 'stageSentence'], tests: ['apps/view/tests/logic/pipeline/model.test.js'] },
  { module: 'apps/view/src/logic/render/group.js', names: ['groupActivityModel', 'groupNeedsHtml', 'groupEventHtml'], tests: ['apps/view/tests/logic/render/group.test.js'] },
  { module: 'apps/view/src/logic/settings/render.js', names: ['settingsMarkup', 'settingsContentHtml'], tests: ['apps/view/tests/logic/hosted/render.test.js'] },
  { module: 'apps/view/src/logic/render/star.js', names: ['starHtml'], tests: ['apps/view/tests/logic/hosted/render.test.js'] },
  { module: 'apps/view/src/logic/hosted/render.js', names: ['hostedMarkup', 'hostedBrowser', 'hostedState'], tests: ['apps/view/tests/logic/hosted/render.test.js'] },
  { module: 'apps/view/src/logic/segmented.js', names: ['segmentedToggle'], tests: ['apps/view/tests/logic/segmented.test.js'] },
  { module: 'apps/view/src/logic/panel/model.js', names: ['agentsPanelModel', 'shoutsModel'], tests: ['apps/view/tests/logic/panel/model/pure.test.js'] },
  { module: 'apps/view/src/logic/panel/render.js', names: ['agentsPanelHtml', 'shoutsHtml'], tests: ['apps/view/tests/logic/panel/model/pure.test.js'] },
  { module: 'apps/view/src/logic/timeline/body.js', names: ['timelineBodyHtml'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/timeline/render.js', names: ['timelineHtml'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/selection.js', names: ['selectItemsView'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/rules.js', names: ['ruleListModel'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/component.js', names: ['sharedRowHtml'], tests: ['apps/view/tests/logic/component.test.js'] },
  { module: 'packages/spec/light.js', names: ['personNeeds'], tests: ['apps/view/tests/logic/needs/summary/data.test.js'] },
  { module: 'apps/view/src/io/held.js', names: ['heldNote', 'heldChip'], tests: ['apps/view/tests/logic/needs/summary/data.test.js'] },
  { module: 'apps/view/src/logic/home.js', names: ['homeCapacity'], tests: ['apps/view/tests/logic/home.test.js'] },
  { module: 'apps/view/src/logic/row.js', names: ['recordRowHtml'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/pipeline/render.js', names: ['pipelineHtml'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/lifecycle/chart.js', names: ['lifecycleChart'], tests: ['apps/view/tests/logic/lifecycle/chart.test.js'] },
  { module: 'apps/view/src/logic/lifecycle/diagram.js', names: ['lifecycleDiagramHtml'], tests: ['apps/view/tests/logic/main.test.js'] },

  { module: 'apps/view/src/io/dashboard/model.js', names: ['dashboardModel'], tests: ['apps/view/tests/io/dashboard/model.test.js'] },
  { module: 'apps/view/src/logic/render/dashboard.js', names: ['dashboardHtml'], tests: ['apps/view/tests/logic/render/dashboard.test.js'] },
  { module: 'apps/view/src/logic/activity/model.js', names: ['activityModel'], tests: ['apps/view/tests/logic/activity/model/sentences.test.js'] },
  { module: 'apps/view/src/logic/activity/render.js', names: ['activityHtml', 'activityFilters'], tests: ['apps/view/tests/logic/activity/model/sentences.test.js'] },
  { module: 'apps/view/src/logic/activity/words.js', names: ['activityWords'], tests: ['apps/view/tests/logic/activity/model/sentences.test.js'] },
  { module: 'apps/view/src/logic/needs/panel.js', names: ['needsPanelModel', 'needsPanelHtml', 'itemsNeedsModel', 'itemsNeedsHtml'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/needs/list.js', names: ['needsEntries', 'renderNeedsRow'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/summary/roadmap.js', names: ['roadmapSummary', 'roadmapHeaders'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/io/roadmap/block.js', names: ['roadmapBlock'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/home.js', names: ['homeRules'], tests: ['apps/view/tests/logic/main.test.js'] },
  { module: 'apps/view/src/logic/agent/floor/model.js', names: ['agentFloorModel'], tests: ['apps/view/tests/logic/agent/floor/model.test.js'] },
  { module: 'apps/view/src/logic/agent/floor/render.js', names: ['agentFloorHtml'], tests: ['apps/view/tests/logic/agent/floor/model.test.js'] },
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
      const freeWindows = freeWindowOffsets(source);
      for (const match of code.matchAll(/\b(?:process|global|globalThis|window|document|navigator|eval|Function)\b/gu)) {
        if (!propertyName(code, match.index, match[0]) && (match[0] !== 'window' || freeWindows.has(match.index))) {
          issue(root, file, lineAt(source, match.index), 'logic reaches ambient execution/DOM port ' + match[0]);
        }
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
