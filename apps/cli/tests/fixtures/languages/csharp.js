/** Shared scratch-project board for the C# journeys: dotnet lookup, a dotnet project board with one seat, build-and-submit and accept-and-land [C7,#10675]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { settleLand } from '../land/settle.js';
import { whenRunnerSettles } from '../runner/local-start.js';
import { verifySettled } from '../submit/settle.js';
import { joinFixtureSeat } from '../testkit.js';
import { fileFixtureItem } from '../testkit.js';
import { fixtureProjectPolicy } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { fixtureSettledMachine } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** The account's real home: a runner job's fresh HOME holds no .NET state and no NuGet cache, so every gate would restore its packages again. */
const REAL_HOME = userInfo().homedir || homedir();

/**
 * The dotnet binary, or null when this machine has no working dotnet.
 * Why: a runner job's PATH may lack dotnet's folder and its fresh HOME hides the user-level state; a wrapper on PATH carries both [#10675].
 */
function dotnetEnvironment() {
  const probe = spawnSync('dotnet', ['--version'], { env: { ...process.env, HOME: REAL_HOME, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' }, encoding: 'utf8', timeout: 60_000 });
  if (probe.error || probe.status !== 0) return null;
  const found = String(spawnSync('sh', ['-c', 'command -v dotnet'], { encoding: 'utf8', timeout: 5000 }).stdout).trim();
  return found.startsWith('/') ? { dotnet: found } : null;
}

/** Single-quote one shell word. */
const quoted = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;

/**
 * Write an executable wrapper named after the tool into the sandbox and return its folder.
 * Why: a gate job keeps only PATH from the sandbox's variables, so the wrapper carries the variables the tool needs [#10675].
 */
function wrapperFolder(box, name, variables, target) {
  const folder = join(box.dir, 'toolchain-bin');
  mkdirSync(folder, { recursive: true });
  const assignments = Object.entries(variables).map(([key, value]) => `${key}=${quoted(value)}`).join(' ');
  writeFileSync(join(folder, name), `#!/bin/sh\n${assignments} exec ${quoted(target)} "$@"\n`, { mode: 0o755 });
  return folder;
}

export const DOTNET = dotnetEnvironment();
export const UNAVAILABLE = 'dotnet unavailable on this machine';
export const GATE = 'dotnet test';

const BRIEF = 'Files:\n- ItemTests.cs\nChange:\n- Add the item test.\nTest:\n- dotnet test passes.';
/** An item check that fails on main and passes once the item's test is committed; it avoids the test name, so only the gate output can name it. */
const CHECK = "grep -q 'Calc.Add(1, 2)' ItemTests.cs";
const PROJECT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <IsPackable>false</IsPackable>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.0" />
  </ItemGroup>
</Project>
`;
const CALC = 'public static class Calc\n{\n    public static int Add(int a, int b) => a + b;\n}\n';
const HEADER = 'using Xunit;\n\npublic class ItemTests\n{\n';
export const PASSING = `${HEADER}    [Fact]\n    public void AddsSmallNumbers()\n    {\n        Assert.Equal(3, Calc.Add(1, 2));\n    }\n}\n`;
export const BROKEN = `${HEADER}    [Fact]\n    public void AddsSmallNumbers()\n    {\n        Assert.Equal(4, Calc.Add(1, 2));\n    }\n}\n`;
const BASE_ITEM = `${HEADER}    [Fact]\n    public void AddsNothing()\n    {\n        Assert.Equal(0, Calc.Add(0, 0));\n    }\n}\n`;

/** A sandbox whose gate and runner find dotnet through a wrapper that keeps the account's .NET home and NuGet cache and starts no lingering build servers: set before the first command starts the runner. */
export function dotnetSandbox(helpers, settings = {}) {
  const box = helpers.sandbox();
  if (DOTNET) {
    const variables = { DOTNET_CLI_HOME: REAL_HOME, NUGET_PACKAGES: join(REAL_HOME, '.nuget', 'packages'), DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', MSBUILDDISABLENODEREUSE: '1', UseSharedCompilation: 'false' };
    box.env.PATH = [wrapperFolder(box, 'dotnet', variables, DOTNET.dotnet), box.env.PATH].join(':');
  }
  fixtureSettledMachine(box.env.PULLBOARD_MACHINE_HOME, settings);
  return box;
}

/** Write the scratch dotnet project's files into a folder: a .csproj is the C# signal. */
export function writeProject(root) {
  for (const [path, text] of [['Calc.csproj', PROJECT], ['Calc.cs', CALC], ['.gitignore', 'bin/\nobj/\n.pullboard/junit/\n'], ['ItemTests.cs', BASE_ITEM]]) writeFileSync(join(root, path), text);
}

/** A scratch board on the project: init'd, one lane owning it, the project committed on main, and one joined seat. */
export async function dotnetBoard(helpers) {
  const box = dotnetSandbox(helpers);
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
    config: { ...config, verify: 'any', lanes: { web: { owns: ['Calc.csproj', 'Calc.cs', 'ItemTests.cs', '.gitignore'], specs: ['G1'] } }, landing: { ...(config.landing ?? {}), perItem: false, manualOverride: true, splitRed: false } },
    spec: '# Scratch spec\n\n## G · Goals\n- G1 [approved, must] The project adds. | gate: dotnet test\n',
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
  writeFileSync(join(web, 'ItemTests.cs'), itemText);
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
