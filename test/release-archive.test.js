/** The released-source extraction helper tolerates tar stopping its stdin early [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { unpackRelease } from './release-archive.js';

const ROOT = resolve(import.meta.dirname, '..');

test('an old release unpacks even when tar stops reading early [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-release-archive-'));
  const stub = join(directory, 'bin');
  const extracted = join(directory, 'actual');
  const early = join(directory, 'early');
  mkdirSync(stub);
  mkdirSync(extracted);
  mkdirSync(early);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tar = join(stub, 'tar');
  writeFileSync(tar, '#!/bin/sh\nhead -c 512 >/dev/null\nexit 0\n', { mode: 0o700 });
  chmodSync(tar, 0o700);
  const archive = spawnSync('git', ['archive', 'v0.8.3'], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr?.toString());
  assert.ok(archive.stdout.length > 512, 'the release archive exceeds the stand-in tar read limit');

  const oldPipeline = spawnSync('tar', ['-x', '-C', early], {
    cwd: ROOT, env: { ...process.env, PATH: `${stub}${delimiter}${process.env.PATH ?? ''}` },
    input: archive.stdout, encoding: 'utf8',
  });
  assert.equal(oldPipeline.error?.code, 'EPIPE', 'the stdin-piping form breaks when tar exits after one block');

  const path = process.env.PATH;
  process.env.PATH = `${stub}${delimiter}${path ?? ''}`;
  try {
    assert.doesNotThrow(() => unpackRelease('v0.8.3', extracted));
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }

  writeFileSync(tar, '#!/bin/sh\necho controlled-tar-error >&2\nexit 7\n', { mode: 0o700 });
  process.env.PATH = `${stub}${delimiter}${path ?? ''}`;
  try {
    assert.throws(() => unpackRelease('v0.8.3', extracted), error => {
      assert.match(error.message, /v0\.8\.3/);
      assert.match(error.message, new RegExp(extracted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
      assert.match(error.message, /status 7/);
      assert.match(error.message, /controlled-tar-error/);
      return true;
    }, 'tar failures identify the tag, destination, status and stderr');
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }

  const realDirectory = join(directory, 'real-tar');
  mkdirSync(realDirectory);
  unpackRelease('v0.8.3', realDirectory);
  assert.equal(readFileSync(join(realDirectory, 'src', 'engine.js'), 'utf8').includes('ENGINE_VERSION'), true);
});
