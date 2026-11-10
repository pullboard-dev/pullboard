/** Private live HTTP stream fixture with bounded frame reads [A2,N26]. */
import assert from 'node:assert/strict';
import { fetchFresh } from '../http.js';

/**
 * Open a live event stream and read its frames one at a time. A pending read is shared across
 * timeouts, so a quiet-period check cannot consume a later frame.
 */
export async function liveFrames(t, url, headers) {
  const controller = new AbortController();
  const response = await fetchFresh(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(response.status, 200, 'the stream opens');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let pending = null;
  let closing = false;
  /** Parse the next complete frame that carries data, skipping comments. */
  async function read() {
    while (true) {
      const boundary = buffered.indexOf('\n\n');
      if (boundary >= 0) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (raw.startsWith(':') || data === undefined) continue;
        return { event: /^event: (.+)$/m.exec(raw)?.[1] ?? 'message', id: /^id: (.+)$/m.exec(raw)?.[1] ?? null, data: JSON.parse(data) };
      }
      const { value, done } = await reader.read();
      if (done && closing) return null;
      assert.equal(done, false, 'the live stream stays open while its boards are served');
      buffered += decoder.decode(value, { stream: true });
    }
  }
  /** Share one pending read until it settles. */
  function next() {
    pending ??= read().finally(() => { pending = null; });
    return pending;
  }
  /** Read the next frame, failing rather than hanging if none comes, and clear the ceiling either way. */
  async function frame(label) {
    let timer;
    try {
      return await Promise.race([
        next(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no frame arrived (${label})`)), 10_000); }), // budget: hang ceiling for one live frame, not a latency claim.
      ]);
    } finally { clearTimeout(timer); }
  }
  /** Read frames until each predicate has matched one, returning every frame read. */
  async function until(label, ...wanted) {
    const frames = [];
    const left = [...wanted];
    while (left.length) {
      const got = await frame(label);
      frames.push(got);
      const matched = left.findIndex((predicate) => predicate(got));
      if (matched >= 0) left.splice(matched, 1);
    }
    return frames;
  }
  /** Require silence for longer than one server poll, clearing the window's timer either way. */
  async function quiet(label) {
    let timer;
    const silence = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 350); }); // budget: silence across more than one 200 ms server poll.
    try {
      const extra = await Promise.race([next().then((value) => ({ value })), silence]);
      assert.equal(extra, null, `nothing is sent while nothing changes (${label})`); // budget: silence across more than one 200 ms server poll.
    } finally { clearTimeout(timer); }
  }
  /** Stop the response and settle any pending read on pass and failure paths. */
  async function close() {
    if (closing) return;
    closing = true;
    controller.abort();
    await reader.cancel().catch(() => {});
    await pending?.catch(() => {});
  }
  t.after(close);
  return { until, quiet, close };
}
