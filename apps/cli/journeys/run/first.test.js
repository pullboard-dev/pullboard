/** First-run shows only until the loop is proven running, and recognises an existing coordinator [N26,N38], and its copy line names pullboard coordinate once that command exists (#2193). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cockpitPage,
  firstRunKit,
} from "../../../view/index.js";
import {
  cliCockpitRenderer$cockpitPage as cliCockpitPage,
  commandPhrases,
} from "../../index.js";

const kit = firstRunKit();
const established = {
  agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator', model: 'gpt-6' }, { agent_id: 'tests-1', agent_lane: 'tests', model: 'unknown' }],
  spec: [{ id: 'G1', status: 'approved' }],
  dashboardLanded: Array.from({ length: 1700 }, (_, at) => ({ id: at })),
};

test('an established board with a coordinator and landed items shows no first-run [N26,N38]', () => {
  const state = kit.model(established, []);
  assert.equal(state.ticks[0], true, 'a coordinator that identified itself before first-run existed is recognised');
  assert.equal(kit.visible(state, false), false, 'the loop is proven, so first-run is gone');
});

test('a new board shows first-run with the right ticks [N26,N38]', () => {
  const fresh = kit.model({ agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator', model: null }] }, []);
  assert.deepEqual(fresh.ticks, [false, false, false, false, false, false, false], 'the init placeholder is not a running coordinator');
  assert.equal(kit.visible(fresh, false), true);
  assert.match(kit.html(fresh), /Create your Coordinator Agent/u);
});

test('the checklist completes once the coordinator joins and an item lands, and the page then goes [N26,N38]', () => {
  const placeholder = { agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator' }] };
  const landed = [{ event_kind: 'merged' }];
  assert.equal(kit.visible(kit.model(placeholder, landed), false), true, 'an item landed but no coordinator has joined');
  const joined = { agents: [{ agent_id: 'coordinator-1', agent_lane: 'coordinator' }] };
  assert.equal(kit.model(joined, []).ticks[0], true, 'the coordinator joins');
  assert.equal(kit.visible(kit.model(joined, []), false), true, 'a coordinator alone has not proven the loop');
  assert.equal(kit.visible(kit.model(joined, landed), false), false, 'a coordinator and a landed item prove the loop');
});

const SKILL_LINE = 'Use the pullboard-run skill: be this project&#39;s coordinator. Keep listening, run builder and verifier subagents, and help me add more agents.';
const APPROVED_LINE = 'Run pullboard coordinate';
const fresh = () => firstRunKit().model({ agents: [{ agent_id: 'coordinator', agent_lane: 'coordinator', model: null }] }, []);
const copyLine = html => html.match(/<div class="first-run-line"><code>([^<]*)<\/code>/u)?.[1];

test('clause 1: once the coordinate command exists, the first-run line reads Run pullboard coordinate (#2193) [N26,N38]', () => {
  const coordinateKit = firstRunKit({ coordinate: true });
  assert.equal(copyLine(coordinateKit.html(fresh())), APPROVED_LINE, 'the approved line, word for word');
  assert.equal(coordinateKit.copy, APPROVED_LINE, 'the Copy button copies the approved line');
});

test('clause 2: until #2068 lands, the first-run line keeps the current skill text (#2193) [N26,N38]', () => {
  assert.equal(copyLine(firstRunKit().html(fresh())), SKILL_LINE, 'the kit without the command keeps the skill line');
  const exists = commandPhrases().includes('coordinate');
  assert.match(cliCockpitPage(''), new RegExp('\\{ coordinate: ' + exists + ' \\}', 'u'), 'the served page follows the real CLI catalog, so it flips by itself when #2068 adds the command');
  const without = cockpitPage('', { commandPhrases: () => commandPhrases().filter(phrase => phrase !== 'coordinate') });
  assert.match(without, /\{ coordinate: false \}/u, 'a catalog without coordinate keeps the skill line');
});

test('clause 3: the served page flips to the approved line as soon as the CLI catalog has coordinate, with no other change (#2193) [N26,N38]', () => {
  const phrases = () => [...commandPhrases(), 'coordinate'];
  const page = cockpitPage('', { commandPhrases: phrases });
  const embedded = page.match(/kit: \((function firstRunKit[\s\S]*?\n\})\)\((\{ coordinate: (?:true|false) \})\)/u);
  assert.ok(embedded, 'the page embeds the kit and the switch it is built with');
  assert.equal(embedded[2], '{ coordinate: true }', 'a catalog with coordinate turns the switch on');
  const kit = new Function('return (' + embedded[1] + ')(' + embedded[2] + ');')();
  assert.equal(copyLine(kit.html(fresh())), APPROVED_LINE, 'the embedded kit shows Run pullboard coordinate');
});
