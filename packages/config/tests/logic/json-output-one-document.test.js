/** `--json` stdout is one JSON document, even when a diagnostic was raised and a command streamed its own document [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandOutput } from '../../index.js';

/** Run one fake command through the collector and return what each stream received. */
function run(argv, command) {
  const out = [], err = [];
  const io = commandOutput(argv, { stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } },
    { refusalDocument: () => ({}) });
  command(io);
  io.flush(0);
  return { stdout: out.join(''), stderr: err.join('') };
}

test('config.logic-json-output-one-document.clause-2-lanes-json-with-a-diagnostic: clause 2: lanes --json with a diagnostic writes one JSON document to stdout [C7]', () => {
  const { stdout } = run(['lanes', '--json'], io => { io.err('[SHARED_SCHEMA_DIFFERENCE] a column differs'); io.result({ lanes: {} }); });
  assert.deepEqual(JSON.parse(stdout).diagnostics, ['[SHARED_SCHEMA_DIFFERENCE] a column differs']);
});

test('config.logic-json-output-one-document.clause-2-export-json-that-streams-its: clause 2: export --json that streams its own document with a diagnostic writes only that document to stdout [C7]', () => {
  const { stdout, stderr } = run(['export', '--json'], io => {
    io.err('[SHARED_SCHEMA_DIFFERENCE] a column differs');
    io.stdout.write(`${JSON.stringify({ version: 1, tables: {} }, null, 2)}\n`);
  });
  assert.deepEqual(JSON.parse(stdout), { version: 1, tables: {} });
  assert.match(stderr, /SHARED_SCHEMA_DIFFERENCE/u, 'the diagnostic is still shown, on stderr');
});
