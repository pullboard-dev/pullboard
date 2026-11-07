/** Stateful in-memory Git reads for logic tests; unsupported commands fail instead of using Git [C7]. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** Explicitly reject unmodelled behavior; the fake never falls back to a process or filesystem. */
function unsupported(message) {
  const error = new Error(`In-memory Git does not support ${message}; extend the shared contract first`);
  error.code = 'GIT_ADAPTER_UNSUPPORTED';
  throw error;
}

/** Compute an actual SHA-1 blob identity from bytes, rather than treating content as an arbitrary label. */
function blobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Git folds section and variable case but preserves subsection case, such as remote.Upstream.url. */
function configKey(key) {
  const parts = key.split('.');
  parts[0] = parts[0].toLowerCase();
  parts[parts.length - 1] = parts.at(-1).toLowerCase();
  return parts.join('.');
}

/** Read command-scope config without mutating local settings; this includes the ordinary test runner. */
function environmentConfig(env = {}) {
  const values = new Map();
  if (env.GIT_CONFIG_COUNT === undefined) return values;
  if (!/^(?:0|[1-9]\d*)$/u.test(env.GIT_CONFIG_COUNT)) unsupported('invalid GIT_CONFIG_COUNT');
  const count = Number(env.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(count) || count > Object.keys(env).length) unsupported('incomplete command config');
  for (let index = 0; index < count; index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`];
    const value = env[`GIT_CONFIG_VALUE_${index}`];
    if (typeof key !== 'string' || typeof value !== 'string') unsupported('incomplete command config');
    if (!/^(?:user|gc|maintenance|pullboard|remote)\./iu.test(key)) unsupported(`command config ${key}`);
    values.set(configKey(key), value);
  }
  return values;
}

/** Copy a seeded commit and its files so callers cannot mutate repository state behind the adapter. */
function copyCommit(commit) {
  if (!/^[a-f\d]{40}$/u.test(commit.oid) || !/^[a-f\d]{40}$/u.test(commit.tree)) {
    throw new TypeError('In-memory Git commits need full SHA-1 commit and tree identities');
  }
  return { ...commit, parents: [...(commit.parents ?? [])], files: new Map(Object.entries(commit.files ?? {})
    .map(([path, bytes]) => [path, Buffer.from(bytes)])) };
}

/** Resolve a seeded ref, full object identity, parent suffix or commit/tree peel without real Git. */
function revision(repo, value) {
  const peeled = /\^\{(commit|tree)\}$/u.exec(value);
  const name = peeled ? value.slice(0, -peeled[0].length) : value;
  const parent = /\^(?:1)?$/u.test(name);
  const plain = parent ? name.replace(/\^(?:1)?$/u, '') : name;
  let oid = plain === 'HEAD' ? (repo.branch ? repo.refs.get(repo.branch) : repo.head)
    : repo.refs.get(plain) ?? repo.refs.get(`refs/heads/${plain}`) ?? (repo.commits.has(plain) ? plain : null);
  if (parent) oid = repo.commits.get(oid)?.parents[0] ?? null;
  const commit = repo.commits.get(oid);
  return commit ? { oid: peeled?.[1] === 'tree' ? commit.tree : oid, commit, type: peeled?.[1] === 'tree' ? 'tree' : 'commit' } : null;
}

/** Resolve committed files and blob objects from the same state as revision lookups. */
function object(repo, value) {
  const colon = value.indexOf(':');
  if (colon !== -1) {
    const commit = revision(repo, value.slice(0, colon))?.commit;
    const bytes = commit?.files.get(value.slice(colon + 1));
    return bytes ? { oid: blobId(bytes), type: 'blob', bytes } : null;
  }
  const ref = revision(repo, value);
  if (ref) return ref;
  for (const commit of repo.commits.values()) {
    if (commit.tree === value) return { oid: value, type: 'tree' };
    for (const bytes of commit.files.values()) if (blobId(bytes) === value) return { oid: value, type: 'blob', bytes };
  }
  return null;
}

/** Compare Git path names by bytes, matching Git's ordinary tree ordering for flat fixture paths. */
function pathOrder(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** Walk a seeded commit graph, including the tip itself. */
function ancestors(repo, tip) {
  const seen = new Set();
  const pending = [tip];
  while (pending.length) {
    const next = pending.pop();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(repo.commits.get(next)?.parents ?? []));
  }
  return seen;
}

/** Parse only the explicitly contracted global flags; unknown flags cannot silently change semantics. */
function commandArgs(args, options) {
  const words = [...args];
  let cwd = options.cwd;
  while (words[0]?.startsWith('-')) {
    if (['--no-replace-objects', '--no-optional-locks'].includes(words[0])) words.shift();
    else if (words[0] === '-C') { words.shift(); cwd = resolve(cwd ?? '.', words.shift()); }
    else if (words[0] === '-c' && ['core.quotepath=false', 'gc.auto=0'].includes(words[1])) words.splice(0, 2); // gc.auto=0 is in the shared GIT_FLAGS; it has no effect on an in-memory repo
    else unsupported(`global option ${words[0]}`);
  }
  return { words, cwd: resolve(cwd ?? '.') };
}

/** Return a Git-like command outcome with bytes; Node transport shaping happens in one place below. */
function outcome(status = 0, stdout = '', stderr = '') {
  return { status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
}

/** Apply the supported read and config/ref mutation commands to the in-memory repository. */
function execute(repo, args, commandConfig) {
  const [command, ...rest] = args;
  if (command === 'rev-parse') {
    if (rest.length === 1 && rest[0] === '--show-toplevel') return outcome(0, `${repo.root}\n`);
    if (rest.length === 1 && rest[0] === '--is-shallow-repository') return outcome(0, 'false\n');
    const name = rest.at(-1);
    if (!name || name.startsWith('-') || rest.slice(0, -1).some(word => !['--verify', '--quiet'].includes(word))) unsupported(`rev-parse ${rest.join(' ')}`);
    const found = revision(repo, name);
    return found ? outcome(0, `${found.oid}\n`) : outcome(rest.includes('--quiet') ? 1 : 128, '', 'fatal: revision not found\n');
  }
  if (command === 'symbolic-ref') {
    if (rest.at(-1) !== 'HEAD' || rest.slice(0, -1).some(word => !['--quiet', '-q', '--short'].includes(word))) unsupported(`symbolic-ref ${rest.join(' ')}`);
    if (!repo.branch) return outcome(1);
    return outcome(0, `${rest.includes('--short') ? repo.branch.replace(/^refs\/heads\//u, '') : repo.branch}\n`);
  }
  if (command === 'config') {
    const words = rest[0] === '--local' ? rest.slice(1) : rest;
    const [verb, key, value] = words;
    if (verb === '--get' && words.length === 2) {
      const saved = (rest[0] === '--local' ? undefined : commandConfig.get(configKey(key))) ?? repo.config.get(configKey(key));
      return saved === undefined ? outcome(1) : outcome(0, `${saved}\n`);
    }
    if (verb === '--replace-all' && words.length === 3) { repo.config.set(configKey(key), value); return outcome(); }
    unsupported(`config ${rest.join(' ')}`);
  }
  if (command === 'show') {
    if (rest.length !== 1 || !rest[0].includes(':')) unsupported(`show ${rest.join(' ')}`);
    const found = object(repo, rest[0]);
    return found?.type === 'blob' ? outcome(0, found.bytes) : outcome(128, '', 'fatal: path not found\n');
  }
  if (command === 'cat-file') {
    const [verb, name] = rest;
    if (rest.length !== 2 || !['-e', '-t', '-s', 'blob'].includes(verb)) unsupported(`cat-file ${rest.join(' ')}`);
    const found = object(repo, name);
    if (!found) return outcome(128, '', 'fatal: object not found\n');
    if (verb === '-e') return outcome();
    if (verb === '-t') return outcome(0, `${found.type}\n`);
    if (!found.bytes) unsupported(`cat-file ${verb} on ${found.type}`);
    return verb === '-s' ? outcome(0, `${found.bytes.length}\n`) : outcome(0, found.bytes);
  }
  if (command === 'ls-tree') {
    if (rest.length !== 4 || rest[0] !== '-r' || rest[1] !== '-z' || rest[2] !== '--name-only') unsupported(`ls-tree ${rest.join(' ')}`);
    const found = revision(repo, rest[3]);
    return found ? outcome(0, [...found.commit.files.keys()].sort(pathOrder).map(path => `${path}\0`).join('')) : outcome(128, '', 'fatal: revision not found\n');
  }
  if (command === 'merge-base') {
    if (rest.length !== 3 || rest[0] !== '--is-ancestor') unsupported(`merge-base ${rest.join(' ')}`);
    const base = revision(repo, rest[1]);
    const tip = revision(repo, rest[2]);
    if (!base || !tip) return outcome(128, '', 'fatal: revision not found\n');
    return outcome(ancestors(repo, tip.commit.oid).has(base.commit.oid) ? 0 : 1);
  }
  if (command === 'update-ref') {
    if (rest.length !== 2 || !rest[0].startsWith('refs/heads/')) unsupported(`update-ref ${rest.join(' ')}`);
    const found = revision(repo, rest[1]);
    if (!found || found.type !== 'commit') return outcome(128, '', 'fatal: revision not found\n');
    repo.refs.set(rest[0], found.oid);
    return outcome();
  }
  if (command === 'diff') {
    if (rest.length !== 5 || rest[0] !== '--no-renames' || rest[1] !== '--name-only' || rest[2] !== '-z') unsupported(`diff ${rest.join(' ')}`);
    const base = revision(repo, rest[3]);
    const tip = revision(repo, rest[4]);
    if (!base || !tip) return outcome(128, '', 'fatal: revision not found\n');
    const paths = new Set([...base.commit.files.keys(), ...tip.commit.files.keys()]);
    return outcome(0, [...paths].filter(path => {
      const before = base.commit.files.get(path);
      const after = tip.commit.files.get(path);
      return !before || !after || !before.equals(after);
    }).sort(pathOrder).map(path => `${path}\0`).join(''));
  }
  unsupported(`command ${command}`);
}

/** Shape captured bytes like Node for the options this fake contracts; reject unsupported transport options. */
function capture(result, options) {
  for (const key of Object.keys(options)) {
    if (!['cwd', 'env', 'encoding', 'stdio', 'input', 'maxBuffer'].includes(key)) unsupported(`process option ${key}`);
  }
  if (options.input && Buffer.byteLength(options.input)) unsupported('nonempty process stdin');
  if (options.encoding && !['utf8', 'utf-8', 'buffer'].includes(options.encoding)) unsupported(`encoding ${options.encoding}`);
  if (options.maxBuffer !== undefined && (result.stdout.length > options.maxBuffer || result.stderr.length > options.maxBuffer)) unsupported('maxBuffer overflow');
  const stdio = options.stdio ?? 'pipe';
  if (stdio !== 'pipe' && stdio !== 'ignore' && (!Array.isArray(stdio) || stdio.some(value => !['pipe', 'ignore'].includes(value)))) unsupported('inherited or file-descriptor stdio');
  /** Decode only captured pipes, preserving ignored descriptors as null. */
  const output = (bytes, descriptor) => stdio === 'ignore' || (Array.isArray(stdio) && stdio[descriptor] === 'ignore')
    ? null : options.encoding && options.encoding !== 'buffer' ? bytes.toString(options.encoding) : bytes;
  const stdout = output(result.stdout, 1);
  const stderr = output(result.stderr, 2);
  return { status: result.status, signal: null, stdout, stderr, output: [null, stdout, stderr] };
}

/** Create isolated repository state; seeds use immutable real commit identities and explicit file bytes.
 * Supports the exact rev-parse, symbolic-ref, config, show, cat-file, ls-tree, ancestry, update-ref
 * and committed name-only diff forms exercised by the shared contract. It models no index, merge,
 * worktree discovery, streaming protocol, environment-selected repository, or arbitrary Git argv.
 */
export function createMemoryGitAdapter(seeds) {
  const repositories = new Map(seeds.map(seed => {
    const root = resolve(seed.root);
    const branch = seed.branch === null ? null : `refs/heads/${seed.branch ?? 'main'}`;
    const commits = new Map((seed.commits ?? []).map(commit => [commit.oid, copyCommit(commit)]));
    const refs = new Map(Object.entries(seed.refs ?? {}));
    if (branch && seed.head) refs.set(branch, seed.head);
    return [root, { root, branch, head: seed.head, commits, refs,
      config: new Map(Object.entries(seed.config ?? {}).map(([key, value]) => [configKey(key), value])) }];
  }));
  const adapter = {
    /** Run against seeded state only; absent repositories produce an ordinary Git failure. */
    spawnSync(args, options = {}) {
      capture(outcome(), options);
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SHALLOW_FILE']) {
        if (options.env?.[key]) unsupported(`environment selector ${key}`);
      }
      const { words, cwd } = commandArgs(args, options);
      const repo = repositories.get(cwd);
      return capture(repo ? execute(repo, words, environmentConfig(options.env)) : outcome(128, '', 'fatal: not a git repository\n'), options);
    },
    /** Preserve success bytes and failure status/output used by the shared synchronous helpers. */
    execFileSync(args, options = {}) {
      const result = adapter.spawnSync(args, options);
      if (result.status === 0) return result.stdout;
      const error = new Error(`Command failed: git ${args.join(' ')}`);
      Object.assign(error, result);
      throw error;
    },
    /** Streaming is deliberately outside this first slice and must never start a real process. */
    spawn() { unsupported('streaming processes'); },
  };
  return adapter;
}
