/** A browser the relay knows as paired but whose storage was cleared is told why; a never-paired one keeps the old wording [H5,H15,#1010]. @pullboard-test-input source-cell apps/relay */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyBoardStep } from "../../../index.js";
import { installBrowserTransport } from "../../fixtures/browser-transport.js";
import { registerBrowserAliases } from "../../fixtures/browser-transport.js";

registerBrowserAliases();
const { createTransport } = await import("../../../src/io/browser/client.js");

const BOARD = "0123456789abcdef0123456789abcdef";
const BOARDS = { version: 1, boards: [{ id: BOARD, repository: "owner/project" }] };
const AVAILABLE = [{ id: BOARD, repository: "owner/project" }];

test("relay.io-browser-notice.a-known-device-with-empty-storage-is-told: clause 1: a known device with empty storage is told its pairing was lost because site storage was cleared, with one re-pair step [H5,#1010]", () => {
  const step = emptyBoardStep({ available: AVAILABLE, loaded: true, browserPaired: false, knownDevice: true });
  assert.equal(step.title, "This browser lost its pairing");
  assert.match(step.say, /site storage was cleared/u);
  assert.equal(step.command, "pullboard relay pair --new-browser");
});

test("relay.io-browser-notice.a-never-paired-browser-keeps-its-wording: clause 2: a never-paired browser still gets This browser is not paired with the same wording as before [H5,#1010]", () => {
  const step = emptyBoardStep({ available: AVAILABLE, loaded: true, browserPaired: false, knownDevice: false });
  assert.equal(step.title, "This browser is not paired");
  assert.equal(step.say, "Your account already has linked boards. Pair this browser to open them.");
  assert.equal(step.command, "pullboard relay pair --new-browser");
});

/** Run the client with empty device storage and return the title it drew on the pairing screen. */
async function drawnTitle(session) {
  const responses = { "/api/v1/boards": BOARDS, "/api/v1/devices/approvals": { version: 1, links: [] },
    "/api/v1/devices/exclusions": { version: 1, exclusions: [] }, "/api/v1/devices/session": session };
  const stand = installBrowserTransport({ responses });
  try {
    const drawn = {};
    const node = (name) => (drawn[name] ??= { dataset: {}, hidden: false, textContent: "", querySelector: (inner) => node(inner), replaceChildren() {}, append() {} });
    const panel = node("panel");
    const root = globalThis.document.documentElement;
    root.querySelector = (selector) => (selector.includes("data-screen=\"share\"") ? panel : null);
    globalThis.document.createElement = () => ({ dataset: {}, setAttribute() {}, append() {}, replaceChildren() {}, remove() {}, addEventListener() {} });
    const original = globalThis.document.getElementById;
    globalThis.document.getElementById = (id) => (id === "relay-notice" ? node("notice") : original(id));
    await createTransport();
    return drawn.h1?.textContent;
  } finally { stand.restore(); }
}

test("relay.io-browser-notice.the-client-passes-knowndevice-from-the-relay: clause 3: the client passes knownDevice from the relay device record into the screen it draws [H5,#1010]", async () => {
  assert.equal(await drawnTitle({ version: 1, account: "7", knownDevice: true }), "This browser lost its pairing");
  assert.equal(await drawnTitle({ version: 1, account: "7", knownDevice: false }), "This browser is not paired");
});
