import { cockpitMarkup } from "../../logic/cockpit/markup.js";
import { cockpitLive } from "../../logic/cockpit/live.js";
import { cockpitReplay } from "../../logic/cockpit/replay.js";
import { cockpitSidebar } from "../../logic/cockpit/sidebar.js";
import { cockpitProjectMenu } from "../../logic/cockpit/project-menu.js";
import { cockpitRoadmap } from "./roadmap.js";
import { cockpitProse } from "../../logic/cockpit/prose.js";
import { costTabScript } from "../cost/tab.js";
import { milestoneRowHtml } from "../roadmap/render.js";
import { readMilestoneModel } from "../roadmap/render.js";
import { roadmapRemainingCount } from "../roadmap/render.js";
import { roadmapCardsHtml } from "../roadmap/render.js";
import { groupActivityModel } from "../../logic/render/group.js";
import { groupNeedsHtml } from "../../logic/render/group.js";
import { groupEventHtml } from "../../logic/render/group.js";
import { lifecycleEvent } from "../../../../../packages/items/index.js";
import { lifecycleMove } from "../../../../../packages/items/index.js";
import { revealSegmentedChoices } from "../../logic/reveal.js";
import { segmentedToggle } from "../../logic/reveal.js";
import { activityWords } from "../../logic/activity/words.js";
import { sharedRowHtml } from "../../logic/component.js";
import { activityModel } from "../../logic/activity/model.js";
import { activityFilters } from "../../logic/activity/render.js";
import { lifecycleChart } from "../../logic/lifecycle/chart.js";
import { activityHtml } from "../../logic/activity/render.js";
import { activityFlow } from "../../logic/activity/flow.js";
import { activityPageHtml } from "../../logic/activity/page.js";
import { activityTipHtml } from "../../logic/activity/page.js";
import { activityStep } from "../../logic/activity/slot.js";
import { activityStart } from "../../logic/activity/slot.js";
import { activityRuntime } from "../activity/runtime.js";
import { dashboardModel } from "../dashboard/model.js";
import { dashboardHtml } from "../../logic/render/dashboard.js";
import { comparisonHtml } from "../../logic/render/comparison.js";
import { dashboardRuntime } from "../dashboard/runtime.js";
import { releaseNotice } from "../../logic/notice.js";
import { relayCauseMessage } from "../../logic/relay-cause.js";
import { startupFailureLine } from "../../logic/relay-cause.js";
import { deriveMilestoneForecasts } from "../../logic/page/milestone-merge.js";
import { approveMessage } from "../../logic/approve-message.js";
import { sharingPresentation } from "../../logic/invitation.js";
import { hostedReleaseDistance } from "../release.js";
import { hostedReleaseInfo } from "../release.js";
import { hostedReleaseNote } from "../release.js";
import { effectiveGuards } from "../../../../../packages/state/index.js";
import { IN_STATE } from "../../../../../packages/state/index.js";
import { MACHINE } from "../../../../../packages/state/index.js";
import { STAR_KEY } from "../star.js";
import { starMarkup } from "../star.js";
import { starRepository } from "../star.js";
import { personNeeds } from "../../../../../packages/spec/index.js";
import { homeCapacity } from "../../logic/home.js";
import { homeRules } from "../../logic/home.js";
import { drawHosted } from "../../logic/hosted.js";
import { hostedBrowser } from "../../logic/hosted.js";
import { hostedMarkup } from "../../logic/hosted.js";
import { hostedState } from "../../logic/hosted.js";
import { staleChip } from "../../logic/stale.js";
import { pageStartup } from "../../logic/page/startup.js";
import { tabValue } from "../../logic/page/startup.js";
import { roadmapHeaders } from "../../logic/summary/roadmap.js";
import { roadmapSummary } from "../../logic/summary/roadmap.js";
import { roadmapBlock } from "../roadmap/block.js";
import { openPageDialog } from "../../logic/page/dialog.js";
import { closePageDialog } from "../../logic/page/dialog.js";
import { pageRenderScript } from "../page/render.js";
import { applyStateDelta } from "../../../../../packages/api/index.js";
import { expandItemSummaries } from "../../logic/summary/state.js";
import { pageScriptPart1 } from "../../logic/page/session.js";
import { pageScriptPart2 } from "../page/connect.js";
import { pageScriptPart3 } from "../page/boards.js";
import { pageScriptPart4 } from "../page/actions.js";
import { paletteScript } from "../palette/index.js";
import { accountScript } from "../page/account.js";
import { shoutsScript } from "../page/shouts.js";
import { menuScript } from "../page/menu.js";
import { settingsMarkup } from "../../logic/settings/page.js";
import { settingsPageScript } from "../../logic/settings/page.js";
import { agentApprovalScript } from "../../logic/agent/approval.js";
import { historyLoadingScript } from "../history.js";
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
export function cockpitPage(key = '', { snapshot = false, readOnly = false, requests = false, transportModule = null, apiBase = '', apiHeaders = { 'x-pullboard-key': key }, stylesheet = null, paths = false, hostedLocal = false, relaySession = false, signIn = null, hostedReleaseVersion, hostedReleaseVersions = null, costPrices = null, milestoneDelta = null, commandPhrases } = {}) {
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
  const pageScope = { approveMessage, firstRunCoordinate, sharedRowHtml, activityWords, activityModel, activityHtml, activityFilters, activityFlow, activityPageHtml, activityTipHtml, activityStep, activityStart, activityRuntime, lifecycleChart, segmentedToggle, revealSegmentedChoices, dashboardModel, dashboardHtml, comparisonHtml, dashboardRuntime, releaseNotice, deriveMilestoneForecasts, milestoneForecast: milestoneDelta?.forecast ?? null, relayCauseMessage, startupFailureLine, STAR_KEY, applyStateDelta, expandItemSummaries, closePageDialog, connection, costPrices: privateCostPrices, costTabScript, drawHosted, hostedBrowser, hostedOptions, hostedReleaseDistance, hostedReleaseNote, homeCapacity, homeRules, hostedState, lifecycle, lifecycleEvent, lifecycleMove, moduleOption, openPageDialog, pageStartup, paths, personNeeds, privateCost, readOnly, releaseHosted, releaseInfo, requestMode, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, snapshot, staleChip, tabValue, transportModule };
  const repositoryAttribute = starRepository().replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const sections = { repositoryAttribute, cssAttribute, hostedLocal, snapshot, readOnly, requestMode, privateCost, hostedMarkup, signIn, settingsMarkup, starMarkup,
    pageScope, pageScriptPart1, pageScriptPart2, pageScriptPart3, COMMAND_SOURCE, groupActivityModel, groupNeedsHtml, groupEventHtml,
    milestoneRowHtml, readMilestoneModel, roadmapRemainingCount, roadmapCardsHtml, releaseNotice, pageRenderScript, settingsPageScript,
    agentApprovalScript, pageScriptPart4, historyLoadingScript, paletteScript, accountScript, shoutsScript, menuScript };
  return cockpitMarkup(sections) + cockpitLive(sections) + cockpitReplay(sections) + cockpitSidebar(sections) + cockpitProjectMenu()
    + cockpitRoadmap(sections) + cockpitProse(sections);
}
