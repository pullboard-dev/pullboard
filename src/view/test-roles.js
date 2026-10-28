/** Explicit test roles are an inventory, not completion evidence or a browser-admission exemption [N26,C7]. */
export const VIEW_TEST_ROLES = Object.freeze({
  "test/cockpit/verdict-pure.test.js": {
    "kind": "logic",
    "reason": "Review notes and metadata render through the actual verdict functions with prepared links and explicit labels; no page or native review is fabricated."
  },
  "test/cockpit/pipeline-pure.test.js": {
    "kind": "logic",
    "reason": "Full snapshot and summary stage projections use canonical event matching and explicit lifecycle data; native API and Chrome pipeline navigation remain journeys."
  },
  "test/cockpit/group-pure.test.js": {
    "kind": "logic",
    "reason": "Cross-repository history selection and Needs/event HTML receive plain observations plus explicitly prepared rich fields, without a native board or browser."
  },
  "test/cockpit/auxiliary-pure.test.js": {
    "kind": "logic",
    "reason": "Settings rows, hosted state and star markup run over supplied data, without the manifest reader, network reader or DOM writer."
  },
  "test/cockpit/needs-data.test.js": {
    "kind": "logic",
    "reason": "Explicit board-shaped values exercise person-only obligations, proposal eligibility, held clocks and HTML without a native board or browser."
  },
  "test/cockpit/lifecycle-chart.test.js": {
    "kind": "journey",
    "reason": "Actual native boards, authenticated API state and Chrome prove chart toggles, storage and every route at desktop and phone widths."
  },
  "test/cockpit/lifecycle-returns.test.js": {
    "kind": "journey",
    "reason": "Native release, escalation, retained and expired refreeze and lapse receipts are checked through API counts and real Chrome chart words at two widths."
  },
  "test/cockpit/lifecycle-chart-pure.test.js": {
    "kind": "logic",
    "reason": "Original declared-route labels and exact count assertions call lifecycleChart with data; native receipt and Chrome journeys remain separate."
  },
  "test/cockpit/row-component.test.js": {
    "kind": "journey",
    "reason": "A real local HTTP page and Chrome verify shared row geometry, clipping, mouse disclosure and keyboard collapse; plain HTML assertions live in row-component-pure."
  },
  "test/cockpit/row-component-pure.test.js": {
    "kind": "logic",
    "reason": "Original shared-row escaping, attributes and variant assertions invoke the real HTML function without the separate Chrome geometry journey."
  },
  "test/cockpit/home-capacity-pure.test.js": {
    "kind": "logic",
    "reason": "Original measured-capacity, unknown, stale and label assertions invoke the production presenter over plain inputs; Chrome refresh and layout stay separate."
  },
  "test/cockpit/segmented-control-pure.test.js": {
    "kind": "logic",
    "reason": "Original segmented markup, escaping and pressed-state assertions invoke the real HTML-only component without the DOM adapter or native fixture."
  },
  "test/cockpit/activity-codegen.test.js": {
    "kind": "adapter",
    "reason": "Generated timestamp regex escapes are a script contract; separate from actual Activity model and HTML witnesses."
  },
  "test/cockpit/agents-panel-pure.test.js": {
    "kind": "logic",
    "reason": "Seeded agent and item observations invoke the actual Agents selection and HTML functions without a browser or native board."
  },
  "test/cockpit/agents-panel-codegen.test.js": {
    "kind": "adapter",
    "reason": "Generated page-script syntax and embedded function contract; separate from actual data-to-HTML witnesses."
  },
  "test/cockpit/seg-toggle.test.js": {
    "kind": "journey",
    "reason": "Actual native board and Chrome measurements exercise choices, counts, focus and touch geometry across four panes; its markup assertions still need a separate logic witness."
  },
  "test/cockpit/upgrade-geometry.test.js": {
    "kind": "journey",
    "reason": "Actual private CLI version change, server restart and Chrome navigation verify upgrade presentation, storage and desktop/phone geometry."
  },
  "test/cockpit/retained-refreeze-timeline.test.js": {
    "kind": "journey",
    "reason": "Genuine native claim, corrected criterion and retained refreeze through API history/thread and desktop/phone Chrome timeline."
  },
  "test/cockpit/activity-sentences.test.js": {
    "kind": "logic",
    "reason": "Fixed event-shaped data invokes actual Activity model, words and HTML; all original assertions retained without native fixtures."
  },
  "test/cockpit/activity.test.js": {
    "kind": "journey",
    "reason": "activity: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/addresses.test.js": {
    "kind": "journey",
    "reason": "addresses: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/agent-floor.test.js": {
    "kind": "logic",
    "reason": "Nine original Agent Floor assertions over deterministic summary and event-shaped data; no native setup."
  },
  "test/cockpit/agents-exclude-board-actors.test.js": {
    "kind": "journey",
    "reason": "agents-exclude-board-actors: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/agents.test.js": {
    "kind": "journey",
    "reason": "agents: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/approvals.test.js": {
    "kind": "journey",
    "reason": "approvals: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/auth.test.js": {
    "kind": "journey",
    "reason": "auth: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/blueprint-fit.test.js": {
    "kind": "journey",
    "reason": "blueprint-fit: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/dashboard-api-journey.test.js": {
    "kind": "journey",
    "reason": "Actual native summary/history HTTP shape, complete prefix, claim/review lease and merge receipt binding"
  },
  "test/cockpit/dashboard-clock.test.js": {
    "kind": "journey",
    "reason": "dashboard-clock: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/dashboard-model.test.js": {
    "kind": "logic",
    "reason": "dashboard-model.test.js: seeded data invokes actual pure render/model exports without native fixtures"
  },
  "test/cockpit/dashboard-render.test.js": {
    "kind": "logic",
    "reason": "dashboard-render.test.js: seeded data invokes actual pure render/model exports without native fixtures"
  },
  "test/cockpit/dashboard-row-visibility.test.js": {
    "kind": "journey",
    "reason": "dashboard-row-visibility: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/dashboard-runtime.test.js": {
    "kind": "adapter",
    "reason": "dashboard-runtime: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/dashboard.test.js": {
    "kind": "journey",
    "reason": "dashboard: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/demo.test.js": {
    "kind": "journey",
    "reason": "demo: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/detail.test.js": {
    "kind": "journey",
    "reason": "detail: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/doctrine.test.js": {
    "kind": "journey",
    "reason": "doctrine: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/export-fetch.test.js": {
    "kind": "journey",
    "reason": "export-fetch: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/fixture.test.js": {
    "kind": "journey",
    "reason": "fixture: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/home.test.js": {
    "kind": "journey",
    "reason": "home: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/import-style.test.js": {
    "kind": "adapter",
    "reason": "import-style: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/item-waits.test.js": {
    "kind": "journey",
    "reason": "item-waits: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/items-empty.test.js": {
    "kind": "journey",
    "reason": "items-empty: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/items.test.js": {
    "kind": "journey",
    "reason": "items: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/journey-routes.test.js": {
    "kind": "adapter",
    "reason": "journey-routes: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/lan.test.js": {
    "kind": "journey",
    "reason": "lan: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/layout.test.js": {
    "kind": "journey",
    "reason": "layout: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/live.test.js": {
    "kind": "journey",
    "reason": "live: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/local-origin.test.js": {
    "kind": "journey",
    "reason": "local-origin: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/milestone-limit.test.js": {
    "kind": "journey",
    "reason": "milestone-limit: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/milestone-order.test.js": {
    "kind": "journey",
    "reason": "milestone-order: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/needs-panel.test.js": {
    "kind": "journey",
    "reason": "needs-panel: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/needs-sentinel-draft.test.js": {
    "kind": "journey",
    "reason": "needs-sentinel-draft: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/needs.test.js": {
    "kind": "journey",
    "reason": "needs: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/newcomer.test.js": {
    "kind": "journey",
    "reason": "newcomer: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/open-board.test.js": {
    "kind": "journey",
    "reason": "open-board: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/perf.test.js": {
    "kind": "adapter",
    "reason": "perf: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/projector.test.js": {
    "kind": "journey",
    "reason": "projector: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/projects.test.js": {
    "kind": "journey",
    "reason": "projects: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/prose.test.js": {
    "kind": "journey",
    "reason": "prose: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/provenance.test.js": {
    "kind": "adapter",
    "reason": "provenance: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/public-export.test.js": {
    "kind": "journey",
    "reason": "public-export: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/references.test.js": {
    "kind": "journey",
    "reason": "references: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/relay.test.js": {
    "kind": "journey",
    "reason": "relay: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/rigor-view.test.js": {
    "kind": "journey",
    "reason": "rigor-view: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/roadmap-held.test.js": {
    "kind": "journey",
    "reason": "roadmap-held: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/roadmap.test.js": {
    "kind": "journey",
    "reason": "roadmap: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/scope.test.js": {
    "kind": "journey",
    "reason": "scope: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/search.test.js": {
    "kind": "journey",
    "reason": "search: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/settings-context.test.js": {
    "kind": "journey",
    "reason": "settings-context: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/settings.test.js": {
    "kind": "journey",
    "reason": "settings: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/shared-wait-browser.test.js": {
    "kind": "journey",
    "reason": "shared-wait-browser: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/shout-overlap.test.js": {
    "kind": "journey",
    "reason": "shout-overlap: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/shouts.test.js": {
    "kind": "journey",
    "reason": "shouts: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/snapshot.test.js": {
    "kind": "journey",
    "reason": "snapshot: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/spec-revision.test.js": {
    "kind": "journey",
    "reason": "spec-revision: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/spec.test.js": {
    "kind": "journey",
    "reason": "spec: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/stable.test.js": {
    "kind": "adapter",
    "reason": "stable: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/state-plan.test.js": {
    "kind": "adapter",
    "reason": "state-plan: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/stats.test.js": {
    "kind": "journey",
    "reason": "stats: existing real browser interaction/layout or native CLI/API fixture; pure assertions must also have independent renderer witnesses"
  },
  "test/cockpit/tab-speed.test.js": {
    "kind": "adapter",
    "reason": "tab-speed: existing source/VM/transport contract, not a pure-render witness"
  },
  "test/cockpit/view-pure.test.js": {
    "kind": "logic",
    "reason": "view-pure.test.js: seeded data invokes actual pure render/model exports without native fixtures"
  },
  "test/cockpit/activity-journey.test.js": {
    "kind": "journey",
    "reason": "Real native health recording, HTTP projection and Chrome interactions on desktop and phone."
  },
  "test/cockpit/agent-floor-journey.test.js": {
    "kind": "journey",
    "reason": "Original native board setup, actual API shape contracts and real desktop/phone Chrome navigation and live refresh."
  }
});
