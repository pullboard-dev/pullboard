/** Real isolated repository and child boundaries for documentation generation proofs [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanGitEnvironment } from '../../../../../packages/git/index.js';
import { runFixtureChild } from '../child.js';
import { runFixtureGit } from '../child.js';

/** Copy the complete committed candidate, preserving module and data dependencies in actual Git. */
export function docsRepository(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-generated-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...cleanGitEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.NODE_TEST_CONTEXT;
  const archiveFile = join(root, '.source.tar');
  const archive = runFixtureChild('git', ['archive', '--output', archiveFile, 'HEAD'], { cwd: join(import.meta.dirname, '../../../../..'), env });
  assert.equal(archive.status, 0, archive.context);
  const extracted = runFixtureChild('tar', ['-xf', archiveFile, '-C', root], { env });
  assert.equal(extracted.status, 0, extracted.context);
  rmSync(archiveFile);
  /** Execute Git only inside this private fixture. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Run a real candidate executable with the ordinary inherited Node options. */
  const node = (...args) => runFixtureChild(process.execPath, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Generated documentation fixture');
  git('config', 'user.email', 'docs@example.invalid');
  git('config', 'core.hooksPath', '/dev/null');
  git('add', '.'); git('commit', '-qm', 'source fixture');
  return { root, env, git, node };
}

/** Add one actual lazy command, result contract and format declaration through independent files. */
export function addDocumentedCommand(box, name) {
  writeFileSync(join(box.root, `apps/cli/src/io/commands/${name}.js`),
    `/** Fixture command. */\nexport function run(io) { io.result?.({ fixture: '${name}' }); io.say('${name}'); return 0; }\n`);
  writeFileSync(join(box.root, `apps/cli/src/io/command-docs/${name}.json`), JSON.stringify({ name,
    help: `  pullboard ${name}  fixture command\n`, required: { fixture: 'string' } }, null, 2) + '\n');
  const constant = name.toUpperCase().replaceAll('-', '_') + '_VERSION';
  writeFileSync(join(box.root, `apps/cli/src/io/${name}-version.js`), `export const ${constant} = 1;\n`);
  writeFileSync(join(box.root, `packages/state/src/io/formats/${name}.json`), JSON.stringify({ name, order: 60,
    version: { kind: 'constant', file: `apps/cli/src/io/${name}-version.js`, constant }, source: `\`${constant}\``, upgrade: 'Preserve fixture records.' }, null, 2) + '\n');
  const generated = box.node('docs/tools/update-docs.js');
  assert.equal(generated.status, 0, generated.context);
}
