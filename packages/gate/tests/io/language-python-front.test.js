/** @pullboard-test-input source-cell gate */
/** A uv or poetry Python project runs pytest through its own front command [#10357,C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('language-python-front-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

test('gate.language-python-front.uv-lock-runs-uv: clause 1: a root with pyproject.toml and uv.lock detects python with uv run pytest [C7]', (t) => {
  const root = rootWith(t, { 'pyproject.toml': '[project]\nname = "x"\n', 'uv.lock': '' });
  assert.deepEqual(detectLanguages(root), [{ language: 'python', command: 'uv run pytest' }]);
});

test('gate.language-python-front.poetry-lock-runs-poetry: clause 2: pyproject.toml with poetry.lock and no uv.lock detects poetry run pytest, and uv.lock wins when both exist [C7]', (t) => {
  const poetry = rootWith(t, { 'pyproject.toml': '[tool.poetry]\n', 'poetry.lock': '' });
  assert.deepEqual(detectLanguages(poetry), [{ language: 'python', command: 'poetry run pytest' }]);
  const both = rootWith(t, { 'pyproject.toml': '[tool.poetry]\n', 'poetry.lock': '', 'uv.lock': '' });
  assert.deepEqual(detectLanguages(both), [{ language: 'python', command: 'uv run pytest' }]);
});

test('gate.language-python-front.no-lock-keeps-pytest: clause 3: neither lock file keeps pytest exactly as today, and a lock without pyproject.toml fronts nothing [C7]', (t) => {
  const plain = rootWith(t, { 'pyproject.toml': '[project]\n' });
  assert.deepEqual(detectLanguages(plain), [{ language: 'python', command: 'pytest' }]);
  const orphan = rootWith(t, { 'requirements.txt': 'pytest\n', 'uv.lock': '' });
  assert.deepEqual(detectLanguages(orphan), [{ language: 'python', command: 'pytest' }]);
});
