/** Serialize browser reads, sends and streamed events through one recoverable per-board queue. */
export function enqueueStream(entry, work) {
  const task = (entry.queue ?? Promise.resolve()).then(work);
  entry.queue = task.catch(() => {});
  return task;
}

/** Parse an SSE packet using the standard event name and joined data fields. */
function parsePacket(packet) {
  let event = 'message';
  const data = [];
  for (const line of packet.split(/\r?\n/u)) {
    if (line.startsWith('event:')) event = line.slice(6).trimStart();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

/** Mark handler failures separately so bad sealed records stop instead of reconnecting forever. */
class StreamMessageFailure extends Error {
  /** Preserve the original decode or projection failure for the visible browser notice. */
  constructor(cause) { super(cause?.message ?? 'The relay message could not be read.'); this.cause = cause; }
}

/** Read one response body and await each message before delivering the next. */
async function readResponse(response, signal, deliver) {
  if (!response.body) throw new Error('The relay stream is unavailable. Refresh this board.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const abort = () => { void reader.cancel().catch(() => {}); };
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  /** Deliver one packet and distinguish client processing errors from transport errors. */
  async function deliverPacket(packet) {
    const message = parsePacket(packet);
    if (!message.data) return;
    try { await deliver(message); } catch (error) { throw new StreamMessageFailure(error); }
  }
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const packets = buffer.split(/\r?\n\r?\n/u);
      buffer = packets.pop() ?? '';
      for (const packet of packets) {
        if (signal.aborted) return;
        await deliverPacket(packet);
      }
      if (done) {
        // EventSource dispatches only events terminated by a blank line; an EOF mid-frame is replayed.
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* Abort may have already detached the stream. */ }
  }
}

/** Wait before reconnecting after an ordinary network error or a clean server-side EOF. */
function waitRetry(signal, milliseconds) {
  return new Promise(resolve => {
    let timer;
    /** Finish once, clearing both the timer and the abort listener. */
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Follow SSE with bounded reconnect delay, cursor-derived URLs, and fatal message-error handling. */
export async function followStream({ url, signal, request, onMessage, onFailure, retryMs = 3000 }) {
  while (!signal.aborted) {
    try {
      const response = await request(url(), signal);
      if (!response.ok) {
        let document;
        try { document = await response.json(); } catch { document = null; }
        throw new Error(document?.error?.message ?? 'The relay stream ended. Refresh this board.');
      }
      await readResponse(response, signal, onMessage);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof StreamMessageFailure || error?.fatal === true) {
        onFailure(error instanceof StreamMessageFailure ? error.cause : error, { fatal: true });
        return;
      }
      onFailure(error, { fatal: false });
    }
    await waitRetry(signal, retryMs);
  }
}
