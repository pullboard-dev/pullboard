import { Refused } from '../../../../../packages/kernel/browser.js';

const MOVE_BYTES = 32 * 1024 * 1024;

/** Read a legacy JSON move or bounded gzip move after the caller authenticates its seal. */
export async function decodeSealedMove(plain) {
  try {
    if (plain[0] !== 0x1f || plain[1] !== 0x8b) return JSON.parse(new TextDecoder().decode(plain));
    if (typeof DecompressionStream !== 'function') throw new Error('gzip is unavailable');
    let length = 0;
    const bound = new TransformStream({
      transform(chunk, controller) {
        length += chunk.byteLength;
        if (length > MOVE_BYTES) throw new Error('gzip move exceeds its read limit');
        controller.enqueue(chunk);
      },
    });
    const stream = new Response(plain).body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(bound);
    const bytes = await new Response(stream).arrayBuffer();
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  catch {
    throw new Refused('RELAY_MOVE', 'The authenticated relay document is invalid; upgrade pullboard or restore a consistent snapshot.');
  }
}
