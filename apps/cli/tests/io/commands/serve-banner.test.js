/** `pullboard serve` says in its help and its first output that it is the board API with no page, and names the view command [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELP } from '../../../src/io/help.js';
import { selectedHelp } from '../../../src/io/help.js';
import { serveBanner } from '../../../src/io/commands/serve.js';

test('cli.io-commands-serve-banner.the-serve-help-says-it-is-the: clause 1: the serve help says it is the board API with no page and names pullboard view [C7]', () => {
  const text = selectedHelp('serve', undefined, undefined, [], { help: true }).text;
  assert.match(text, /board API/u);
  assert.match(text, /serves no page/u);
  assert.match(text, /run pullboard view/u);
  assert.match(HELP.all, /pullboard serve .*the board API v1 \(JSON, no page\)/u);
  assert.match(HELP.all, /for the page, run pullboard view/u);
});

test('cli.io-commands-serve-banner.the-first-line-serve-prints-keeps-the: clause 1: the first line serve prints keeps the address and the next names the view command [C7]', () => {
  const [first, second] = serveBanner('http://127.0.0.1:4977/api/v1/boards?k=abc');
  assert.match(first, /^Pullboard API v1 \(JSON only, it has no page\): http:\/\/127\.0\.0\.1:4977\/api\/v1\/boards\?k=abc$/u);
  assert.equal(second, 'To see the board in a browser, run: pullboard view');
});
