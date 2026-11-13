// pullboard: browser
/** @pullboard-test-gui */
/** A DevTools wait keeps waiting through page changes and navigation errors until its own deadline [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createEvaluator } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { createSender } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { createWaiter } from '../../../../../apps/cli/tests/fixtures/chrome.js';
import { startChrome } from '../../../../../apps/cli/tests/fixtures/chrome.js';

test('a wait that throws while the page changes keeps waiting [C7]', async (t) => {
  let replacementResponse;
  const transition = {
    replacementStartedAt: null,
    firstRendererSampleAt: null,
    firstRendererSampleHadBody: null,
    rendererSampleStatus: 'not-reported',
    gapSampledAt: null,
    gapAcknowledgedAt: null,
    responseFinishedAt: null,
    firstRaceBranch: null,
    waitError: null,
    cpuThrottleRate: null,
  };
  const server = createServer((request, response) => {
    if (request.url === '/before') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body><script>window.goNext = () => location.replace("/next")</script>before</body>');
      return;
    }
    if (request.url === '/next') {
      response.writeHead(200, { 'content-type': 'text/html' });
      transition.replacementStartedAt = Date.now();
      response.write('<!doctype html><html><head><title>loading');
      replacementResponse = response;
      return;
    }
    if (request.url.startsWith('/observed-null?')) {
      response.writeHead(204);
      response.end();
      const query = new URL(request.url, 'http://127.0.0.1').searchParams;
      transition.firstRendererSampleAt = Number(query.get('sampledAt'));
      transition.firstRendererSampleHadBody = query.get('body') === 'true';
      transition.rendererSampleStatus = 'server-received-gap-sample';
      transition.gapSampledAt = transition.firstRendererSampleAt;
      transition.gapAcknowledgedAt = Date.now();
      server.emit('document-gap-observed');
      replacementResponse?.end('</title></head><body>ready</body></html>', () => {
        transition.responseFinishedAt = Date.now();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const documentGapObserved = new Promise((resolveGap) => server.once('document-gap-observed', resolveGap));
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });

  const chrome = await startChrome({ url: `http://127.0.0.1:${server.address().port}/before` });
  try {
    await chrome.waitFor("typeof window.goNext === 'function'", 5_000, 'initial document ready'); // budget: hang ceiling for the private navigation control handshake; no throughput claim.
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    transition.cpuThrottleRate = 6;
    await chrome.evaluate('setTimeout(() => window.goNext(), 0); true');
    const expression = "location.pathname === '/next' ? (() => { if (!window.__raceSampled) { window.__raceSampled = true; window.__raceSampledAt = Date.now(); window.__raceSampledHadBody = Boolean(document.body); if (!window.__raceSampledHadBody) fetch('/observed-null?sampledAt=' + window.__raceSampledAt + '&body=false'); } return document.body.textContent.includes('ready'); })() : false";
    const waiting = chrome.waitFor(expression, 5_000, 'wait for the replacement document')
      .then(() => ({ error: null }), (error) => ({ error }));
    const first = await Promise.race([
      documentGapObserved.then(() => ({ branch: 'gap-observed' })),
      waiting.then((result) => ({ branch: result.error ? 'wait-rejected' : 'wait-resolved', result })),
    ]);
    transition.firstRaceBranch = first.branch;
    if (first.result?.error) transition.waitError = {
      name: first.result.error.name,
      code: first.result.error.code ?? null,
      message: first.result.error.message,
    };
    if (first.branch === 'wait-rejected') transition.rendererSampleStatus = 'unavailable-after-wait-rejection';
    if (first.branch === 'gap-observed') {
      const waitResult = await waiting;
      transition.waitError = waitResult.error ? {
        name: waitResult.error.name,
        code: waitResult.error.code ?? null,
        message: waitResult.error.message,
      } : null;
    } else if (first.branch === 'wait-resolved') {
      const sample = await chrome.evaluate('({ sampledAt: window.__raceSampledAt ?? null, bodyPresent: window.__raceSampledHadBody ?? null })');
      transition.firstRendererSampleAt = sample.sampledAt;
      transition.firstRendererSampleHadBody = sample.bodyPresent;
      transition.rendererSampleStatus = 'browser-readback-after-wait-resolution';
    }
    const evidence = JSON.stringify(transition);
    t.diagnostic(`6× wait transition capture: ${evidence}`);
    assert.equal(first.branch, 'gap-observed', `the wait samples the no-body gap before resolving; transition=${evidence}`);
    assert.equal(transition.rendererSampleStatus, 'server-received-gap-sample', `the server records the renderer gap sample; transition=${evidence}`);
    assert.equal(transition.firstRendererSampleHadBody, false, `the renderer sampled the replacement before its body; transition=${evidence}`);
    assert.ok(Number.isFinite(transition.firstRendererSampleAt) && Number.isFinite(transition.gapAcknowledgedAt), `the sample and server acknowledgement were both recorded; transition=${evidence}`);
    assert.ok(transition.gapSampledAt <= transition.gapAcknowledgedAt, `the server acknowledgement follows the renderer sample; transition=${evidence}`);
    assert.ok(Number.isFinite(transition.responseFinishedAt), `the server records replacement response completion; transition=${evidence}`);
    assert.ok(transition.gapAcknowledgedAt <= transition.responseFinishedAt, `the held response finishes after the server acknowledges the gap; transition=${evidence}`);
    assert.equal(transition.waitError, null, `the document-transition exception stays pending until the next page is ready; transition=${evidence}`);
    assert.equal(await chrome.evaluate('document.body.textContent'), 'ready', 'the replacement document completed');

    const alwaysThrows = '(() => { throw new Error("persistent evaluation failure"); })()';
    const startedAt = Date.now();
    await assert.rejects(chrome.waitFor(alwaysThrows, 350, 'always-throwing expression'), (error) => { // budget: declared 350ms operation deadline for an always-throwing condition.
      assert.match(error.message, /did not arrive within 350ms/u);
      assert.match(error.message, /persistent evaluation failure/u);
      assert.ok(error.message.includes(alwaysThrows), 'deadline diagnostic names the expression');
      assert.ok(Date.now() - startedAt >= 350, 'the wait polls through its requested deadline'); // budget: declared 350ms operation deadline must actually expire.
      return true;
    });

  } catch (error) {
    transition.waitError ??= { name: error.name, code: error.code ?? null, message: error.message };
    t.diagnostic(`transition capture before test failure: ${JSON.stringify(transition)}`);
    throw error;
  } finally {
    await chrome.close();
  }
});

/** Prove waitFor retries a DevTools navigation error instead of abandoning its condition. */
test('a wait keeps waiting through a DevTools error from a page navigation [C7]', async (t) => {
  let afterRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/before') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body>before</body>');
      return;
    }
    if (request.url === '/after') {
      afterRequests += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><body>after</body>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    if (server.listening) server.close();
  });

  const chrome = await startChrome({ url: `${origin}/before` });
  try {
    await chrome.waitFor("location.pathname === '/before' && document.body.textContent === 'before'", 5_000, 'initial document ready'); // budget: hang ceiling for the private initial document handshake; no throughput claim.
    await chrome.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    const expression = `location.pathname === '/before' ? (() => {
      if (!window.__navigationScheduled) {
        window.__navigationScheduled = true;
        setTimeout(() => location.assign('/after'), 0);
      }
      return new Promise(() => {});
    })() : location.pathname === '/after' && document.body.textContent === 'after'`;
    const waitResult = await chrome.waitFor(expression, 5_000, 'wait across document navigation' /* budget: declared 5000ms deadline for this local document-transition condition. */)
      .then(() => ({ resolved: true }), error => ({ resolved: false, error })); // budget: declared 5s ceiling for the local replacement-document handshake.
    assert.equal(waitResult.resolved, true, // budget: this asserts the declared navigation-condition deadline's outcome, not elapsed throughput.
      `the wait retries a DevTools failure from a main-frame navigation; failure=${waitResult.error?.message ?? 'none'}`);
    assert.equal(await chrome.evaluate('document.body.textContent'), 'after', 'the wait resolves on the replacement document');
    assert.equal(afterRequests, 1, 'the real navigation occurs once');

    await chrome.send('Page.navigate', { url: `${origin}/before` }, 'return to the initial document');
    await chrome.waitFor("location.pathname === '/before' && document.body.textContent === 'before'", 5_000, 'initial document ready again'); // budget: hang ceiling for the private reset handshake; no throughput claim.
    const exhaustedExpression = `location.pathname === '/before' ? (() => {
      if (!window.__navigationScheduled) {
        window.__navigationScheduled = true;
        setTimeout(() => location.assign('/after'), 0);
      }
      return new Promise(() => {});
    })() : false`;
    const exhausted = await chrome.waitFor(exhaustedExpression, 5_000, 'wait expires after a navigation error' /* budget: declared 5000ms deadline for a deliberately pending local page condition. */)
      .then(() => ({ resolved: true }), error => ({ resolved: false, error })); // budget: declared 5s private observation ceiling for a local page condition that remains false.
    assert.equal(exhausted.resolved, false, 'the condition remains pending until its declared deadline'); // budget: checks the declared operation-deadline outcome, not elapsed throughput.
    assert.match(exhausted.error.message, /did not arrive within 5000ms/u); // budget: exact diagnostic for the declared 5000ms operation deadline.
    assert.match(exhausted.error.message, /last evaluation failed: DevTools command failed: Runtime\.evaluate/u, // budget: checks retained diagnostics at the declared deadline, not elapsed throughput.
      'the exhausted wait names its last navigation error');
    assert.match(exhausted.error.message, /CDP error -32000/u); // budget: preserves the CDP error captured before the declared deadline.
    assert.match(exhausted.error.message, /page navigated since command was sent: yes/u); // budget: preserves navigation evidence at the declared deadline.
    assert.equal(afterRequests, 2, 'the exhausted wait observes a second real navigation');

    let receiveMessage;
    let commandCount = 0;
    const fakeSocket = {
      addEventListener(type, listener) {
        if (type === 'message') receiveMessage = listener;
      },
      send(frame) {
        const { id } = JSON.parse(frame);
        commandCount += 1;
        queueMicrotask(() => receiveMessage({ data: JSON.stringify(commandCount === 1
          ? { id, error: { code: -32000, message: 'Target closed' } }
          : { id, result: { result: { value: true } } }) }));
      },
    };
    const protocolSend = createSender(fakeSocket, new Map(), () => 1, 15_000, { max: 0 }, new Set());
    const protocolEvaluate = createEvaluator(protocolSend);
    const protocolWait = createWaiter(protocolEvaluate, { commandTimeoutMs: 5_000 });
    const noNavigation = await protocolWait('true', 5_000, 'no-navigation protocol error' /* budget: declared 5000ms protocol-operation ceiling; fixture reply is immediate. */)
      .then(() => ({ rejected: false }), error => ({ rejected: true, error }));
    assert.equal(noNavigation.rejected, true, 'a no-navigation protocol error is rethrown immediately'); // budget: checks the immediate result against the declared command ceiling.
    assert.equal(noNavigation.error.code, -32000, 'the original CDP code is preserved'); // budget: verifies the error returned within the declared command ceiling.
    assert.equal(noNavigation.error.navigated, false, 'the sender observed no main-frame navigation'); // budget: verifies the error returned within the declared command ceiling.
    assert.match(noNavigation.error.message, /page navigated since command was sent: no/u); // budget: verifies preserved protocol diagnostics within the declared command ceiling.
    assert.equal(commandCount, 1, 'the wait does not retry a no-navigation CDP error');

    let clock = 0;
    let evaluations = 0;
    let pauses = 0;
    let firstError;
    const deadlineWait = createWaiter(async () => {
      evaluations += 1;
      if (evaluations === 1) {
        firstError = Object.assign(new Error('DevTools command failed: Runtime.evaluate; CDP error -32000; page navigated since command was sent: yes'), {
          code: -32000,
          navigated: true,
        });
        throw firstError;
      }
      return false;
    }, {
      commandTimeoutMs: 5_000,
      now: () => clock,
      pauseFor: async ms => {
        pauses += 1;
        assert.ok(pauses <= 100, 'the injected clock advances within the declared deadline');
        clock += ms;
      },
    });
    await assert.rejects(deadlineWait('false', 5_000, 'simulated navigation deadline'), error => { // budget: declared 5000ms simulated operation deadline, advanced deterministically; no wall-clock judgment.
      assert.match(error.message, /did not arrive within 5000ms/u);
      assert.match(error.message, /last evaluation failed: DevTools command failed: Runtime\.evaluate/u);
      assert.match(error.message, /CDP error -32000/u);
      assert.match(error.message, /page navigated since command was sent: yes/u);
      return true;
    });
    assert.equal(clock, 5_000, 'the injected clock reaches the operation deadline exactly');
    assert.equal(evaluations, 100, 'the wait polls only while time remains');
    assert.equal(pauses, 100, 'each poll advances the injected clock by its bounded interval');
    assert.ok(firstError instanceof Error, 'the simulated first navigation error is retained');
  } finally {
    await chrome.close();
  }
});
