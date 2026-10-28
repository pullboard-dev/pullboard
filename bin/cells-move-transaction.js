/** Move one leaf with exact reversible byte custody; never evaluate the moved module [C7]. */
import { Refused } from '../src/refused.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
} from 'node:path';

/** Refuse unknown input without changing the checkout. */
function requireThat(condition, message) { if (!condition) throw new Refused('CELLS_MOVE', message, 'Restore the clean recorded checkout or resolve the named unsupported input before retrying.'); }
/** Keep the custody envelope content addressed. */
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Permit complete relative POSIX file identities, never escape or path aliases. */
function filePath(path) {
  requireThat(typeof path === 'string' && path && !/[\\:\x00-\x1f\x7f]/u.test(path)
    && !posix.isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), `invalid file path ${path}`);
  return path;
}
/** Read regular bytes only; absence is explicit custody, never a swallowed I/O failure. */
function image(root, file) {
  const path = join(root, file);
  if (!existsSync(path)) {
    try { lstatSync(path); throw new Error('dangling symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return null;
  }
  const stat = lstatSync(path);
  requireThat(stat.isFile() && !stat.isSymbolicLink(), `${file} must be regular`);
  return { bytes: readFileSync(path).toString('base64'), mode: stat.mode & 0o777 };
}
/** Compare exact content and executable bits; do not reinterpret text as an image. */
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
/** All ancestors belong inside this checkout, without traversing directory symlinks. */
function parents(root, file) {
  let path = root;
  for (const part of file.split('/').slice(0, -1)) {
    path = join(path, part);
    if (existsSync(path)) requireThat(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `unsafe parent ${path}`);
    else {
      try { lstatSync(path); throw new Error(`dangling parent ${path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
/** Construct the narrowly supported transaction using controller-loaded accepted tools, never candidate evaluation. */
export function createMoveTool({ lex, importsIn, commonJsIn, engineFolderViolations, readPathMap, cleanGitEnvironment }) {
  /** Run immutable Git selectors with ambient selectors removed, or ordinary scoped mutations. */
  function git(root, args, encoding = 'utf8') {
    const result = spawnSync('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
      cwd: root, env: cleanGitEnvironment(), encoding, maxBuffer: 64 * 1024 * 1024,
    });
    requireThat(result.status === 0, `git ${args[0]} failed: ${String(result.stderr ?? result.error ?? '')}`);
    return result.stdout;
  }
  /** Confirm source bytes and imported targets are regular committed objects. */
  function tracked(root, commit, file) {
    const row = git(root, ['ls-tree', '-z', commit, '--', file]);
    requireThat(/^100(?:644|755) blob [a-f0-9]+\t/u.test(row) && row.endsWith(`\t${file}\0`), `${file} is not a regular committed file`);
  }
  /** Relocate only plain static module literals; V8 verifies the complete recognized import set. */
  function relocate(root, commit, from, to, source) {
    const { code, strings } = lex(source);
    for (const declaration of code.matchAll(/\bexport\s+([^;\n]*)/gu)) {
      requireThat(/^(?:const|let|var|function|class|async\s+function)\b/u.test(declaration[1]),
        'only named declaration exports are supported; default and re-export syntax needs owner review');
    }
    requireThat(!commonJsIn([source])[0], 'CommonJS or unknown module syntax is unsupported');
    requireThat(!/\bimport\s*(?:\(|\.)|\b(?:__dirname|__filename)\b|\bexport\s+default\b/u.test(code),
      'dynamic loads, module-relative assets and default exports require an explicit owner design');
    const expected = new Set(importsIn([source])[0]);
    const seen = new Set();
    const edits = [];
    for (const literal of strings) {
      const prefix = code.slice(0, literal.start);
      const moduleSite = /\b(?:from|import)\s*$/u.test(prefix);
      const raw = source.slice(literal.start, literal.end);
      if (!moduleSite) {
        requireThat(!/^\.{1,2}\//u.test(literal.text), `non-import relative literal needs review: ${literal.text}`);
        continue;
      }
      requireThat(raw[0] === '"' || raw[0] === "'", 'template module specifiers are unsupported');
      requireThat(!literal.text.includes('\\') && !/[?#]/u.test(literal.text), 'escaped/URL module specifiers are unsupported');
      requireThat(expected.has(literal.text), `lexer/V8 disagree at module literal ${literal.text}`);
      seen.add(literal.text);
      if (!/^\.{1,2}\//u.test(literal.text)) continue;
      const target = posix.normalize(posix.join(posix.dirname(from), literal.text));
      filePath(target); tracked(root, commit, target); parents(root, target);
      let next = posix.relative(posix.dirname(to), target);
      if (!next.startsWith('.')) next = './' + next;
      edits.push({ start: literal.start, end: literal.end, text: JSON.stringify(next) });
    }
    requireThat(expected.size === seen.size && [...expected].every(value => seen.has(value)), 'some imports have no supported literal site');
    let next = source;
    for (const edit of edits.reverse()) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
    importsIn([next]); // Compile, never link/evaluate.
    return next;
  }
  /** Capture a closed four-file preimage before any mutation; old importers keep their shim. */
  function derive({ root, from, to, frontDoor, purpose }, recordedHead = null) {
    root = realpathSync(root);
    [from, to, frontDoor].forEach(filePath);
    requireThat(/^packages\/[a-z][a-z0-9-]*\/index\.js$/u.test(frontDoor), 'front door must be one package index');
    requireThat(to.startsWith(posix.dirname(frontDoor) + '/src/') && /\.(?:m?js)$/u.test(to), 'body must live under the package src tree');
    requireThat(new Set([from, to, frontDoor, 'path-map.json']).size === 4, 'transaction paths overlap');
    requireThat(typeof purpose === 'string' && purpose.trim() && !/[\r\n]|\*\//u.test(purpose), 'give one plain front-door purpose sentence');
    if (recordedHead === null) requireThat(git(root, ['status', '--porcelain=v1', '-z']) === '', 'start from a clean checkout');
    const head = recordedHead ?? git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    requireThat(/^[a-f0-9]{40}$/u.test(head), 'recorded HEAD must be an immutable commit');
    const policy = JSON.parse(git(root, ['show', `${head}:package.json`]));
    requireThat(policy.type === 'module', 'one root ESM package is required');
    requireThat(/^src\/[^/]+\.(?:m?js)$/u.test(from), 'this bounded first-leaf tool accepts one top-level legacy source file');
    [from, to, frontDoor, 'path-map.json'].forEach(file => {
      parents(root, file);
      let scope = posix.dirname(file);
      while (scope !== '.') {
        requireThat(!existsSync(join(root, scope, 'package.json')), `nested package scope ${scope} is unsupported`);
        scope = posix.dirname(scope);
      }
    });
    tracked(root, head, from);
    const before = Object.fromEntries([from, to, frontDoor, 'path-map.json'].map(file => {
      if (recordedHead === null) return [file, image(root, file)];
      const row = git(root, ['ls-tree', '-z', head, '--', file]);
      if (!row) return [file, null];
      tracked(root, head, file);
      return [file, { bytes: git(root, ['show', `${head}:${file}`], null).toString('base64'), mode: row.startsWith('100755 ') ? 0o755 : 0o644 }];
    }));
    requireThat(before[from] && !before[to] && !before[frontDoor], 'source must exist and destinations must be absent');
    const sourceBytes = Buffer.from(before[from].bytes, 'base64');
    const source = sourceBytes.toString('utf8');
    requireThat(Buffer.from(source).equals(sourceBytes), 'source is not exact UTF-8');
    requireThat(engineFolderViolations([{ file: to, source }]).length === 0, 'canonical engines must remain in src/');
    const acceptedMap = readPathMap(root, { commit: head });
    requireThat(!acceptedMap.has(from) && !acceptedMap.has(to)
      && ![...acceptedMap.values()].some(path => path === from || path === to), 'existing rename chains need explicit owner handling');
    const mapping = before['path-map.json'] ? JSON.parse(Buffer.from(before['path-map.json'].bytes, 'base64')) : {};
    requireThat(!Object.hasOwn(mapping, from), 'do not overwrite an existing move');
    mapping[from] = to; // The history identity targets the body, never the index or shim.
    const body = relocate(root, head, from, to, source);
    let shimTarget = posix.relative(posix.dirname(from), frontDoor);
    if (!shimTarget.startsWith('.')) shimTarget = './' + shimTarget;
    let bodyTarget = posix.relative(posix.dirname(frontDoor), to);
    if (!bodyTarget.startsWith('.')) bodyTarget = './' + bodyTarget;
    const textImage = (text, mode = 0o644) => ({ bytes: Buffer.from(text).toString('base64'), mode });
    const after = {
      [from]: textImage(`export * from ${JSON.stringify(shimTarget)};\n`, before[from].mode),
      [to]: textImage(body, before[from].mode),
      [frontDoor]: textImage(`/** ${purpose.trim()} */\nexport * from ${JSON.stringify(bodyTarget)};\n`),
      'path-map.json': textImage(JSON.stringify(mapping, null, 2) + '\n', before['path-map.json']?.mode),
    };
    const directories = [...new Set([to, frontDoor].flatMap(file => {
      const result = []; let directory = posix.dirname(file);
      while (directory !== '.' && !existsSync(join(root, directory))) { result.unshift(directory); directory = posix.dirname(directory); }
      return result;
    }))].sort((a, b) => a.split('/').length - b.split('/').length);
    const value = { version: 1, directories, root, head, from, to, frontDoor, purpose, before, after };
    return Object.freeze({ ...value, digest: digest(value) });
  }
  /** Plan only from a clean current checkout; inverse validation derives from immutable Git instead. */
  function plan(input) { return derive(input); }
  /** Validate a serialized envelope's digest; this is custody, not executable or board authority. */
  function validate(value) {
    const { digest: claimed, ...payload } = value;
    requireThat(payload.version === 1 && digest(payload) === claimed, 'transaction custody digest changed');
    requireThat(realpathSync(payload.root) === payload.root
      && git(payload.root, ['rev-parse', '--show-toplevel']).trim() === payload.root, 'custody root must be the actual Git root');
    [payload.from, payload.to, payload.frontDoor].forEach(filePath);
    requireThat(/^src\/[^/]+\.(?:m?js)$/u.test(payload.from)
      && /^packages\/[a-z][a-z0-9-]*\/index\.js$/u.test(payload.frontDoor)
      && payload.to.startsWith(posix.dirname(payload.frontDoor) + '/src/'), 'custody paths leave the supported one-leaf shape');
    requireThat(Array.isArray(payload.directories) && payload.directories.every(directory => {
      filePath(directory);
      return [payload.to, payload.frontDoor].some(file => file.startsWith(directory + '/'));
    }), 'invalid directory custody');
    const expected = [payload.from, payload.to, payload.frontDoor, 'path-map.json'].sort();
    requireThat(new Set(expected).size === 4 && JSON.stringify(Object.keys(payload.before).sort()) === JSON.stringify(expected)
      && JSON.stringify(Object.keys(payload.after).sort()) === JSON.stringify(expected), 'custody scope changed');
    requireThat(payload.before[payload.from] && !payload.before[payload.to] && !payload.before[payload.frontDoor], 'invalid source preimage');
    for (const file of expected) {
      for (const state of [payload.before[file], payload.after[file]]) {
        if (state === null) continue;
        requireThat(state && [0o644, 0o755].includes(state.mode) && typeof state.bytes === 'string'
          && Buffer.from(state.bytes, 'base64').toString('base64') === state.bytes, 'invalid byte/mode image');
      }
      requireThat(payload.after[file] !== null, 'missing postimage');
      const row = git(payload.root, ['ls-tree', '-z', payload.head, '--', file]);
      if (!payload.before[file]) requireThat(!row, `preimage incorrectly claims ${file} was absent`);
      else {
        tracked(payload.root, payload.head, file);
        requireThat(git(payload.root, ['show', `${payload.head}:${file}`], null).toString('base64') === payload.before[file].bytes,
          `preimage does not bind immutable Git bytes for ${file}`);
        requireThat(row.startsWith(payload.before[file].mode === 0o755 ? '100755 ' : '100644 '), `preimage mode differs for ${file}`);
      }
    }
    const canonical = derive(payload, payload.head);
    requireThat(same(canonical.before, payload.before) && same(canonical.after, payload.after),
      'custody postimages differ from immutable canonical derivation');
    return payload;
  }
  /** Make only recorded empty ancestors, refusing every symlink. */
  function makeParents(root, file, created) {
    parents(root, file);
    let path = root;
    for (const part of file.split('/').slice(0, -1)) {
      path = join(path, part);
      if (!existsSync(path)) { mkdirSync(path); created.push(relative(root, path)); }
    }
  }
  /** Write a known owned image; no recursive deletion and no outside paths. */
  function put(root, file, value, created) {
    if (value === null) { if (existsSync(join(root, file))) unlinkSync(join(root, file)); return; }
    makeParents(root, file, created);
    writeFileSync(join(root, file), Buffer.from(value.bytes, 'base64'));
    chmodSync(join(root, file), value.mode);
  }
  /** Restore only known transaction images; preserve unexpected concurrent edits for manual recovery. */
  function restore(value, created = []) {
    validate(value);
    for (const file of Object.keys(value.before)) {
      parents(value.root, file);
      const actual = image(value.root, file);
      const movedOriginal = file === value.to ? value.before[value.from] : null;
      requireThat((actual === null && (value.before[file] === null || file === value.from)) || same(actual, value.before[file]) || same(actual, value.after[file]) || (movedOriginal !== null && same(actual, movedOriginal)),
        `unexpected concurrent bytes at ${file}; retain custody and resolve manually`);
    }
    for (const [file, preimage] of Object.entries(value.before)) put(value.root, file, preimage, created);
    const absent = Object.keys(value.before).filter(file => value.before[file] === null);
    if (absent.length) git(value.root, ['update-index', '--force-remove', '--', ...absent]);
    git(value.root, ['add', '--', ...Object.keys(value.before).filter(file => value.before[file] !== null)]);
    for (const directory of [...new Set(created)].reverse()) {
      try { rmdirSync(join(value.root, directory)); }
      catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
    }
  }
  /** Apply one prevalidated git-mv transaction, preserving custody before the first mutation. */
  function apply(value, custodyDirectory) {
    validate(value);
    const rebuilt = plan(value);
    requireThat(same(rebuilt, value), 'transaction differs from canonical derived plan');
    const custodyRelative = relative(value.root, resolve(custodyDirectory));
    requireThat(isAbsolute(custodyDirectory) && (custodyRelative === '..' || custodyRelative.startsWith('../')),
      'custody must be outside the checkout');
    requireThat(git(value.root, ['rev-parse', 'HEAD']).trim() === value.head && git(value.root, ['status', '--porcelain=v1', '-z']) === '',
      'HEAD or workspace changed since planning');
    for (const [file, expected] of Object.entries(value.before)) {
      parents(value.root, file);
      requireThat(same(image(value.root, file), expected), `${file} changed since planning`);
    }
    requireThat(existsSync(custodyDirectory) && realpathSync(custodyDirectory) === resolve(custodyDirectory),
      'custody must be an existing canonical directory without symlink aliases');
    const record = join(custodyDirectory, value.digest + '.json');
    writeFileSync(record, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const created = [];
    try {
      makeParents(value.root, value.to, created);
      git(value.root, ['mv', '--', value.from, value.to]);
      for (const [file, postimage] of Object.entries(value.after)) put(value.root, file, postimage, created);
      git(value.root, ['add', '--', ...Object.keys(value.after)]);
      return { record, digest: value.digest, created };
    } catch (error) {
      try { restore(value, created); }
      catch (recovery) { throw new AggregateError([error, recovery], `retain exact custody ${record}; partial transaction needs manual recovery`); }
      throw error;
    }
  }
  /** Reverse only this exact postimage; no reset, candidate execution, or collateral overwrite. */
  function undo(record) {
    const value = JSON.parse(readFileSync(record, 'utf8'));
    validate(value);
    requireThat(git(value.root, ['rev-parse', 'HEAD']).trim() === value.head, 'this bounded draft reverses before commit; use an ordinary reviewed revert afterward');
    const changed = [...git(value.root, ['diff', '--name-only', '-z']).split('\0'),
      ...git(value.root, ['diff', '--cached', '--name-only', '-z']).split('\0'),
      ...git(value.root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean);
    requireThat(changed.every(file => Object.hasOwn(value.after, file)), 'unrelated workspace edits appeared; preserve them and stop');
    for (const [file, expected] of Object.entries(value.after)) requireThat(same(image(value.root, file), expected), `${file} changed after apply`);
    restore(value, value.directories);
    requireThat(git(value.root, ['status', '--porcelain=v1', '-z']) === '', 'inverse did not restore the exact clean preimage');
  }
  return { plan, apply, undo };
}
