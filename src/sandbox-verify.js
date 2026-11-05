/** Docker-compatible, fail-closed execution of outside programs. No host-process isolation fallback. */
import { execFile } from './windows-child-process.js';
import {
  createHash,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
} from 'node:path';
import {
  git,
  repoInfo,
} from './git.js';
import { Refused } from './refused.js';
import { mainPolicy } from './trusted-policy.js';

const SANDBOX_CONTAINER_HOME = '/home/sandbox';

/** Await the owned client while native physical-admission heartbeats remain live. */
function client(executable, args, options) {
  return new Promise(resolve => {
    execFile(executable, args, { encoding: 'utf8', ...options }, (error, stdout, stderr) => resolve({
      error: error && typeof error.code !== 'number' ? error : null,
      signal: error?.signal ?? null, status: error ? typeof error.code === 'number' ? error.code : null : 0,
      stdout: stdout ?? '', stderr: stderr ?? '',
    }));
  });
}

/** Docker clients receive only deliberately constructed runtime discovery, never the host's credentials. */
function clientEnvironment(directory, endpoint) {
  const home = join(directory, 'client-home');
  mkdirSync(home);
  const config = join(home, '.docker');
  mkdirSync(config);
  writeFileSync(join(config, 'config.json'), '{}\n');
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', HOME: home, DOCKER_CONFIG: config, DOCKER_HOST: endpoint };
}

/** Materialize only reachable Git objects into a private, independent source repository, never an operational mount. */
function exportSource(root, commit, directory) {
  const target = join(directory, 'source-' + randomUUID());
  mkdirSync(target);
  const home = join(directory, 'export-home-' + randomUUID());
  mkdirSync(home);
  const template = join(home, 'empty-template');
  mkdirSync(template);
  // New private export has no inherited Git config, templates, hooks, worktree pointer or alternates.
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' };
  git(target, ['init', '-q', '--template=' + template], { env });
  git(target, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', root, commit], { env });
  git(target, ['checkout', '-q', '--detach', commit], { env });
  const tree = git(target, ['rev-parse', 'HEAD^{tree}'], { env }).trim();
  if (existsSync(join(target, '.git', 'objects', 'info', 'alternates')) || existsSync(join(target, '.git', 'commondir')) || existsSync(join(target, '.git', 'pullboard'))) {
    throw new Refused('SANDBOX_EXPORT', 'the private export is not independent; restore Git object access before sandbox verification');
  }
  return { target, tree };
}

/** A supported provider must be explicitly configured by accepted main, with two immutable trusted runtime images. */
function provider(root) {
  const value = mainPolicy(root).config.sandbox;
  if (!value || value.provider !== 'docker' || typeof value.executable !== 'string' || !value.executable.startsWith('/') ||
      typeof value.endpoint !== 'string' || !/^unix:\/\/\/[^\r\n]+$/u.test(value.endpoint) ||
      value.exportRoot !== undefined && (typeof value.exportRoot !== 'string' || !isAbsolute(value.exportRoot) || /[\r\n\0]/u.test(value.exportRoot)) ||
      !['minimum', 'current'].every(role => /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/u.test(value.images?.[role] ?? ''))) {
    throw new Refused('SANDBOX_PROVIDER_REQUIRED', 'configure sandbox.provider=docker with an absolute executable, explicit Unix endpoint and digest-pinned runtime images for minimum/current in committed main pullboard.json; no host fallback is permitted');
  }
  return value;
}

/** Run one owned container; bounded client output/timeout and unconditional owned-container cleanup are not a pass. */
async function container(runtime, environment, directory, image, source, stage, command) {
  const name = 'pullboard-outside-' + randomUUID();
  const cid = join(directory, name + '.cid');
  const args = ['run', '--pull', 'never', '--name', name, '--cidfile', cid, '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2',
    '--user', '1000:1000', '--tmpfs', '/work:rw,nosuid,nodev,size=1073741824,mode=1777',
    '--tmpfs', `${SANDBOX_CONTAINER_HOME}:rw,nosuid,nodev,size=67108864,mode=1777`, '--tmpfs', '/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
    '--env', `HOME=${SANDBOX_CONTAINER_HOME}`, '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--label', `pullboard.sandbox.stage=${stage}`,
    '--mount', `type=bind,source=${source},target=/source,readonly`, '--workdir', '/work', image,
    '/bin/sh', '-eu', '-c', 'cp -R /source/. /work/; cd /work; ' + command];
  let result;
  try {
    result = await client(runtime.executable, args, { env: environment, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  } finally {
    // Names are newly generated and never accepted from a caller or foreign receipt.
    const cleanup = await client(runtime.executable, ['rm', '--force', name], { env: environment, encoding: 'utf8', timeout: 15_000, maxBuffer: 8192 });
    if (cleanup.error || cleanup.status !== 0) throw new Refused('SANDBOX_CLEANUP_REQUIRED', `the owned container ${name} could not be removed; restore Docker and remove that exact container before another sandbox verification`);
  }
  if (result.error || result.signal || result.status === null) throw new Refused('SANDBOX_EXECUTION', 'the sandbox did not complete; restore the configured Docker runtime and inspect its owned container before retrying');
  return { exitCode: result.status, output: result.stdout + result.stderr };
}

/** Verify both pinned image roles inside actual containers, then execute the trusted full gate and frozen criterion. */
export async function verifyOutsideSandbox(root, item, policy, lease) {
  const runtime = provider(root);
  const exportRoot = runtime.exportRoot ?? join(repoInfo(root).commonDir, 'pullboard', 'sandbox-exports');
  let directory;
  try {
    mkdirSync(exportRoot, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(join(exportRoot, 'pullboard-outside-'));
  } catch { throw new Refused('SANDBOX_EXPORT', 'create a writable private sandbox.exportRoot shared with the configured Docker daemon, then verify again'); }
  try {
    const environment = clientEnvironment(directory, runtime.endpoint);
    const command = JSON.parse(item.item_frozen).check;
    if (!command || !policy.config.gate?.trim()) throw new Refused('SANDBOX_CHECK_REQUIRED', 'the trusted frozen criterion and full gate must both name commands; ask the coordinator to set them before intake');
    const candidate = exportSource(root, item.item_commit, directory);
    const baseline = exportSource(root, item.item_claim_head, directory);
    if (candidate.tree !== item.item_tree) throw new Refused('SANDBOX_EXPORT', 'the exact PR tree differs from the recorded submission; fetch its recorded objects again');
    const runs = [];
    const id = randomUUID();
    const outputDirectory = join(repoInfo(root).commonDir, 'pullboard', 'outside-check-output', String(item.item_id), id);
    mkdirSync(outputDirectory, { recursive: true });
    const logs = [];
    /** Retain bounded output and its digest, independently of the temporary export. */
    const record = (role, stage, result) => {
      const name = `${role}-${stage}.log`;
      writeFileSync(join(outputDirectory, name), result.output);
      logs.push({ role, stage, exitCode: result.exitCode, sha256: createHash('sha256').update(result.output).digest('hex') });
      return result;
    };
    for (const role of ['minimum', 'current']) {
      lease?.renew?.();
      const image = runtime.images[role];
      const inspected = await client(runtime.executable, ['image', 'inspect', image], { env: environment, encoding: 'utf8', timeout: 15_000, maxBuffer: 65536 });
      if (inspected.error || inspected.status !== 0) throw new Refused('SANDBOX_IMAGE_REQUIRED', `preload the explicitly pinned ${role} image ${image} into the configured Docker daemon; sandbox verification never pulls automatically`);
      let imageFacts;
      try { imageFacts = JSON.parse(inspected.stdout)[0]; }
      catch { throw new Refused('SANDBOX_IMAGE_REQUIRED', 'the configured image has no readable digest receipt; restore the pinned official Node image'); }
      if (!imageFacts?.RepoDigests?.includes(image)) throw new Refused('SANDBOX_IMAGE_REQUIRED', 'the local runtime image does not match the configured digest; preload that exact official Node image');
      const measured = record(role, 'environment', await container(runtime, environment, directory, image, candidate.target, 'environment', 'node -p ' + "'JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})'"));
      if (measured.exitCode !== 0) throw new Refused('SANDBOX_EXECUTION', 'the container environment did not execute; restore Docker and its pinned image, and configure sandbox.exportRoot as a private path shared with that daemon\n' + measured.output.slice(-2000));
      let actual;
      try { actual = JSON.parse(measured.output.trim()); }
      catch { throw new Refused('SANDBOX_RUNTIME', 'the container did not report its actual Node environment; restore the pinned Node runtime'); }
      if (measured.exitCode !== 0 || actual.platform !== 'linux' || !['arm64', 'x64'].includes(actual.arch) || !(role === 'minimum' ? /^22\.13\./u : /^24\./u).test(actual.node ?? '')) throw new Refused('SANDBOX_RUNTIME', `the ${role} image must execute ${role === 'minimum' ? 'Node22.13.x' : 'Node24.x'} on Linux; correct its pinned digest`);
      const before = record(role, 'baseline', await container(runtime, environment, directory, image, baseline.target, 'baseline', command));
      lease?.renew?.();
      if (before.exitCode === 0) throw new Refused('CHECK_NO_PROOF', 'the frozen check also passes before the outside change; strengthen its causal behavior assertion before intake');
      const gate = record(role, 'gate', await container(runtime, environment, directory, image, candidate.target, 'gate', policy.config.gate));
      lease?.renew?.();
      const criterion = record(role, 'criterion', await container(runtime, environment, directory, image, candidate.target, 'criterion', command));
      lease?.renew?.();
      if (gate.exitCode !== 0 || criterion.exitCode !== 0) throw new Refused('CHECK_RED', `outside ${role} sandbox check is red; return the failing behavior to its author\n${(gate.output + criterion.output).slice(-12000)}`);
      runs.push({ role, image, imageId: imageFacts.Id, environment: actual, exitCode: 0, network: 'none', credentials: false, home: 'empty', baselineExit: before.exitCode });
    }
    writeFileSync(join(outputDirectory, 'manifest.json'), JSON.stringify({ commit: item.item_commit, tree: item.item_tree, digest: item.item_frozen_digest, runs, logs }, null, 2) + '\n');
    const receipt = { id, item: item.item_id, logs, version: 1, provider: 'docker', commit: item.item_commit, tree: item.item_tree, digest: item.item_frozen_digest, at: new Date().toISOString(), runs };
    writeFileSync(join(outputDirectory, 'receipt.json'), JSON.stringify(receipt) + '\n');
    return receipt;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
