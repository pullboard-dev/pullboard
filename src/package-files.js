/** Derive private source copies from the package's explicit shipped-file boundary [C7,P3]. */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Reject ambiguous or escaping package paths rather than widening a source copy; a leading ! excludes earlier matches, as npm does. */
function packagePattern(value) {
  const exclude = typeof value === 'string' && value.startsWith('!');
  const body = exclude ? value.slice(1) : value;
  if (typeof body !== 'string' || !body || body.startsWith('!') || isAbsolute(body)
    || /[\\\u0000-\u001f\u007f{}[\]()]/u.test(body)) throw new Error(`unsupported package files entry: ${JSON.stringify(value)}`);
  const path = body.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (!path || path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error(`unsafe package files entry: ${JSON.stringify(value)}`);
  let pattern = '';
  for (let i = 0; i < path.length; i++) {
    const char = path[i];
    if (char === '*' && path[i + 1] === '*') {
      i++;
      if (path[i + 1] === '/') { pattern += '(?:.*/)?'; i++; }
      else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^$|]/gu, '\\$&');
  }
  const firstWildcard = path.search(/[?*]/u);
  const prefix = firstWildcard < 0 ? path : path.slice(0, Math.max(0, path.lastIndexOf('/', firstWildcard)));
  return { expression: new RegExp(`^${pattern}(?:/.*)?$`, 'u'), prefix: firstWildcard === 0 ? '' : prefix, exclude };
}

/** The last entry that matches a path decides it, so a later ! entry removes earlier matches and nothing else. */
function selectedBy(patterns, path) {
  let selected = false;
  for (const { expression, exclude } of patterns) if (expression.test(path)) selected = !exclude;
  return selected;
}

/** Return stable regular-file paths; package.json is the mandatory manifest needed to interpret shipped code. */
export function packageFiles(root) {
  const source = resolve(root);
  const manifestFile = join(source, 'package.json');
  if (!lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink()) throw new Error('package.json must be a regular file');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('package files must be an explicit nonempty list');
  const patterns = manifest.files.map(packagePattern);
  if (!patterns.some(({ exclude }) => !exclude)) throw new Error('package files needs at least one inclusion entry before any ! exclusion');
  const files = ['package.json'];
  /** Enumerate declared bytes only, never following a symlink or copying repository/account state. */
  function visit(directory, prefix = '') {
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (path === 'package.json') continue;
      const stat = lstatSync(join(directory, name));
      if (stat.isDirectory()) {
        if (patterns.some(({ prefix }) => !prefix || path === prefix || path.startsWith(prefix + '/') || prefix.startsWith(path + '/'))) {
          visit(join(directory, name), path);
        }
      } else if (selectedBy(patterns, path)) {
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`package source is not a regular file: ${path}`);
        files.push(path);
        if (files.length > 100_000) throw new Error('package file list exceeds its copy bound');
      }
    }
  }
  visit(source);
  return files.sort();
}

/** Copy the exact declared source list to an independent private directory; no tests, Git or account files leak in. */
export function copyPackageFiles(root, destination) {
  const source = resolve(root);
  const target = resolve(destination);
  const nested = relative(source, target);
  if (!nested || !nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested)) {
    throw new Error('package copy destination must be outside its source');
  }
  const files = packageFiles(source);
  for (const file of files) {
    const output = join(target, file);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(source, file), output);
  }
  return files;
}
