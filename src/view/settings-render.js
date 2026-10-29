/** Render the Settings pane; its only controls navigate scopes or refresh a GET. */
export function settingsMarkup() {
  return '<section data-pane="settings" class="card-panel" id="settings-pane" aria-label="Settings" hidden><div class="settings-heading"><div><p class="eyebrow">This computer</p><h2>Settings</h2><p>See what is configured, where it comes from, and what it changes.</p></div><button class="ghost" type="button" data-settings-open>All local boards</button></div><div id="settings-content" aria-live="polite"></div></section>';
}

/** Render a read-only API inventory, preserving false, zero, null and masked values as distinct data [O5,O6,N26]. */
export function settingsContentHtml(entry, scope = 'machine') {
  /** Escape API labels and values before placing them in text or attributes. */
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** Keep the API's value type visible instead of treating false or zero as absent. */
  const settingText = value => value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const descriptions = {
  "gateSlots": "Local test runs allowed at once.",
  "browserSlots": "Local browser runs allowed at once.",
  "gate.shortSlots": "Extra slots reserved for short named checks.",
  "gate.runnerWaitMs": "How long a check waits for a registered runner.",
  "gate.queue.reviewsFirst": "Put review checks ahead of build checks.",
  "gate.queue.currentReleaseFirst": "Put current-release work first.",
  "gate.queue.agingMinutes": "Waiting time before queued work gains priority.",
  "gate.memoryFloorMB": "Pause new checks below this free-memory level.",
  "gate.browserFreeChecks": "Allow browser-free checks without a browser slot.",
  "gate.browserByLaunch": "Classify browser work by actual Chrome launches.",
  "gate.runnersFirst": "Try registered runners before local capacity.",
  "gate.runnersOnly": "Require registered runners for submit and review checks.",
  "health.sentinel": "Observe board health automatically.",
  "view.background": "Keep the local view running after setup and resume.",
  "view.port": "Port used by this computer’s local view.",
  "relay.offerAtInit": "Offer device sharing during setup.",
  "runners": "Registered test hosts and their capacity.",
  "landing.pools": "Boards this computer helps land.",
  "spec": "File containing the approved specification.",
  "practice": "File containing the project’s doctrine.",
  "gate": "Command that runs the project’s tests.",
  "staticChecks": "Source checks run before tests.",
  "check.install": "Setup command for a private check.",
  "check.timeout": "Maximum duration of a frozen check.",
  "lease": "How long a build claim lasts.",
  "reviewLease": "How long a review reservation lasts.",
  "claims.releaseGone": "Release work held by inactive seats.",
  "worktrees": "Where agent checkouts are placed.",
  "submit.requireInfraNote": "Require an explanation for test or infrastructure changes.",
  "itemSizeBudget": "Change-size budget used for review.",
  "submitInvariants": "Tests that always run at submission.",
  "registryGuards": "Source guards selected for registry changes.",
  "verify.policy": "Who may independently review work.",
  "verify.family": "Required relationship between reviewer and builder families.",
  "verify.reviewRatio": "Review-to-build scheduling ratio.",
  "families": "Names treated as the same model family.",
  "verify.unrelatedTrunkMoves": "Allow unrelated trunk moves during review.",
  "verify.composeAtAdmission": "Compose with current trunk when review starts.",
  "map.slice": "Show a relevant code-map slice with assigned work.",
  "agents.names": "How agent names are displayed.",
  "inbox.tokenBudget": "Maximum size of an inbox response.",
  "claim.reopenFirstRefusalMinutes": "Repair window reserved for the original builder.",
  "claim.barTestFiles": "File patterns accepted in frozen checks.",
  "lanes": "File ownership, specification ownership, and starting rules.",
  "products": "Products and their specification rows.",
  "shared": "File patterns shared across lanes.",
  "fix": "Allowed automatic fix commands and files.",
  "project": "Displayed project name.",
  "name": "Displayed repository name.",
  "checks.provesNothing": "Handling for checks that establish no proof.",
  "flakes.rerun": "Allow reruns of flaky tests.",
  "flakes.quarantine": "Allow isolation of flaky tests.",
  "rigor.budget": "Maximum non-test lines a change may add.",
  "relay.outbox": "Send board updates through the relay outbox.",
  "submitGate": "Where the full selected test suite runs.",
  "submitDeferAbove": "Number of selected files above which tests defer to landing.",
  "landingShards": "Parallel test partitions used at landing.",
  "landing.publish": "Whether publishing runs separately from landing.",
  "landing.pauseOnRed": "Pause landing after a failed publish suite.",
  "landing.environment": "Required platform, architecture, and Node version.",
  "positiveControl": "Known-good command the gate must pass.",
  "affectedTests": "Runner command for selected test files.",
  "testConcurrency.files": "Test files allowed to run at once.",
  "testConcurrency.browser": "Browser test files allowed to run at once.",
  "approvers": "GitHub accounts allowed to act as the person.",
  "relay.autoLink": "Link local boards to device sharing automatically.",
  "relay.excluded": "Repositories excluded from automatic linking.",
  "relay.owner.account": "Account that owns device sharing.",
  "relay.owner.url": "Origin of the sharing service.",
  "relay.session.token": "Whether this device has a sharing credential; its value is hidden.",
  "relay.token": "Whether this board has a sharing credential; its value is hidden.",
  "relay.agentTokens": "Whether agent sharing credentials are present; values are hidden.",
  "relay.key": "Whether a board encryption key is present; its value is hidden.",
  "relay.deleted": "Whether this board’s sharing connection was removed.",
  "relay.url": "Origin of this board’s sharing service.",
  "relay.board": "Identifier of the linked remote board.",
  "relay.agent": "Agent identity used for sharing.",
  "relay.personReauth": "Require renewed person authentication.",
  "relay.keyStorage": "Where this board’s encryption key is stored.",
  "commits.types": "Allowed commit types.",
  "commits.maxHeader": "Maximum commit-header length.",
  "commits.requireIds": "Commit types that must cite specification identifiers.",
  "commits.banned": "Text forbidden in commit headers.",
  "commits.noEmoji": "Refuse emoji in commit messages.",
  "commits.noCoAuthor": "Refuse co-author trailers.",
  "commits.noHostName": "Refuse this computer’s hostname in commits.",
  "protect.blocked": "File patterns excluded from changes.",
  "protect.allowed": "Exceptions to blocked file patterns.",
  "protect.secrets": "Scan changes for secret-shaped text.",
  "line.route.liveOnly": "Offer work only to live seats.",
  "line.order": "Use board-controlled queue ordering.",
  "line.focusMilestone": "Milestone prioritized when assigning work.",
  "line.reviewsFirst": "Offer reviews before builds.",
  "line.requireReviewFamilies": "Require declared reviewer families.",
  "line.wipPerReviewer": "Work-in-progress limit per available reviewer.",
  "line.barReady": "Require a ready criterion before claiming work.",
  "line.bar.check": "Require an executable frozen check.",
  "line.bar.sharpenToPerson": "Send unclear criteria to the person.",
  "line.takeoverMinutes": "Wait before another builder takes inactive work.",
  "line.collisionFreeBatch": "Keep colliding changes out of the same landing batch.",
  "line.landingBatchSize": "Maximum items in one landing batch.",
  "line.landingCadenceMinutes": "Time between landing batches."
};
  /** Explain each supported setting without interpreting or changing its value. */
  const description = key => descriptions[key] || (key.startsWith('resources.') ? 'Concurrent users allowed for this named resource.' : key.startsWith('testEconomics.') ? 'Cost assigned to this outcome, in equivalent seconds.' : 'Project-defined configuration value.');
  const labels = { machine: 'This machine', repo: 'This repo', board: 'This board' };
  const scopes = Object.entries(labels).map(([key, label]) => '<button type="button" role="tab" data-settings-scope="' + key + '" aria-selected="' + (key === scope) + '">' + label + '</button>').join('');
  const rows = (entry.rows || []).filter(row => row.scope === scope);
  const cells = rows.map(row => '<tr data-setting-key="' + esc(row.key) + '"' + (row.error ? ' class="setting-invalid"' : '') + '><th scope="row"><code>' + esc(row.key) + '</code><span class="setting-description">' + esc(description(row.key)) + '</span>' + (row.root ? '<small class="setting-root">' + esc(row.root) + '</small>' : '') + '</th><td>' + esc(row.secret ? (row.value === 'set' ? 'set' : 'not set') : settingText(row.value)) + '</td><td>' + esc(row.secret ? 'not set' : settingText(row.default)) + '</td><td>' + esc(row.source) + (row.origin ? ' <span class="setting-origin">' + esc(row.origin) + '</span>' : '') + (row.error ? '<p class="setting-error" role="alert">' + esc(row.error.message) + ' ' + esc(row.error.fix) + '</p>' : '') + '</td></tr>').join('');
  return '<div class="settings-toolbar"><div><p class="settings-context">' + esc(entry.context || 'This computer') + '</p><div class="seg settings-scopes" role="tablist" aria-label="Settings scope">' + scopes + '</div></div><button class="ghost" type="button" data-settings-refresh>Refresh settings</button></div>'
    + (entry.error ? '<p class="setting-error" role="alert">' + esc(entry.error) + '</p>' : '')
    + (entry.loading ? '<p role="status">Loading settings…</p>' : '<div class="settings-table"><table><thead><tr><th>Setting</th><th>Value</th><th>Default</th><th>Source</th></tr></thead><tbody>' + cells + '</tbody></table></div>' + (!rows.length && !entry.error ? '<p>No settings in this scope.</p>' : ''));

}

