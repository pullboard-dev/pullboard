/** Cockpit snapshot export keeps the checkout paths a person wrote and redacts the structured ones [A10,N26]. */
/** @pullboard-test-gui */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  machine,
  project,
  fetchLive,
  startView,
  boardOf,
} from '../../../tests/fixtures/cockpit/harness.js';
import { fileFixtureItem } from '../../../tests/fixtures/testkit.js';

test('static export redacts structured checkout paths but preserves paths people wrote [A10]', async () => {
  const box = machine();
  const alpha = project(box, 'private-project');
  await fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Private checkout item', criterion: 'exports without checkout paths', check: null, args: ['--specs', 'G1'], run: async (root, ...argv) => ({ code: 0, out: await box.inProcess(root, ...argv) }) });
  const projectRoot = alpha.repo;
  const worktreeRoot = alpha.web;
  const commonGitDir = box.git(alpha.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const live = await startView(box);
  try {
    const listingResponse = await fetchLive(`${live.base}/api/v1/boards`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(listingResponse.status, 200);
    const listing = await listingResponse.json();
    const board = listing.boards.find((entry) => entry.root === projectRoot);
    assert.ok(board, 'the live listing keeps the absolute project root');
    assert.equal(board.root, projectRoot);
    const state = await boardOf(live, projectRoot);
    assert.equal(state.root, projectRoot, 'live state keeps the absolute root');
    const agent = state.agents.find((entry) => entry.agent_id === 'web-1');
    assert.ok(agent);
    assert.equal(agent.agent_path, worktreeRoot, 'live state keeps the agent worktree path');
    assert.equal(box.git(alpha.web, 'rev-parse', '--path-format=absolute', '--git-common-dir'), commonGitDir,
      'the linked worktree still shares the repository common Git directory');
    const boardEvents = await fetchLive(`${live.base}/api/v1/boards/${board.id}/events`, { headers: { 'x-pullboard-key': live.key } });
    assert.equal(boardEvents.status, 200);
    const events = await boardEvents.json();
    assert.ok(events.events.length > 0);

    /** Read every actual export Buffer so an unexpected subtree cannot hide a private folder. */
    const exportedText = (output) => output.files().map(({ body }) => body.toString('utf8')).join('\n');
    const structuredOutput = box.exportSnapshot(alpha.repo, 'export-structured');
    const structuredFiles = exportedText(structuredOutput);
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!structuredFiles.includes(privatePath), `export does not include structured path ${privatePath}`);
    }

    // A second export deliberately includes paths in human-authored prose. Those exact values are
    // the only allowed occurrences; project.root, agent_path and common Git metadata stay redacted.
    const brief = `Keep this literal checkout reference: ${projectRoot}`;
    const shout = `Please inspect this literal agent folder: ${worktreeRoot}`;
    await fileFixtureItem(box, alpha.repo, { lane: 'web', title: 'Path in prose', criterion: 'keeps prose literal', check: null, brief, args: ['--specs', 'G1', '--not-duplicate-of', '1 a prose-path fixture, not the private checkout item'], run: async (root, ...argv) => ({ code: 0, out: await box.inProcess(root, ...argv) }) });
    await box.inProcess(alpha.web, 'shout', 'all', shout);
    const proseOutput = box.exportSnapshot(alpha.repo, 'export-prose');
    const proseSnapshot = proseOutput.root;
    const stateFile = JSON.parse(readFileSync(join(proseSnapshot, 'api', 'v1', 'boards', board.id, 'state.json'), 'utf8')).state;
    assert.notEqual(stateFile.root, projectRoot, 'export redacts structured project root');
    assert.notEqual(stateFile.agents.find((entry) => entry.agent_id === 'web-1').agent_path, worktreeRoot,
      'export redacts the structured agent worktree');
    assert.equal(stateFile.items.find((entry) => entry.title === 'Path in prose').brief, brief);
    assert.ok(stateFile.shouts.some((entry) => entry.shout_text === shout), 'the authored shout remains literal');
    const proseFiles = proseOutput.files().map(({ body }) => body.toString('utf8'));
    let scrubbedText = proseFiles.join('\n');
    for (const text of [brief, shout]) {
      scrubbedText = scrubbedText.replaceAll(JSON.stringify(text), '"<authored prose>"')
        .replaceAll(JSON.stringify(JSON.stringify(text)).slice(1, -1), '<authored event prose>');
    }
    for (const privatePath of [box.dir, projectRoot, worktreeRoot, commonGitDir]) {
      assert.ok(!scrubbedText.includes(privatePath), `outside authored prose, export does not include ${privatePath}`);
    }
  } finally {
    await live.stop();
  }
});
