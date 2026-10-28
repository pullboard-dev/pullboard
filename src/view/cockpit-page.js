import { cockpitMarkup } from './cockpit-markup.js';
import { cockpitLive } from './cockpit-live.js';
import { cockpitReplay } from './cockpit-replay.js';
import { cockpitSidebar } from './cockpit-sidebar.js';
import { cockpitRoadmap } from './cockpit-roadmap.js';
import { cockpitProse } from './cockpit-prose.js';
import { milestoneRowHtml } from './roadmap-render.js';
import { readMilestoneModel } from './roadmap-render.js';
import { roadmapCardsHtml } from './roadmap-render.js';
import { groupActivityModel } from './group-render.js';
import { groupNeedsHtml } from './group-render.js';
import { groupEventHtml } from './group-render.js';
import { lifecycleEvent } from '../item-list.js';
import { lifecycleMove } from '../item-list.js';
import { revealSegmentedChoices } from './seg-toggle.js';
import { segmentedToggle } from './seg-toggle.js';
import { activityWords } from './activity-words.js';
import { sharedRowHtml } from './row-component.js';
import { activityModel } from './activity-model.js';
import { activityFilters } from './activity-render.js';
import { lifecycleChart } from './lifecycle-chart.js';
import { activityHtml } from './activity-render.js';
import { dashboardModel } from './dashboard-model.js';
import { dashboardHtml } from './dashboard-render.js';
import { dashboardRuntime } from './dashboard-runtime.js';
import { releaseNotice } from './release-notice.js';
import { sharingPresentation } from './sharing-invitation.js';
import { hostedReleaseDistance } from './hosted-release.js';
import { hostedReleaseInfo } from './hosted-release.js';
import { hostedReleaseNote } from './hosted-release.js';
import { effectiveGuards } from '../machine.js';
import { IN_STATE } from '../machine.js';
import { MACHINE } from '../machine.js';
import { STAR_KEY } from './star.js';
import { starMarkup } from './star.js';
import { commandPhrases } from '../help.js';
import { personNeeds } from '../row-decision-text.js';
import { homeCapacity } from './home.js';
import { homeRules } from './home.js';
import { drawHosted } from './hosted.js';
import { hostedBrowser } from './hosted.js';
import { hostedMarkup } from './hosted.js';
import { hostedState } from './hosted.js';
import { staleChip } from './stale.js';
import { pageStartup } from './page-startup.js';
import { tabValue } from './page-startup.js';
import { roadmapHeaders } from './roadmap-summary.js';
import { roadmapSummary } from './roadmap-summary.js';
import { roadmapBlock } from './roadmap-block.js';
import { openPageDialog } from './page-dialog.js';
import { closePageDialog } from './page-dialog.js';
import { pageRenderScript } from './page-render.js';
import { applyStateDelta } from '../api-http.js';
import { pageScriptPart1 } from './page-script-1.js';
import { pageScriptPart2 } from './page-script-2.js';
import { pageScriptPart3 } from './page-script-3.js';
import { pageScriptPart4 } from './page-script-4.js';
import { settingsMarkup } from './settings-page.js';
import { settingsPageScript } from './settings-page.js';
import { agentApprovalScript } from './agent-approval.js';
import { historyLoadingScript } from './history-loading.js';
/** The CLI's default phrases, ordered by depth for the existing prose inventory guard. */
export const PULLBOARD_COMMANDS = Object.freeze(commandPhrases().sort((left, right) => right.split(' ').length - left.split(' ').length));
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
 * item lifecycle from src/machine.js with this board's counts. Under 900px wide the sidebar folds
 * into a top bar. Forms post actions that the server runs as CLI commands (N27), so the page never
 * decides a rule itself, and every field a person types in sits outside what the refresh rebuilds.
 * Its styles are src/view.css, which it links with the session's secret as every request carries it;
 * styles stay in that separate file so its policy can refuse inline styles. The serving host
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
 * @param {{snapshot?: boolean, readOnly?: boolean, requests?: boolean, transportModule?: string|null, apiBase?: string, apiHeaders?: Record<string, string>, stylesheet?: string, paths?: boolean, hostedLocal?: boolean, relaySession?: boolean, signIn?: string|null, hostedReleaseVersion?: string, hostedReleaseVersions?: string[]|null}} [options] - Served connection and assets, optional person requests over a read-only transport, host routes, a static page with event replay, or the hosted page that reads this machine's view first.
 * @returns {string}
 */
export function cockpitPage(key = '', { snapshot = false, readOnly = false, requests = false, transportModule = null, apiBase = '', apiHeaders = { 'x-pullboard-key': key }, stylesheet = null, paths = false, hostedLocal = false, relaySession = false, signIn = null, hostedReleaseVersion, hostedReleaseVersions = null } = {}) {
  // Derive the current CLI inventory for every served, relay or exported page.
  const COMMAND_SOURCE = 'pullboard (?:' + commandPhrases().join('|') + ')(?![\\w-])(?: (?:--?[\\w-]+|\\d+|#\\d+|"[^"\\n]*"|[A-Z][A-Z0-9_]*|[\\w-]*[\\/.:@][^\\s"]*|[a-z]+-\\d+)(?![\\w-]))*';

  if (transportModule !== null && (typeof transportModule !== 'string' || !transportModule.trim())) throw new TypeError('transportModule must be a non-empty module URL or null');
  const connection = JSON.stringify(transportModule ? { base: '', headers: {} } : { base: apiBase.replace(/\/$/, ''), headers: apiHeaders }).replace(/</g, '\\u003c');
  const moduleOption = JSON.stringify(transportModule).replace(/</g, '\\u003c');
  const requestMode = Boolean(readOnly && requests && !snapshot && transportModule);
  if (signIn !== null && (typeof signIn !== 'string' || !signIn.startsWith('/') || signIn.startsWith('//'))) throw new TypeError('signIn must be a path on the hosting site, or null');
  const hostedOptions = JSON.stringify({ local: Boolean(hostedLocal) && !snapshot, relaySession: Boolean(relaySession), signIn }).replace(/</g, '\\u003c');
  const releaseHosted = Boolean(hostedLocal) && !snapshot;
  const releaseInfo = hostedReleaseInfo(hostedReleaseVersion, hostedReleaseVersions, releaseHosted);
  const css = stylesheet ?? (snapshot ? 'view.css' : transportModule ? '/view.css' : '/view.css?k=' + encodeURIComponent(key));
  const cssAttribute = css.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const pageScope = { sharedRowHtml, activityWords, activityModel, activityHtml, activityFilters, lifecycleChart, segmentedToggle, revealSegmentedChoices, dashboardModel, dashboardHtml, dashboardRuntime, releaseNotice, STAR_KEY, applyStateDelta, closePageDialog, connection, drawHosted, hostedBrowser, hostedOptions, hostedReleaseDistance, hostedReleaseNote, homeCapacity, homeRules, hostedState, lifecycle, lifecycleEvent, lifecycleMove, moduleOption, openPageDialog, pageStartup, paths, personNeeds, readOnly, releaseHosted, releaseInfo, requestMode, roadmapBlock, roadmapHeaders, roadmapSummary, sharingPresentation, snapshot, staleChip, tabValue, transportModule };
  const sections = { cssAttribute, hostedLocal, snapshot, readOnly, requestMode, hostedMarkup, signIn, settingsMarkup, starMarkup,
    pageScope, pageScriptPart1, pageScriptPart2, pageScriptPart3, COMMAND_SOURCE, groupActivityModel, groupNeedsHtml, groupEventHtml,
    milestoneRowHtml, readMilestoneModel, roadmapCardsHtml, releaseNotice, pageRenderScript, settingsPageScript,
    agentApprovalScript, pageScriptPart4, historyLoadingScript };
  return cockpitMarkup(sections) + cockpitLive(sections) + cockpitReplay(sections) + cockpitSidebar(sections)
    + cockpitRoadmap(sections) + cockpitProse(sections);
}
