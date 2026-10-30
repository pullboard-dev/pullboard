/** Shared assertions and request helpers for local API fixtures. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { JSON_SHAPES } from '../src/json.js';
import { fetchFresh } from './http-fixture.js';

/** Quote a literal executable path for the fixture hook's POSIX shim. */
export function shellWord(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Match one catalog field to its declared JSON value type. */
function hasType(value, type) {
  if (type.includes('|')) return type.split('|').some((part) => hasType(value, part));
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

/** Check one required-field map from JSON_SHAPES. */
function assertRequiredShape(value, required, label) {
  for (const [field, type] of Object.entries(required ?? {})) {
    assert.ok(Object.hasOwn(value, field), `${label} must include ${field}`);
    assert.ok(hasType(value[field], type), `${label}.${field} must be ${type}`);
  }
}

/** Send one bounded HTTP request to the fixture API on its own connection, authenticating by header unless overridden. */
function apiFetch(api, path, options = {}) {
  const { noSecret = false, ...requestOptions } = options;
  const headers = { ...(noSecret ? {} : { 'x-pullboard-key': api.secret }), ...requestOptions.headers };
  return fetchFresh(new URL(path, api.origin), { ...requestOptions, headers, signal: requestOptions.signal ?? AbortSignal.timeout(10_000) });
}

/** The milliseconds one awaited request takes, end to end. */
async function timedMs(work) { const started = performance.now(); await work(); return performance.now() - started; }

/** Parse and validate a versioned API refusal. */
async function apiError(response, status) {
  assert.equal(response.status, status);
  const document = await response.json();
  assertRequiredShape(document, JSON_SHAPES.error.required, 'HTTP error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'HTTP error');
  return document.error;
}

/** Read exactly the next non-comment server-sent event, preserving partial frames across chunks. */
async function nextSseEvent(reader, pending = { text: '' }) {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = pending.text.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = pending.text.slice(0, boundary);
      pending.text = pending.text.slice(boundary + 2);
      const id = /^id: (.+)$/m.exec(frame)?.[1];
      const data = [...frame.matchAll(/^data: (.+)$/gm)].map((match) => match[1]).join('\n');
      if (id !== undefined && data) return { id, document: JSON.parse(data) };
      continue;
    }
    const { done, value } = await reader.read();
    assert.equal(done, false, 'the live event stream remains open');
    pending.text += decoder.decode(value, { stream: true });
  }
}

export { apiFetch, apiError, assertRequiredShape, hasType, nextSseEvent, timedMs };

/** Build the actual HTTP fixture child's private terminal and Git identity. */
export function apiFixtureEnvironment(directory, bin) {
  return {
    ...process.env, HOME: join(directory, 'home'), PULLBOARD_HOME: join(directory, 'home'),
    PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'),
    PATH: bin + ':' + process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'HTTP Agent', GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'HTTP Agent', GIT_COMMITTER_EMAIL: 'agent@example.invalid',
  };
}

/** Capture one ambient pool per test, even when it creates several boards, and restore it at test teardown. */
const fixtureMachineTests = new WeakSet();

/** Bind in-process API commands as well as child commands to a fixture-owned machine pool. */
export function bindApiFixtureMachine(t, env) {
  if (!fixtureMachineTests.has(t)) {
    const previous = process.env.PULLBOARD_MACHINE_HOME;
    fixtureMachineTests.add(t);
    t.after(() => {
      if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
      else process.env.PULLBOARD_MACHINE_HOME = previous;
    });
  }
  process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
}
