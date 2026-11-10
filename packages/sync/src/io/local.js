/** Local view requests use a fresh HTTP transport so undici's first-write socket options cannot escape [C7,N26]. */
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

/** Recognize only literal loopback HTTP addresses; remote and HTTPS traffic keeps its own transport. */
export function isLocalHttp(url) {
  const address = new URL(url);
  return address.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname);
}

/** Fetch a loopback response on fresh sockets; redirects outside loopback are refused as well. */
export async function fetchLocal(url, init = {}, redirects = 0) {
  if (!isLocalHttp(url)) throw new TypeError('local fetch requires a loopback HTTP address');
  const request = new Request(url, init);
  request.signal.throwIfAborted();
  const response = await new Promise((resolveResponse, rejectResponse) => {
    let outgoing;
    let incoming;
    /** Keep an abort's reason and ordinary network errors in their familiar fetch shapes. */
    const fail = error => rejectResponse(request.signal.aborted
      ? request.signal.reason : new TypeError('fetch failed', { cause: error }));
    /** Release the abort subscription when the response ends or its connection is cancelled. */
    const cleanup = () => request.signal.removeEventListener('abort', abort);
    /** Cancel only this request and its streamed response, including after headers have arrived. */
    const abort = () => {
      incoming?.destroy(request.signal.reason);
      outgoing?.destroy(request.signal.reason);
      fail(request.signal.reason);
    };
    try {
      const headers = Object.fromEntries(request.headers);
      headers.connection = 'close';
      outgoing = httpRequest(new URL(request.url), { method: request.method, headers, agent: false }, stream => {
        incoming = stream;
        stream.once('close', cleanup);
        const body = request.method === 'HEAD' || [204, 205, 304].includes(stream.statusCode)
          ? null : Readable.toWeb(stream);
        const responseHeaders = new Headers();
        for (let index = 0; index < stream.rawHeaders.length; index += 2) {
          responseHeaders.append(stream.rawHeaders[index], stream.rawHeaders[index + 1]);
        }
        try {
          const response = new Response(body, {
            status: stream.statusCode, statusText: stream.statusMessage, headers: responseHeaders,
          });
          Object.defineProperty(response, 'url', { value: request.url });
          Object.defineProperty(response, 'redirected', { value: redirects > 0 });
          if (body === null) stream.resume();
          resolveResponse(response);
        } catch (error) {
          stream.destroy();
          fail(error);
        }
      });
      outgoing.on('error', fail);
      outgoing.once('close', () => { if (!incoming) cleanup(); });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) return abort();
      if (request.body) {
        Readable.fromWeb(request.body).on('error', error => outgoing.destroy(error)).pipe(outgoing);
      } else outgoing.end();
    } catch (error) {
      cleanup();
      outgoing?.destroy();
      fail(error);
    }
  });
  const location = response.headers.get('location');
  if (![301, 302, 303, 307, 308].includes(response.status) || !location || request.redirect === 'manual') return response;
  await response.body?.cancel();
  if (request.redirect === 'error' || redirects >= 20) throw new TypeError('local fetch redirect refused');
  const target = new URL(location, request.url);
  const headers = new Headers(request.headers);
  if (target.origin !== new URL(request.url).origin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('x-pullboard-key');
  }
  const changeToGet = (response.status === 303 && !['GET', 'HEAD'].includes(request.method))
    || ([301, 302].includes(response.status) && request.method === 'POST');
  if (changeToGet) {
    headers.delete('content-type');
    headers.delete('content-length');
  }
  return fetchLocal(target, { ...init, headers, ...(changeToGet ? { method: 'GET', body: undefined } : {}) }, redirects + 1);
}
