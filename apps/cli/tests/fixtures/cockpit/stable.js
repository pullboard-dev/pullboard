/** One real-Chrome measurement and pointer boundary for all cockpit stories [N26,C7]. */
import assert from 'node:assert/strict';

const clients = new WeakMap();
const waitCaptures = new WeakMap();

/** Evaluate only inside the shared boundary; tests receive no raw page evaluator. */
async function rawChromeEvaluation(chrome, expression) {
  const result = await clients.get(chrome).send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

/**
 * Wait for the visible page and each required target to exist with nonzero boxes unchanged over two frames.
 * Sampling descendants includes SVG progress bars and Range containers, not just the control's outer box.
 * The deadline only bounds a missing or perpetually moving target; it is not a rendering speed assertion.
 */
export async function waitForStableBoxes(chrome, find = 'document.documentElement', timeoutMs = 10_000) {
  const result = await rawChromeEvaluation(chrome, `(async () => {
    /** Resolve targets afresh because a board refresh can replace a matching node. */
    const targets = () => { const found = (${find}); return found instanceof Element ? [found] : Array.from(found || []); };
    /** Retain rendered boxes while ignoring deliberate hidden-pane visibility probes. */
    const visible = element => { const style = getComputedStyle(element), box = element.getBoundingClientRect(); return !element.closest('[hidden]') && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0; };
    /** Compare exact layout geometry without tolerances that hide movement. */
    const box = element => { const rect = element.getBoundingClientRect(); return [rect.x, rect.y, rect.width, rect.height]; };
    let lastSeen = 'no frame sampled';
    const started = performance.now(), samples = [];
    let frames = 0, previousAt = started, maxFrameGapMs = 0, priorSample = null;
    let priorTexts = [], priorScroll = null;
    const changes = { target: 0, replacement: 0, text: 0, scroll: 0, page: 0 };
    let requiredNodes = [], pageNodes = [], priorRequired = [], priorPageNodes = [];
    /** Name only geometry-bearing nodes, without copying page text or private attributes. */
    const name = element => element ? (element.tagName.toLowerCase() + (element.id ? '#' + element.id : '')).slice(0, 120) : null;
    /** Capture document readiness without addresses, board contents, or session keys. */
    const pageState = () => ({ readyState: document.readyState,
      loading: !!document.body?.classList.contains('loading'), switching: !!document.body?.classList.contains('switching') });
    /** Return only the bounded tail, counters, and timing observations. */
    const capture = () => ({ elapsedMs: Math.round(performance.now() - started), frames,
      maxFrameGapMs: Math.round(maxFrameGapMs), changes, page: pageState(), samples });
    /** Retain a bounded tail that separates target changes from unrelated page geometry. */
    const record = (current, frame, sampleStarted) => {
      const at = performance.now(), gapMs = at - previousAt;
      if (frame) { frames++; maxFrameGapMs = Math.max(maxFrameGapMs, gapMs); }
      let pageChange = null;
      if (current && priorSample) {
        const before = priorSample.page, after = current.page;
        let index;
        for (let i = 0; i < Math.max(before.length, after.length); i++) {
          const left = before[i], right = after[i];
          const same = Array.isArray(left) && Array.isArray(right)
            ? left.length === right.length && left.every((value, n) => value === right[n]) : left === right;
          if (!same) { index = i; break; }
        }
        if (index !== undefined) pageChange = {
          index, before: before[index] ?? null, after: after[index] ?? null,
          beforeNode: index >= 5 ? name(priorPageNodes[index - 5]) : null,
          afterNode: index >= 5 ? name(pageNodes[index - 5]) : null,
        };
      }
      const texts = requiredNodes.slice(0, 4).map(node => node instanceof Element ? node.textContent : null);
      const targetChanged = current && priorSample ? JSON.stringify(current.targets) !== JSON.stringify(priorSample.targets) : null;
      const targetReplaced = requiredNodes.some((node, i) => priorRequired[i] && node !== priorRequired[i]);
      const textChanged = texts.some((text, i) => i < priorTexts.length && text !== priorTexts[i]);
      const scroll = [scrollX, scrollY], scrolled = !!priorScroll && scroll.some((value, i) => value !== priorScroll[i]);
      if (targetChanged) changes.target++;
      if (targetReplaced) changes.replacement++;
      if (textChanged) changes.text++;
      if (scrolled) changes.scroll++;
      if (pageChange) changes.page++;
      samples.push({ atMs: Math.round(at - started), gapMs: Math.round(gapMs), sampleMs: Math.round(at - sampleStarted), frame,
        targets: current?.targets.slice(0, 4) ?? null,
        targetChanged, targetReplaced, textChanged, scrolled, pageChange, scroll, page: pageState(), error: current ? null : lastSeen.slice(0, 300),
      });
      if (samples.length > 4) samples.shift();
      previousAt = at; priorSample = current; priorRequired = requiredNodes; priorPageNodes = pageNodes;
      priorTexts = texts; priorScroll = scroll;
    };
    /** Capture required targets, descendants and page extents in one layout sample. */
    const sample = () => {
      requiredNodes = []; pageNodes = [];
      const required = targets();
      requiredNodes = required;
      lastSeen = required.length ? JSON.stringify(required.map(element => element instanceof Element
        ? { tag: element.tagName, id: element.id, connected: element.isConnected, hidden: !!element.closest('[hidden]'), box: box(element) }
        : { target: String(element) })) : 'no matching target';
      if (!required.length || !required.every(element => element instanceof Element && element.isConnected && visible(element))) return null;
      const elements = [...document.querySelectorAll('body, body *')].filter(visible);
      pageNodes = elements;
      return { targets: required.map(box), page: [scrollX, scrollY, document.documentElement.clientWidth, document.documentElement.scrollWidth, document.documentElement.scrollHeight, ...elements.map(box)] };
    };
    return await new Promise((resolve, reject) => {
      let previous = '', unchanged = 0, frameId = 0;
      const timer = setTimeout(() => { cancelAnimationFrame(frameId); reject(Error('shared wait: target missing, zero-sized or moving: ' + ${JSON.stringify(find)} + '; last saw ' + lastSeen + '; wait capture ' + JSON.stringify(capture()))); }, ${timeoutMs});
      /** Resolve only after two complete frame intervals have unchanged nonzero geometry. */
      const frame = () => {
        const sampleStarted = performance.now();
        let current;
        try { current = sample(); } catch (error) { current = null; lastSeen = error.name + ': ' + error.message; }
        record(current, true, sampleStarted);
        const signature = current ? JSON.stringify(current) : '';
        unchanged = signature && signature === previous ? unchanged + 1 : 0;
        previous = signature;
        if (unchanged >= 2) { clearTimeout(timer); resolve({ targets: current.targets, capture: capture() }); return; }
        frameId = requestAnimationFrame(frame);
      };
      // Sample synchronously before yielding so even an expired short timer has a real diagnostic.
      const sampleStarted = performance.now();
      try { record(sample(), false, sampleStarted); } catch (error) { lastSeen = error.name + ': ' + error.message; record(null, false, sampleStarted); }
      frameId = requestAnimationFrame(frame);
    });
  })()`);
  waitCaptures.set(chrome, { observedAt: Date.now(), ...result.capture });
  assert.ok(Array.isArray(result.targets) && result.targets.length > 0, `shared wait finds a rendered target: ${find}`);
  return result.targets;
}

/**
 * Press an uncovered, stable target through real Chrome input, optionally using a browser button or modifier.
 * A pointer move can change hover layout, so wait again after it and refuse a changed point rather than retrying.
 * Fixed dialog targets use viewport geometry; flowing targets retain the document-scroll guard as well.
 * @param {object} chrome
 * @param {string} find
 * @param {{ native?: boolean, button?: string, modifiers?: number, afterMouseDown?: () => Promise<void> }} [options] - Optionally observe work while the real pointer remains held.
 * @returns {Promise<void>}
 */
export async function press(chrome, find, { native = true, button = 'left', modifiers = 0, afterMouseDown = null } = {}) {
  await waitForStableBoxes(chrome, find);
  if (!native) return rawChromeEvaluation(chrome, `(${find}).click()`);
  await rawChromeEvaluation(chrome, `(${find}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await waitForStableBoxes(chrome, find);
  const pointExpression = `(() => {
    const element = (${find}), rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!rect.width || !rect.height || !hit || (hit !== element && !element.contains(hit))) throw Error('shared press: target is hidden or covered: ' + ${JSON.stringify(find)});
    let viewportFixed = false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).position === 'fixed') { viewportFixed = true; break; }
    }
    return { x, y, width: rect.width, height: rect.height, ...(viewportFixed ? {} : { scrollX, scrollY }) };
  })()`;
  const point = await rawChromeEvaluation(chrome, pointExpression);
  const raw = clients.get(chrome);
  await raw.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await waitForStableBoxes(chrome, find);
  const underPointer = await rawChromeEvaluation(chrome, pointExpression);
  assert.deepEqual(underPointer, point, `shared press: target stays under the pointer: ${find}`);
  await rawChromeEvaluation(chrome, `(() => {
    const element = (${find});
    const name = node => node ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '') : 'nothing';
    window.__pressed = { meant: name(element), at: ${Math.round(point.y)}, scrollY: Math.round(scrollY) };
    document.addEventListener('mousedown', event => Object.assign(window.__pressed, { landed: name(event.target), landedAt: Math.round(event.clientY), scrolledTo: Math.round(scrollY) }), { capture: true, once: true });
  })()`);
  await raw.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, clickCount: 1, modifiers });
  try {
    if (afterMouseDown) await afterMouseDown();
  } finally {
    await raw.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, clickCount: 1, modifiers });
  }
}

/** Tap a stable visible target with Chrome's real touch input path, so touch interactions are not simulated clicks. */
export async function tapTouch(chrome, find) {
  await waitForStableBoxes(chrome, find);
  await rawChromeEvaluation(chrome, `(${find}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await waitForStableBoxes(chrome, find);
  const point = await rawChromeEvaluation(chrome, `(() => {
    const element = (${find}), rect = element.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!rect.width || !rect.height || !hit || (hit !== element && !element.contains(hit))) throw Error('shared touch: target is hidden or covered: ' + ${JSON.stringify(find)});
    return { x, y };
  })()`);
  const raw = clients.get(chrome);
  const touchPoint = { ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 };
  await raw.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await raw.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * Expose only waited page expressions. Every media override retains reduced motion, including the external
 * relay browser's pages. Polling observes readiness; it never retries a click or reruns an assertion.
 */
export async function stableChrome(raw) {
  const { evaluate: unusedEvaluate, waitFor: unusedWait, ...chrome } = raw;
  clients.set(chrome, raw);
  /** Send non-measuring protocol commands and retain reduced motion across colour-scheme changes. */
  chrome.send = async (method, params = {}) => {
    if (/^(?:Runtime\.(?:evaluate|callFunctionOn)|DOM\.(?:getBoxModel|getContentQuads)|Page\.getLayoutMetrics|Input\.dispatch(?:Mouse|Touch)Event)$/.test(method)) {
      throw new Error(`Use the shared stable wait or press instead of ${method}`);
    }
    if (method === 'Emulation.setEmulatedMedia') params = { ...params, features: [
      ...(params.features ?? []).filter(feature => feature.name !== 'prefers-reduced-motion'),
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ] };
    return raw.send(method, params);
  };
  /** Deliver a DOM click only after its actual target has a stable, nonzero box. */
  chrome.click = find => press(chrome, find, { native: false });
  /** Run one expression after the visible page and its explicit targets have stopped moving. */
  chrome.stable = async (expression, find = 'document.documentElement') => {
    await waitForStableBoxes(chrome, find);
    return rawChromeEvaluation(chrome, expression);
  };
  /** Poll readiness through the same measurement boundary, with the last page error on a bounded failure. */
  chrome.waitFor = async (expression, timeoutMs = 10_000) => {
    // budget: a bounded readiness wait fails a missing page, not a rendering speed requirement.
    const started = Date.now(), deadline = started + timeoutMs;
    let lastError = '', polls = 0, falseResults = 0, lastPollMs = 0, maxPollMs = 0;
    while (Date.now() < deadline) {
      const pollStarted = Date.now();
      polls++;
      try {
        if (await chrome.stable(expression)) return;
        falseResults++;
      } catch (error) { lastError = error.message; }
      lastPollMs = Date.now() - pollStarted;
      maxPollMs = Math.max(maxPollMs, lastPollMs);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Browser condition did not arrive: ${expression}${lastError ? `; it last threw: ${lastError}` : ''}; readiness capture ${JSON.stringify({ elapsedMs: Date.now() - started, polls, falseResults, lastPollMs, maxPollMs, lastStable: waitCaptures.get(chrome) ?? null })}`);
  };
  await chrome.send('Emulation.setEmulatedMedia', { features: [] });
  return chrome;
}

/** Assert the stress run delayed the real first board-state fetch, rather than merely delaying a test. */
export async function assertFirstStateDelay(chrome, t) {
  const expected = Number(process.env.PULLBOARD_CHROME_FIRST_STATE_DELAY_MS ?? 0);
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 30_000) return;
  await chrome.waitFor('window.__pullboardFirstStateDelay?.ended !== null && !!window.__pullboardFirstStateDelay');
  const elapsed = await chrome.stable('window.__pullboardFirstStateDelay.ended - window.__pullboardFirstStateDelay.started');
  t.diagnostic(`first board-state request delayed ${Math.round(elapsed)}ms (requested ${expected}ms)`);
  // budget: declared first-state fetch delay is the opt-in stress input, not an operation speed limit.
  assert.ok(elapsed >= expected, `first board-state request waits at least ${expected}ms: ${elapsed}`);
}

/** Stage real chip clones and retain their node identities to diagnose a redraw between browser evaluations. */
export async function stageNaturalSpecChips(chrome) {
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const root = document.querySelector('#spec-chips');
    if (!root) return { buttonCount: 0, cloneCount: 0 };
    root.querySelectorAll('[data-natural-chip]').forEach(clone => clone.remove());
    const buttons = [...root.querySelectorAll('button:not([data-natural-chip])')];
    const clones = buttons.map(button => {
      const clone = button.cloneNode(true);
      clone.dataset.naturalChip = '';
      clone.style.cssText += ';position:fixed;left:-10000px;opacity:0;width:max-content;flex:none';
      button.parentElement.append(clone);
      return clone;
    });
    window.__specChipStage = { buttons, clones };
    return { buttonCount: buttons.length, cloneCount: clones.length };
  })())`));
}

/** Clone, measure and remove natural-size chips in one page evaluation, so a render cannot split the sample. */
export async function measureNaturalSpecChips(chrome, beforeMeasure = null) {
  if (beforeMeasure) await beforeMeasure();
  return JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const root = document.querySelector('#spec-chips');
    if (!root) return { buttonCount: 0, cloneCount: 0, chips: [] };
    const buttons = [...root.querySelectorAll('button:not([data-natural-chip])')];
    root.querySelectorAll('[data-natural-chip]').forEach(clone => clone.remove());
    const clones = buttons.map(button => {
      const clone = button.cloneNode(true);
      clone.dataset.naturalChip = '';
      clone.style.cssText += ';position:fixed;left:-10000px;opacity:0;width:max-content;flex:none';
      button.parentElement.append(clone);
      return clone;
    });
    const chips = buttons.map((button, index) => ({
      text: button.textContent.trim(),
      actualWidth: button.getBoundingClientRect().width,
      naturalWidth: clones[index].getBoundingClientRect().width,
    }));
    clones.forEach(clone => clone.remove());
    return { buttonCount: buttons.length, cloneCount: clones.length, chips };
  })())`, "document.querySelectorAll('#spec-chips button:not([data-natural-chip])')"));
}
