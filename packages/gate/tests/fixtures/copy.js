/** Copy only the exercised canonical runner modules, not the complete shipped application [C7,V4]. */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import {
  join,
  posix,
} from 'node:path';
import { copyPackageFiles } from '../../../runners/index.js';
import { runnerPackage } from '../../../runners/index.js';
import { importsIn } from '../../index.js';
import { createRunnerModuleParser } from '../../../runners/index.js';
import { runtimeUrls } from '../../../runners/index.js';

/** Retain unchanged production code and discovered move/engine declarations used by its eager imports.
 * This is a private fixture copier, not a runtime attestation or a general computed-import closure proof.
 * Computed runner imports select the fixture's own tests; the move registry and engine scan need their
 * actual declarations. The real worker uses the existing bounded production package closure.
 * Command metadata validates its unchanged implementation paths without executing them.
 * Every copied executable module otherwise follows its literal imports and runtime-file URLs.
 */
export function copyFixtureRunner(source, destination) {
  const sourceRoot = realpathSync(source);
  const parser = createRunnerModuleParser();
  const files = new Set(['package.json', ...Object.keys(runnerPackage(source).files),
    ...['apps/cli/src/io/commands'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.js')).map(file => `${folder}/${file}`)),
    ...['apps/cli/src/io/command-docs', 'apps/cli/src/io/documentation', 'apps/cli/src/io/documentation/events'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.json')).map(file => `${folder}/${file}`))]);
  let pending = ['apps/cli/src/io/run/tests.js',
    ...['src/moves', 'packages/moves/src/logic/moves', 'packages/moves/src/io/moves'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('.js')).map(file => `${folder}/${file}`)),
    ...['packages/state/src/logic/engines'].filter(folder => existsSync(join(source, folder)))
      .flatMap(folder => readdirSync(join(source, folder)).filter(file => file.endsWith('-engine.js')).map(file => `${folder}/${file}`))];
  try {
    while (pending.length) {
      const level = [...new Set(pending)].filter(file => !files.has(file));
      pending = [];
      const sources = level.map(file => readFileSync(join(source, file), 'utf8'));
      const imports = importsIn(sources, parser.parse);
      for (const [index, file] of level.entries()) {
        if (!lstatSync(join(source, file)).isFile() || lstatSync(join(source, file)).isSymbolicLink()
          || !realpathSync(join(source, file)).startsWith(sourceRoot + '/')) throw new Error(`unsafe fixture runtime: ${file}`);
        files.add(file);
        const runtime = runtimeUrls(sources[index], parser.parse) ?? [];
        for (const specifier of [...imports[index], ...runtime]) {
          if (isBuiltin(specifier) || specifier === '(computed)') continue;
          if (!specifier.startsWith('.')) throw new Error(`fixture runner cannot resolve ${file}: ${specifier}`);
          const target = posix.normalize(posix.join(posix.dirname(file), specifier));
          // The export manifest exists only in a built tooling export; the scanner reads it as optional, so a source checkout lacks it.
          if (target === '.pullboard-runner-source.json' && !existsSync(join(source, target))) continue;
          if (target.startsWith('../') || !existsSync(join(source, target))) throw new Error(`fixture runtime path is unavailable: ${target}`);
          if (statSync(join(source, target)).isDirectory()) continue;
          if (/\.[cm]?js$/u.test(target)) pending.push(target);
          else files.add(target);
        }
      }
    }
  } finally { parser.close(); }
  for (const file of files) {
    if (!lstatSync(join(source, file)).isFile() || lstatSync(join(source, file)).isSymbolicLink()
      || !realpathSync(join(source, file)).startsWith(sourceRoot + '/')) throw new Error(`unsafe fixture runtime: ${file}`);
  }
  // This repository-only gate helper is not part of the published runner package; callers that
  // exercise its static preflight copy it explicitly into their private fixture.
  files.delete('packages/gate/tests/fixtures/budgets.js');
  return copyPackageFiles(source, destination, { files: [...files].sort() });
}
