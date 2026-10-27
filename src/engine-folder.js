/** Keep engine identities outside moving cells until per-package engines are decided [C7]. */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lex } from './js-lex.js';

/** Find declarations that would split the existing engine folder during a package move. */
export function engineFolderViolations(sources) {
  const problems = [];
  for (const { file, source } of sources) {
    if (!/^(?:src|packages|apps)\//u.test(file)) continue;
    if (/^src\/[^/]+\.[cm]?js$/u.test(file)) continue;
    const code = lex(source).code;
    const declarations = [...code.matchAll(/\bexport\s+const\s+([A-Z][A-Z0-9_]*_ENGINE)\s*=/gu)];
    if (declarations.length) {
      for (const match of declarations) problems.push({ file, line: code.slice(0, match.index).split('\n').length,
        text: `${match[1]} must stay in src/ with the engine leaves; move the feature without its engine declaration` });
    } else if (/-engine\.js$/u.test(file)) {
      problems.push({ file, line: 1, text: 'engine leaves must stay directly in src/; move the feature without its engine leaf' });
    }
  }
  return problems;
}

/** Read only product source trees; fixture text is lexed without running any module. */
export function engineFolderProblems(root) {
  const sources = [];
  const pending = ['src', 'packages', 'apps'].filter(folder => existsSync(join(root, folder)));
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') pending.push(file);
      else if (entry.isFile() && /\.[cm]?js$/u.test(file)) sources.push({ file, source: readFileSync(join(root, file), 'utf8') });
    }
  }
  return engineFolderViolations(sources).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
}
