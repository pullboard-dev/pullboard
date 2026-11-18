/** Shared scratch-project board for the Elixir journeys: mix lookup, a mix project board with one seat, build-and-submit and accept-and-land [C7,#10619]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { settleLand } from '../land/settle.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { verifySettled } from '../submit/settle.js';
import { joinFixtureSeat } from '../testkit.js';
import { fileFixtureItem } from '../testkit.js';
import { fixtureProjectPolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/**
 * The folder a gate needs to run mix (and the elixir and erl beside it), or null when this machine has no working mix.
 * Why: a runner job's PATH may lack the toolchain's folder, so the sandbox adds the folder mix was found in [#10619].
 */
function mixEnvironment() {
  const probe = spawnSync('mix', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (probe.error || probe.status !== 0) return null;
  const found = String(spawnSync('sh', ['-c', 'command -v mix'], { encoding: 'utf8', timeout: 5000 }).stdout).trim();
  return found.startsWith('/') ? { folders: [dirname(found)] } : null;
}

export const MIX = mixEnvironment();
export const UNAVAILABLE = 'mix unavailable on this machine';
export const GATE = 'mix test';

const BRIEF = 'Files:\n- test/item_test.exs\nChange:\n- Add the item test.\nTest:\n- mix test passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
const CHECK = "grep -q 'Calc.add(1, 2)' test/item_test.exs";
const PROJECT = 'defmodule Calc.MixProject do\n  use Mix.Project\n\n  def project do\n    [app: :calc, version: "0.1.0", elixir: "~> 1.12", deps: []]\n  end\nend\n';
const CALC = 'defmodule Calc do\n  def add(a, b), do: a + b\nend\n';
const HEADER = 'defmodule ItemTest do\n  use ExUnit.Case\n\n';
export const PASSING = `${HEADER}  test "adds small numbers" do\n    assert Calc.add(1, 2) == 3\n  end\nend\n`;
export const BROKEN = `${HEADER}  test "adds small numbers" do\n    assert Calc.add(1, 2) == 4\n  end\nend\n`;
const BASE_ITEM = `${HEADER}  test "adds nothing" do\n    assert Calc.add(0, 0) == 0\n  end\nend\n`;

/** A sandbox whose gate and runner see mix in a UTF-8 locale: the variables are set before the first command starts the runner. */
export function mixSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  box.env.PATH = [...(MIX?.folders ?? []), box.env.PATH].join(':');
  box.env.LANG = 'en_US.UTF-8';
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch mix project's files into a folder: mix.exs is the Elixir signal. */
export function writeProject(root) {
  const files = [['mix.exs', PROJECT], ['lib/calc.ex', CALC], ['.gitignore', '_build/\ndeps/\n.pullboard/junit/\n'], ['test/test_helper.exs', 'ExUnit.start()\n'], ['test/item_test.exs', BASE_ITEM]];
  for (const [path, text] of files) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A scratch board on the project: init'd, one lane owning it, the project committed on main, and one joined seat. */
export async function mixBoard(helpers) {
  const box = mixSandbox(helpers);
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  writeProject(repo);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: the scratch project');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), GATE, 'init recorded the detected gate');
  fixtureProjectPolicy(repo, {
    config: { ...config, verify: 'any', lanes: { web: { owns: ['mix.exs', 'lib/', 'test/', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The project adds. | gate: mix test\n',
  });
  box.git(repo, 'add', '-A');
  const configured = box.tryGit(repo, 'commit', '-q', '-m', 'chore: set up pullboard');
  assert.equal(configured.status, 0, configured.stderr);
  const remote = join(box.dir, 'origin.git');
  box.git(box.dir, 'init', '-q', '--bare', remote);
  box.git(repo, 'remote', 'add', 'origin', remote);
  assert.equal(box.tryGit(repo, 'push', '-q', '-u', 'origin', 'main').status, 0);
  const web = join(box.dir, 'web-1');
  box.git(repo, 'worktree', 'add', '-q', web, '-b', 'web/one');
  const joined = await joinFixtureSeat(box, web, 'web', { run: box.runLocal });
  assert.equal(joined.code, 0, joined.err);
  Object.assign(box, { repo, web });
  return { box, repo, web };
}

/** File and claim one item in the seat, then commit a new item test and try to submit it; returns the item id, commit and submit result. */
export async function buildAndSubmit(board, id, itemText, priorReds = 0) {
  const { box, repo, web } = board;
  const item = id ?? String((await fileFixtureItem(box, repo, { lane: 'web', title: 'Add numbers', brief: BRIEF, check: CHECK, args: ['--specs', 'G1'], run: box.runLocal })).item_id);
  if (!id) assert.equal((await box.runLocal(web, 'claim', item)).code, 0);
  writeFileSync(join(web, 'test/item_test.exs'), itemText);
  box.git(web, 'add', '-A');
  const committed = box.tryGit(web, 'commit', '-q', '-m', `feat(web): test adding numbers [G1]`);
  assert.equal(committed.status, 0, committed.stderr);
  const submitted = await box.runIn(web, 'submit', item, '--no-next');
  // The pulled gate may still be running when submit returns: read the item until it is red again or has left the building state.
  const reds = text => (text.match(/Gate job \S+ red at/gu) ?? []).length;
  const read = async () => {
    const shown = await box.runIn(web, 'show', item, '--no-next');
    const status = JSON.parse((await box.runIn(web, 'show', item, '--json', '--no-next')).out).item_status;
    return status !== 'claimed' || reds(shown.out) > priorReds ? { shown, status } : null;
  };
  const { shown, status } = await whenRunnerSettles(box.env, read, { deadlineMs: 150_000, what: `the gate of item ${item}` });
  return { item, reds: reds(shown.out), commit: box.git(web, 'rev-parse', 'HEAD'), submitted, shown, status, text: `${submitted.out}\n${submitted.err}\n${shown.out}\n${shown.err}` };
}

/** Accept the submitted item as the coordinator at its commit, then land it; returns the settled landing. */
export async function acceptAndLand(board, item, commit) {
  const { box, repo } = board;
  box.git(repo, 'switch', '-q', '--detach', commit);
  try {
    const verdict = await verifySettled(box, box.runLocal, repo, ['verify', item, 'accept', '--as', 'coordinator', '--note', 'scratch project gate is green']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(repo, 'switch', '-q', 'main'); }
  const landing = await box.runIn(repo, 'land', '--json');
  return { landing, settled: await settleLand(box, JSON.parse(landing.out)) };
}
