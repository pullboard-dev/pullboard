/** Copy only the exercised canonical runner modules, not the complete shipped application [C7,V4]. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { importsIn } from '../src/module-imports.js';
import { createRunnerModuleParser } from '../src/runner-module-parser.js';
import { runtimeUrls } from '../src/runner-runtime-urls.js';

/** Retain unchanged production code and discovered move/engine declarations used by its eager imports.
 * This is a private fixture copier, not a runtime attestation or a general computed-import closure proof.
 * Computed runner imports select the fixture's own tests; the move registry and engine scan need their
 * actual declarations. Every copied module otherwise follows its literal imports and runtime-file URLs.
 */
export function copyFixtureRunner(source, destination) {
  const parser = createRunnerModuleParser();
  const files = new Set(['package.json']);
  let pending = ['bin/run-tests.js',
    ...readdirSync(join(source, 'src/moves')).filter(file => file.endsWith('.js')).map(file => `src/moves/${file}`),
    ...readdirSync(join(source, 'src')).filter(file => file.endsWith('-engine.js')).map(file => `src/${file}`)];
  try {
    while (pending.length) {
      const level = [...new Set(pending)].filter(file => !files.has(file));
      pending = [];
      const sources = level.map(file => readFileSync(join(source, file), 'utf8'));
      const imports = importsIn(sources, parser.parse);
      for (const [index, file] of level.entries()) {
        files.add(file);
        const runtime = runtimeUrls(sources[index], parser.parse) ?? [];
        for (const specifier of [...imports[index], ...runtime]) {
          if (isBuiltin(specifier) || specifier === '(computed)') continue;
          if (!specifier.startsWith('.')) throw new Error(`fixture runner cannot resolve ${file}: ${specifier}`);
          const target = posix.normalize(posix.join(posix.dirname(file), specifier));
          if (target.startsWith('../') || !existsSync(join(source, target))) throw new Error(`fixture runtime path is unavailable: ${target}`);
          if (statSync(join(source, target)).isDirectory()) continue;
          if (/\.[cm]?js$/u.test(target)) pending.push(target);
          else files.add(target);
        }
      }
    }
  } finally { parser.close(); }
  for (const file of files) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, file), target);
  }
  return [...files].sort();
}
