// pullboard: browser
/** @pullboard-test-input source-cell apps/cli */
/** @pullboard-test-gui */
/** A tab-speed setup stage whose event never fires fails within its limit naming the stage, and a marker that never appears is refused [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../tests/fixtures/child.js';
import { measureTabSpeed } from '../../../tests/fixtures/cockpit/perf/speed.mjs';
import { waitForMarker } from '../../../tests/fixtures/cockpit/perf/stress-cache.mjs';

/** Stub Chrome and view server whose first load never reports the page loaded. */
function stubDeps(overrides) {
  const chrome = {
    send: async () => ({}),
    navigate: async () => {},
    waitFor: () => new Promise(() => {}),
    stable: async () => undefined,
    close: async () => {},
  };
  return {
    findChromeExecutable: () => '/stub/chrome',
    startChrome: async () => chrome,
    stableChrome: value => value,
    press: async () => {},
    startView: async () => ({ link: { href: 'http://127.0.0.1:1/' } }),
    stopView: async () => {},
    ...overrides,
  };
}

test('cli.journeys-spec-cockpit-tab-speed-stage-timeout.a-first-load-whose-event-never: clause 2: a first load whose event never fires fails within the limit naming the stage [C7]', async () => {
  const { root: workspace } = privateFixtureFiles('tab-speed-stage-');
  await assert.rejects(measureTabSpeed({ workspace }, ['items'], stubDeps({ firstLoadLimit: 50 })), /stage "first load" did not finish within 5\.05 s/);
});

test('cli.journeys-spec-cockpit-tab-speed-stage-timeout.a-server-start-that-never-answers: clause 2: a server start that never answers fails within the stage limit naming the stage [C7]', async () => {
  const { root: workspace } = privateFixtureFiles('tab-speed-stage-');
  const deps = stubDeps({ stageMs: 100, startView: () => new Promise(() => {}) });
  await assert.rejects(measureTabSpeed({ workspace }, ['items'], deps), /stage "server start" did not finish within 0\.1 s/);
});

const POLL = 10, LIMIT = 100;

test('cli.journeys-spec-cockpit-tab-speed-stage-timeout.a-cache-marker-that-never-appears: clause 2: a cache marker that never appears is refused naming board generation [C7]', async () => {
  const { root } = privateFixtureFiles('tab-speed-marker-');
  await assert.rejects(waitForMarker(`${root}/complete`, POLL, LIMIT), /stage "board generation" saw no cache marker/);
});
