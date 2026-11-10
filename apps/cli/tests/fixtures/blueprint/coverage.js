import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Check that every architecture must rule has a checked starter row whose check proves red before
 * its fixture exists and green after it is built; an uncovered must rule refuses without writing.
 * @param {{ blueprint: object, freshBoard: Function, json: Function, runFixtureChild: Function }} options
 * @returns {void}
 */
export function assertArchitectureBlueprintCoverage({ blueprint, freshBoard, json, runFixtureChild }) {
  const box = freshBoard({ gate: 'true' });
  writeFileSync(join(box.repo, 'edge-api.json'), `${JSON.stringify(blueprint)}\n`);
  const added = json(box, 'blueprint', 'add', 'edge-api.json');
  const filed = json(box, 'list', '--all').items;
  assert.equal(filed.length, blueprint.items.length);
  for (const rule of blueprint.rules) {
    if (rule.tier === 'aim') continue;
    const row = added.rows.find(entry => entry.key === rule.key);
    const item = filed.find(entry => entry.item_spec_ids.split(',').includes(row.id));
    assert.ok(item?.item_check, `${rule.key} has a checked starter item`);
    assert.equal(item.item_check_baseline ?? null, null, 'adding a blueprint never runs its checks');
    assert.notEqual(runFixtureChild('/bin/sh', ['-c', item.item_check], { cwd: box.repo, env: box.env }).status, 0,
      `${rule.key} check is red before its fixture is built`);
  }
  mkdirSync(join(box.repo, 'app/src'), { recursive: true });
  writeFileSync(join(box.repo, 'app/src/alarm.js'), 'export const alarm = true;\n');
  writeFileSync(join(box.repo, 'app/src/deadline.js'), 'export const deadline = 100;\n');
  for (const item of filed) {
    assert.equal(runFixtureChild('/bin/sh', ['-c', item.item_check], { cwd: box.repo, env: box.env }).status, 0,
      `${item.item_title} check is green after the fixture is built`);
  }

  const uncoveredBox = freshBoard({ gate: 'true' });
  const uncovered = { ...blueprint, name: 'uncovered-edge-api', items: [blueprint.items[0]] };
  writeFileSync(join(uncoveredBox.repo, 'uncovered-edge-api.json'), `${JSON.stringify(uncovered)}\n`);
  const before = readFileSync(join(uncoveredBox.repo, 'SPEC.md'), 'utf8');
  const refused = uncoveredBox.run('blueprint', 'add', 'uncovered-edge-api.json', '--json');
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, 'BLUEPRINT_RULE_UNCHECKED');
  assert.equal(readFileSync(join(uncoveredBox.repo, 'SPEC.md'), 'utf8'), before, 'uncovered must rules write nothing');
  assert.equal(json(uncoveredBox, 'list', '--all').items.length, 0, 'no starter item is filed');

  const aimOnly = { ...blueprint, name: 'optional-aim', rules: blueprint.rules.map((rule, index) => index ? { ...rule, tier: 'aim' } : rule), items: [blueprint.items[0]] };
  writeFileSync(join(uncoveredBox.repo, 'optional-aim.json'), `${JSON.stringify(aimOnly)}\n`);
  assert.equal(json(uncoveredBox, 'blueprint', 'add', 'optional-aim.json').blueprint.name, 'optional-aim', 'an uncovered aim row is optional');
}
