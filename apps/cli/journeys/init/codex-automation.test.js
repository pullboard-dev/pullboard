/** Init writes a paused Codex automation template generated from the shared seat-loop source [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CODEX_AUTOMATION_FILE } from '../../../../packages/config/index.js';
import { renderCodexAutomation } from '../../../../packages/config/index.js';
import { SEAT_LOOP } from '../../../../packages/config/index.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { declaredAgentTools } from '../../src/io/skills.js';
import { installCodexAutomation } from '../../src/io/skills.js';

/** Read the template's prompt back out of its TOML line, which holds a JSON string. */
function promptOf(text) {
  const line = text.split('\n').find(row => row.startsWith('prompt = '));
  return JSON.parse(line.slice('prompt = '.length));
}

test('cli.journeys-init-codex-automation.init-writes-a-codex-automation-template: clause 1: init writes a Codex automation template that matches the shared seat-loop source [C7]', () => {
  const inputs = privateFixtureFiles('pullboard-codex-automation-');
  mkdirSync(join(inputs.root, '.codex'));
  const tools = declaredAgentTools(inputs.root);
  assert.deepEqual(tools, ['codex']);
  const written = [];
  installCodexAutomation(inputs.root, path => written.push(path), tools);
  assert.deepEqual(written, [CODEX_AUTOMATION_FILE]);
  const text = readFileSync(join(inputs.root, CODEX_AUTOMATION_FILE), 'utf8');
  assert.equal(text, renderCodexAutomation());
  assert.ok(promptOf(text).includes(SEAT_LOOP), 'the prompt carries the seat loop verbatim');
  assert.match(text, /^status = "PAUSED"$/mu);
  installCodexAutomation(inputs.root, path => written.push(path), tools);
  assert.equal(written.length, 1, 'a second run keeps what is there');
});

test('cli.journeys-init-codex-automation.a-claude-only-project-gets-no: clause 1: a Claude-only project gets no Codex automation template [C7]', () => {
  const inputs = privateFixtureFiles('pullboard-codex-automation-');
  mkdirSync(join(inputs.root, '.claude'));
  assert.deepEqual(installCodexAutomation(inputs.root, () => {}, declaredAgentTools(inputs.root)), []);
});
