/** The closed source-identity inventory counts real imports only, never import text inside string literals [M1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceFacts } from './machine-source-functions.fixture.js';
import { withoutStringText } from './machine-source-functions.fixture.js';

test('clause 1: a template string holding an import line records no identity, while real imports stay [M1,C7]', () => {
  const source = [
    "import { real } from './real.js';",
    "import * as space from './space.js';",
    'const entry = `import * as gate from \'./packages/gate/index.js\';',
    "import { fake } from './packages/fake.js';",
    'export const x = ${nested({ a: `import * as deep from "./deep.js"` })};`;',
    "const quoted = \"import * as q from './quoted.js'\";",
    "export function run() { return real(space, entry, quoted); }",
    '',
  ].join('\n');
  const facts = sourceFacts(source, 'apps/cli/src/shell/job.js');
  assert.deepEqual([...facts.named.keys()], ['real']);
  assert.equal(facts.named.get('real'), 'apps/cli/src/shell/real.js#real');
  assert.deepEqual([...facts.spaces.keys()], ['space']);
  assert.equal(facts.source, source, 'the original source bytes are kept');
});

test('clause 1: blanking keeps line count and leaves specifier strings of real imports [M1,C7]', () => {
  const source = "import { a } from './a.js';\nconst t = `x\n${1 + 2}\ny`;\nexport { b } from \"./b.js\";\n";
  const masked = withoutStringText(source);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.ok(masked.includes("from './a.js'") && masked.includes('from "./b.js"'));
});
