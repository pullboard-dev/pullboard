/** Shared scratch-crate board for the Rust journeys: cargo lookup, a crate board with one seat, build-and-submit and accept-and-land [C7,#10387]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { homedir } from 'node:os';
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


/** The account's own rustup home: a runner job's fresh HOME holds a half toolchain with no rustc, so cargo needs this one. */
const REAL_RUSTUP = join(userInfo().homedir || homedir(), '.rustup');
const RUSTUP_ENV = existsSync(REAL_RUSTUP) ? { ...process.env, RUSTUP_HOME: REAL_RUSTUP } : process.env;

/** The path a rustup proxy resolves to, or '' when rustup or the tool is missing. */
function rustupWhich(tool) {
  const found = spawnSync('rustup', ['which', tool], { env: RUSTUP_ENV, encoding: 'utf8', timeout: 5000 });
  const path = found.error || found.status !== 0 ? '' : String(found.stdout).trim();
  return path.startsWith('/') ? path : '';
}

/**
 * The environment a gate needs to run cargo, or null when this machine has no working cargo.
 * Why: Homebrew's rustup is keg-only, so cargo is on no job PATH; the same lookup the real-cargo test in the gate cell uses [#10382,#10386].
 */
function cargoEnvironment() {
  const direct = spawnSync('cargo', ['--version'], { env: RUSTUP_ENV, encoding: 'utf8', timeout: 5000 });
  const cargo = !direct.error && direct.status === 0 ? '' : rustupWhich('cargo');
  if (direct.error || direct.status !== 0) {
    if (!cargo) return null;
    const answer = spawnSync(cargo, ['--version'], { env: RUSTUP_ENV, encoding: 'utf8', timeout: 5000 });
    if (answer.error || answer.status !== 0) return null;
  }
  const rustc = rustupWhich('rustc');
  const folders = [cargo && dirname(cargo), rustc && dirname(rustc)].filter(Boolean);
  return { folders: [...new Set(folders)], ...(existsSync(REAL_RUSTUP) ? { RUSTUP_HOME: REAL_RUSTUP } : {}), ...(rustc ? { RUSTC: rustc } : {}) };
}

export const CARGO = cargoEnvironment();
export const UNAVAILABLE = 'cargo unavailable on this machine';

const BRIEF = 'Files:\n- src/item.rs\nChange:\n- Add the item test.\nTest:\n- cargo test passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
export const CHECK = "grep -q 'add(1, 2)' src/item.rs";
const MANIFEST = '[package]\nname = "scratch_crate"\nversion = "0.1.0"\nedition = "2021"\n';
export const MATH = 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n';
const LIB = 'pub mod math;\n\n#[cfg(test)]\nmod item;\n';
export const PASSING = '#[test]\nfn adds_small_numbers() {\n    assert_eq!(crate::math::add(1, 2), 3);\n}\n';
export const BROKEN = '#[test]\nfn adds_small_numbers() {\n    assert_eq!(crate::math::add(1, 2), 4);\n}\n';
const BASE_ITEM = '#[test]\nfn adds_nothing() {\n    assert_eq!(crate::math::add(0, 0), 0);\n}\n';

/** A sandbox whose gate and runner see cargo: the variables are set before the first command starts the runner. */
export function cargoSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  const { folders, ...cargoVariables } = CARGO ?? { folders: [] };
  box.env.PATH = [...folders, box.env.PATH].join(':');
  Object.assign(box.env, cargoVariables, { CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: join(box.dir, 'target'), CARGO_TERM_COLOR: 'never' });
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch crate's files into a folder. */
export function writeCrate(root) {
  for (const [path, text] of [['Cargo.toml', MANIFEST], ['.gitignore', 'target/\nCargo.lock\n'], ['src/lib.rs', LIB], ['src/math.rs', MATH], ['src/item.rs', BASE_ITEM]]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A scratch board on the crate: init'd, one lane owning the crate, the crate committed on main, and one joined seat. */
export async function crateBoard(helpers) {
  const box = cargoSandbox(helpers, { landing: { cargoFailures: true } });
  const repo = join(box.dir, 'repo');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'config', 'user.name', 'Test Agent');
  box.git(repo, 'config', 'user.email', 'agent@example.com');
  writeCrate(repo);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: the scratch crate');
  const initialized = await box.runLocal(repo, 'init');
  assert.equal(initialized.code, 0, initialized.err);
  const config = JSON.parse(readFileSync(join(repo, 'pullboard.json'), 'utf8'));
  assert.equal(String(config.gate?.command ?? config.gate), 'cargo test', 'init recorded the detected gate');
  fixtureProjectPolicy(repo, {
    config: { ...config, verify: 'any', lanes: { web: { owns: ['src/', 'Cargo.toml', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The crate adds. | gate: cargo test\n',
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
  writeFileSync(join(web, 'src/item.rs'), itemText);
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
    const verdict = await verifySettled(box, box.runLocal, repo, ['verify', item, 'accept', '--as', 'coordinator', '--note', 'scratch crate gate is green']);
    assert.equal(verdict.code, 0, verdict.err);
  } finally { box.git(repo, 'switch', '-q', 'main'); }
  const landing = await box.runIn(repo, 'land', '--json');
  return { landing, settled: await settleLand(box, JSON.parse(landing.out)) };
}

