/** The transport cell's one door to Node's HTTP stack: the pull server listens through it and the pull runner dials out through it [P7]. */
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Open a pull server's listener; it listens only when its caller calls listen. */
export const createWireServer = createServer;

/**
 * The outbound request function for a URL's scheme.
 * Why: the runner only ever dials out, so this is its single network call.
 *
 * @param {URL} url
 * @returns {typeof httpRequest}
 */
export const wireRequest = url => url.protocol === 'https:' ? httpsRequest : httpRequest;
