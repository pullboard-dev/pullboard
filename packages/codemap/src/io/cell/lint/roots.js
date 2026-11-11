/** Transitional roots follow declared executables and audited browser entry declarations, never directory-name guesses [CD62,C7]. */
import { posix } from 'node:path';
import { lex } from '../../../../../kernel/index.js';
import { testFile } from './inventory.js';

/** Resolve a declared repository path without following external URLs or allowing paths to escape the inventory. */
function declaredPath(file, path) {
  if (typeof path !== 'string' || !path || /[?#\\]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path)) return null;
  const target = posix.normalize(path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path));
  return target.startsWith('../') || target === '..' ? null : target;
}

/** Read literal external scripts from actual HTML markup; inline scripts do not invent file roots. */
function htmlScripts(source) {
  const paths = [], tags = /<!--[\s\S]*?-->|<\/?[a-z][a-z\d:-]*\b(?:"[^"]*"|'[^']*'|[^'">])*>/giu;
  let inertDepth = 0;
  for (let tag = tags.exec(source); tag; tag = tags.exec(source)) {
    if (/^<\/(?:template|svg|math)\b/iu.test(tag[0])) { inertDepth = Math.max(0, inertDepth - 1); continue; }
    if (/^<(?:template|svg|math)\b/iu.test(tag[0])) { if (!/\/\s*>$/u.test(tag[0])) inertDepth++; continue; }
    const raw = /^<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript|plaintext)\b/iu.exec(tag[0]);
    if (!raw) continue;
    if (raw[1].toLowerCase() === 'script' && !inertDepth) {
      const attributes = new Map(), pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
      for (const match of tag[0].replace(/^<script\b/iu, '').slice(0, -1).matchAll(pattern)) {
        if (!attributes.has(match[1].toLowerCase())) attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
      }
      const type = (attributes.get('type') ?? '').trim().toLowerCase();
      if (attributes.has('src') && ['', 'module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) paths.push(attributes.get('src'));
    }
    const closing = new RegExp('</' + raw[1] + '\\s*>', 'giu');
    closing.lastIndex = tags.lastIndex;
    const end = closing.exec(source);
    // Raw text and inert templates never turn example markup into executable application roots.
    tags.lastIndex = end ? end.index + end[0].length : source.length;
  }
  return paths;
}

/** Extract only actual readFileSync/new URL asset rows in the accepted relay browser-serving declaration. */
function servedAssets(source) {
  const info = lex(source), result = new Map();
  const pattern = /\[\s*(['"])[^'"]*\1\s*,\s*\[\s*(['"])[^'"]*\2\s*,\s*readFileSync\s*\(\s*new\s+URL\s*\(\s*(['"])[^'"]*\3\s*,\s*import\.meta\.url\s*\)/gu;
  for (const match of info.code.matchAll(pattern)) {
    const literals = info.strings.filter(row => row.start >= match.index && row.end <= match.index + match[0].length);
    if (literals.length === 3 && literals[1].text === 'text/javascript') result.set(literals[0].text, literals[2].text);
  }
  return { info, result };
}

/** Choose exact application roots and expose unresolved entry declarations instead of claiming an opaque entry reached. */
export function cellRoots(files) {
  const roots = new Set(), unknown = [], apps = [...files.keys()].some(file => file.startsWith('apps/'));
  /** A literal entry must actually exist as a non-test inventory file. */
  function add(file, path) {
    const target = declaredPath(file, path);
    if (!target || !files.has(target) || testFile(target)) unknown.push({ file, specifier: path, reason: 'declared application entry is missing, external or a test; reach is unproven' });
    else roots.add(target);
  }
  if (apps) {
    for (const file of files.keys()) if (/^apps\/[^/]+\/index\.js$/u.test(file)) roots.add(file);
    return { mode: 'apps', roots: [...roots].sort(), unknown };
  }
  const config = files.has('package.json') ? JSON.parse(files.get('package.json').toString('utf8')) : {};
  const bins = typeof config.bin === 'string' ? [config.bin] : Object.values(config.bin ?? {});
  for (const path of bins) add('package.json', path);
  if (typeof config.browser === 'string') add('package.json', config.browser);
  else if (config.browser) unknown.push({ file: 'package.json', reason: 'browser remapping is not a proven standalone application entry' });
  // Only an explicitly declared HTML entry can seed its scripts; fixture/sample HTML alone is never an app.
  for (const file of [...roots]) if (/\.html?$/iu.test(file)) {
    const html = files.get(file).toString('utf8').replace(/<!--[\s\S]*?-->/gu, '');
    for (const path of htmlScripts(html)) add(file, path);
  }
  // These exact accepted serving modules declare browser entry URLs. Other browser-named files are never roots.
  const page = 'apps/relay/src/io/deploy/browser-page.js', install = 'apps/relay/src/io/deploy/browser-install.js';
  if (files.has(page)) {
    const { info, result: assets } = servedAssets(files.get(page).toString('utf8'));
    const urls = new Set();
    for (const match of info.code.matchAll(/\btransportModule\s*:[^,}]+/gu)) {
      for (const row of info.strings) if (row.start >= match.index && row.end <= match.index + match[0].length) urls.add(row.text);
    }
    // HTML inserted into the served page is an entry declaration, while arbitrary strings elsewhere are not.
    for (const match of info.code.matchAll(/\.replace\s*\(\s*(['"])[^'"]*\1\s*,\s*(['"])[^'"]*\2/gu)) {
      const row = info.strings.find(value => value.start > match.index && value.end === match.index + match[0].length);
      if (row) for (const path of htmlScripts(row.text)) urls.add(path);
    }
    if (files.has(install)) {
      const worker = lex(files.get(install).toString('utf8'));
      for (const match of worker.code.matchAll(/\bserviceWorker\s*\.\s*register\s*\(\s*(['"])[^'"]*\1/gu)) {
        const row = worker.strings.find(value => value.start >= match.index && value.end <= match.index + match[0].length);
        if (row) urls.add(row.text);
      }
    }
    for (const url of urls) {
      if (assets.has(url)) add(page, assets.get(url));
      else unknown.push({ file: page, specifier: url, reason: 'browser entry has generated or unresolved serving bytes; physical export reach is unproven' });
    }
  }
  return { mode: 'transitional', roots: [...roots].sort(), unknown };
}
