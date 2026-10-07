/** Board identity is random, durable across moves and added to older boards in place (A2). */
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../src/board.js';

/** Make a unique directory for a real SQLite board file. */
function boardFile() {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-identity-'));
  return { directory, file: join(directory, 'board.sqlite') };
}

test('[A2] fresh boards receive distinct 128-bit identities', () => {
  const first = boardFile();
  const second = boardFile();
  try {
    const boardA = store.openBoard(first.file);
    const boardB = store.openBoard(second.file);
    try {
      const idA = store.boardId(boardA);
      const idB = store.boardId(boardB);
      assert.match(idA, /^[0-9a-f]{32}$/);
      assert.match(idB, /^[0-9a-f]{32}$/);
      assert.notEqual(idA, idB);
    } finally {
      store.closeBoard(boardA);
      store.closeBoard(boardB);
    }
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
    rmSync(second.directory, { recursive: true, force: true });
  }
});

test('[A2] board identity survives connection reopen and moving its directory', () => {
  const box = boardFile();
  const movedDirectory = `${box.directory}-moved`;
  try {
    const board = store.openBoard(box.file);
    const originalId = store.boardId(board);
    store.closeBoard(board);

    const reopened = store.openBoard(box.file);
    assert.equal(store.boardId(reopened), originalId);
    store.closeBoard(reopened);

    renameSync(box.directory, movedDirectory);
    const moved = store.openBoard(join(movedDirectory, 'board.sqlite'));
    try {
      assert.equal(store.boardId(moved), originalId);
    } finally {
      store.closeBoard(moved);
    }
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
    rmSync(movedDirectory, { recursive: true, force: true });
  }
});

test('[A2] an older board gains one identity during in-place upgrade without losing rows', () => {
  const box = boardFile();
  try {
    const board = store.openBoard(box.file);
    store.register(board, { lane: 'coordinator', path: '/repo' });
    const itemId = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Preserved item' });
    const before = {
      agents: board.db.prepare('SELECT * FROM agent ORDER BY agent_id').all(),
      items: board.db.prepare('SELECT * FROM item ORDER BY item_id').all(),
      events: board.db.prepare('SELECT * FROM event ORDER BY event_id').all(),
    };
    store.closeBoard(board);

    const old = new DatabaseSync(box.file);
    old.exec('DROP TABLE board_meta; PRAGMA user_version = 1');
    old.close();

    const upgraded = store.openBoard(box.file);
    let id;
    try {
      id = store.boardId(upgraded);
      assert.match(id, /^[0-9a-f]{32}$/);
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.deepEqual(upgraded.db.prepare('SELECT * FROM agent ORDER BY agent_id').all(), before.agents);
      assert.deepEqual(upgraded.db.prepare('SELECT * FROM item ORDER BY item_id').all(), before.items);
      assert.deepEqual(upgraded.db.prepare('SELECT * FROM event ORDER BY event_id').all(), before.events);
      assert.equal(upgraded.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get().meta_value, id);
      assert.equal(store.getItem(upgraded, itemId).item_title, 'Preserved item');
    } finally {
      store.closeBoard(upgraded);
    }

    const reopened = store.openBoard(box.file);
    try {
      assert.equal(store.boardId(reopened), id);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM board_meta WHERE meta_key = 'board_id'").get().count, 1);
    } finally {
      store.closeBoard(reopened);
    }
  } finally {
    rmSync(box.directory, { recursive: true, force: true });
  }
});
