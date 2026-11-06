import { cockpitMarkup } from "../../core/view/cockpit-markup.js";
import { cockpitLive } from "../../core/view/cockpit-live.js";
import { cockpitReplay } from "../../core/view/cockpit-replay.js";
import { cockpitSidebar } from "../../core/view/cockpit-sidebar.js";
import { cockpitRoadmap } from "./cockpit-roadmap.js";
import { cockpitProse } from "../../core/view/cockpit-prose.js";
import { costTabScript } from "./cost-tab.js";
import { milestoneRowHtml } from "./roadmap-render.js";
import { readMilestoneModel } from "./roadmap-render.js";
import { roadmapRemainingCount } from "./roadmap-render.js";
import { roadmapCardsHtml } from "./roadmap-render.js";
import { groupActivityModel } from "../../core/view/group-render.js";
import { groupNeedsHtml } from "../../core/view/group-render.js";
import { groupEventHtml } from "../../core/view/group-render.js";
import { lifecycleEvent } from "../../../../../packages/items/index.js";
import { lifecycleMove } from "../../../../../packages/items/index.js";
import { revealSegmentedChoices } from "../../core/view/seg-toggle.js";
import { segmentedToggle } from "../../core/view/seg-toggle.js";
import { activityWords } from "../../core/view/activity-words.js";
import { sharedRowHtml } from "../../core/view/row-component.js";
import { activityModel } from "../../core/view/activity-model.js";
import { activityFilters } from "../../core/view/activity-render.js";
import { lifecycleChart } from "../../core/view/lifecycle-chart.js";
import { activityHtml } from "../../core/view/activity-render.js";
import { dashboardModel } from "./dashboard-model.js";
import { dashboardHtml } from "../../core/view/dashboard-render.js";
import { dashboardRuntime } from "./dashboard-runtime.js";
import { releaseNotice } from "../../core/view/release-notice.js";
import { sharingPresentation } from "../../core/view/sharing-invitation.js";
import { hostedReleaseDistance } from "./hosted-release.js";
import { hostedReleaseInfo } from "./hosted-release.js";
import { hostedReleaseNote } from "./hosted-release.js";
import { effectiveGuards } from "../../../../../packages/state/index.js";
import { IN_STATE } from "../../../../../packages/state/index.js";
import { MACHINE } from "../../../../../packages/state/index.js";
import { STAR_KEY } from "./star.js";
import { starMarkup } from "./star.js";
import { starRepository } from "./star.js";
import { personNeeds } from "../../../../../packages/spec/index.js";
import { homeCapacity } from "../../core/view/home.js";
import { homeRules } from "../../core/view/home.js";
import { drawHosted } from "../../core/view/hosted.js";
import { hostedBrowser } from "../../core/view/hosted.js";
import { hostedMarkup } from "../../core/view/hosted.js";
import { hostedState } from "../../core/view/hosted.js";
import { staleChip } from "../../core/view/stale.js";
import { pageStartup } from "../../core/view/page-startup.js";
import { tabValue } from "../../core/view/page-startup.js";
import { roadmapHeaders } from "../../core/view/roadmap-summary.js";
import { roadmapSummary } from "../../core/view/roadmap-summary.js";
import { roadmapBlock } from "./roadmap-block.js";
import { openPageDialog } from "../../core/view/page-dialog.js";
import { closePageDialog } from "../../core/view/page-dialog.js";
import { pageRenderScript } from "./page-render.js";
import { applyStateDelta } from "../../../../../packages/api/index.js";
import { expandItemSummaries } from "../../core/view-state-summary.js";
import { pageScriptPart1 } from "../../core/view/page-script-1.js";
import { pageScriptPart2 } from "./page-script-2.js";
import { pageScriptPart3 } from "./page-script-3.js";
import { pageScriptPart4 } from "./page-script-4.js";
import { settingsMarkup } from "../../core/view/settings-page.js";
import { settingsPageScript } from "../../core/view/settings-page.js";
import { agentApprovalScript } from "../../core/view/agent-approval.js";
import { historyLoadingScript } from "./history-loading.js";
/**
 * The item lifecycle as the page draws it (M1): each state with what it means and, for a final
 * state, what every way in checks; each move with who makes it, its command or the clock's
 * condition, and the rules it checks in order, each with the code it refuses with. The page lays
 * this out itself, so the drawing is the declaration and cannot go stale.
 *
 * @returns {{ initial: string, states: object[], moves: object[] }}
 */
function lifecycle() {
  const guards = new Map(MACHINE.guards.map((guard) => [guard.id, guard]));
  const rule = (move, id) => (id === IN_STATE ? `the item is ${move.from.join(' or ')} (${move.refuse})` : `${guards.get(id).rule} (${guards.get(id).refuse})`);
  return {
    initial: MACHINE.initial,
    states: MACHINE.states.map((state) => ({ id: state.id, means: state.means, final: Boolean(state.final), entry: (MACHINE.exitGuards[state.id] ?? []).map((id) => guards.get(id).rule) })),
    moves: MACHINE.moves.map((move) => ({ verb: move.verb, from: move.from, to: move.to, by: move.by, how: move.command ?? `when ${move.when}`, checks: effectiveGuards(move).map((id) => rule(move, id)) })),
  };
}
/**
 * The page `pullboard view` serves (N26): one self-contained file, no assets from anywhere, that
 * reads the board through the server's JSON and follows its events. The layout is the one the person
 * asked for: a sidebar listing every project on the machine with what needs them there, and a main
 * column with the tabs over two panes, a list and the selected thing's detail. Activity draws the
 * item lifecycle from the state cell with this board's counts. Under 900px wide the sidebar folds
 * into a top bar. Forms post actions that the server runs as CLI commands (N27), so the page never
 * decides a rule itself, and every field a person types in sits outside what the refresh rebuilds.
 * Its shared styles are src/view.css plus Doctrine and item-panel presentation from
 * src/view/doctrine.css and src/view/item-panel.css; the authenticated local view appends private Cost styles
 * from src/view/cost.css. The linked stylesheet carries the session's secret, so the policy refuses inline styles. The serving host
 * supplies the API base and credential headers; clients need no loopback-specific connection.
 * The Roadmap tab has its own address (N38): /roadmap on a host that serves the page there too,
 * which `paths` declares, and a #roadmap fragment anywhere else, such as a snapshot hosted under a
 * folder, where a path the host does not serve would leave a reload with nothing.
 * The hosted page at https://app.pullboard.dev passes hostedLocal (N26, #513): on this machine it reads the local view
 * and any linked relay boards through their own transports; local boards are writable, relay boards remain read-only.
 * On another device it uses the relay when relaySession says the request has a session, and otherwise explains how to
 * connect or sign in.
 *
 * @param {string} [key] - The session's secret.
 * @param {{snapshot?: boolean, readOnly?: boolean, requests?: boolean, transportModule?: string|null, apiBase?: string, apiHeaders?: Record<string, string>, stylesheet?: string, paths?: boolean, hostedLocal?: boolean, relaySession?: boolean, signIn?: string|null, hostedReleaseVersion?: string, hostedReleaseVersions?: string[]|null, costPrices?: Record<string, {freshInput?: number, cacheReadInput?: number, cacheWriteInput?: number, output?: number}>|null}} [options] - Served connection and assets, optional person requests over a read-only transport, host routes, a static page with event replay, or the hosted page that reads this machine's view first.
 * @returns {string}
 */
export function cockpitPage(key = '', { snapshot = false, readOnly = false, requests = false, transportModule = null, apiBase = '', apiHeaders = { 'x-pullboard-key': key }, stylesheet = null, paths = false, hostedLocal = false, relaySession = false, signIn = null, hostedReleaseVersion, hostedReleaseVersions = null, costPrices = null, commandPhrases } = {}) {
  if (typeof commandPhrases !== 'function') throw new TypeError('the page needs its higher renderer to provide commandPhrases');
  // Derive the current CLI inventory for every served, relay or exported page.
  const COMMAND_SOURCE = 'pullboard (?:' + commandPhrases().join('|') + ')(?![\\w-])(?: (?:--?[\\w-]+|\\d+|#\\d+|"[^"\\n]*"|[A-Z][A-Z0-9_]*|[\\w-]*[\\/.:@][^\\s"]*|[a-z]+-\\d+)(?![\\w-]))*';

  if (transportModule !== null && (typeof transportModule !== 'string' || !transportModule.trim())) throw new TypeError('transportModule must be a non-empty module URL or null');
  const connection = JSON.stringify(transportModule ? { base: '', headers: {} } : { base: apiBase.replace(/\/$/, ''), headers: apiHeaders }).replace(/</g, '\\u003c');
  const moduleOption = JSON.stringify(transportModule).replace(/</g, '\\u003c');
  const requestMode = Boolean(readOnly && requests && !snapshot && transportModule);
  // Cost is private native-session accounting; static exports, hosted pages and relay transports never expose it.
  const privateCost = !snapshot && !readOnly && !transportModule && !hostedLocal && !requestMode;
  const privateCostPrices = privateCost ? costPrices : null;
  if (signIn !== null && (typeof signIn !== 'string' || !signIn.startsWith('/') || signIn.startsWith('//'))) throw new TypeError('signIn must be a path on the hosting site, or null');
  const hostedOptions = JSON.stringify({ local: Boolean(hostedLocal) && !snapshot, relaySession: Boolean(relaySession), signIn }).replace(/</g, '\\u003c');
  const releaseHosted = Boolean(hostedLocal) && !snapshot;
  const releaseInfo = hostedReleaseInfo(hostedReleaseVersion, hostedReleaseVersions, releaseHosted);
  const css = stylesheet ?? (snapshot ? 'view.css' : transportModule ? '/view.css' : '/view.css?k=' + encodeURIComponent(key));
  const cssAttribute = css.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const firstRunCoordinate = commandPhrases().includes('coordinate');
  const pageScope = { firstRunCoordinate, sharedRowHtml, activityWords, activityModel, activityHtml, activityFilters, lifecycleChart, segmentedToggle, revealSegmentedChoices, dashboardModel, dashboardHtml, dashboardRuntime, releaseNotice, STAR_KEY, applyStateDelta, expandItemSummaries, closePageDialog, connection, costPrices: privateCostPrices, costTabScript, drawHosted, hostedBrowser, hostedOptions, hostedReleaseDistance, hostedReleaseNote, homeCapacity, homeRules, hostedState, lifecycle, lifecycleEvent, lifecycleMove, moduleOption, openPageDialog, pageStartup, paths, personNeeds, privateCost, readOnly, releaseHosted, releaseInfo, requestMode, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, snapshot, staleChip, tabValue, transportModule };
  const repositoryAttribute = starRepository().replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const sections = { repositoryAttribute, cssAttribute, hostedLocal, snapshot, readOnly, requestMode, privateCost, hostedMarkup, signIn, settingsMarkup, starMarkup,
    pageScope, pageScriptPart1, pageScriptPart2, pageScriptPart3, COMMAND_SOURCE, groupActivityModel, groupNeedsHtml, groupEventHtml,
    milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml, releaseNotice, pageRenderScript, settingsPageScript,
    agentApprovalScript, pageScriptPart4, historyLoadingScript };
  return cockpitMarkup(sections) + cockpitLive(sections) + cockpitReplay(sections) + cockpitSidebar(sections)
    + cockpitRoadmap(sections) + cockpitProse(sections);
}
