/** Lane-release capture helpers for real-Chrome cockpit press checks [N26,C7]. */

/** Attach the bounded capture to the original shared-press error and return its TAP diagnostic line. */
export function includeLaneReleaseCapture(error, detail) {
  const diagnostic = 'lane-release capture: ' + JSON.stringify(detail);
  error.message += '; ' + diagnostic;
  return diagnostic;
}

/** Observe page boxes and native scroll events around the lane-release press without changing the action. */
export async function armLaneReleaseCapture(chrome, selector, stableRoot = "document.querySelector('#lanes')") {
  const trace = { events: [], matching: 0, dropped: 0, complete: false, startError: null, endError: null };
  /** Settles when Chrome reports Tracing.tracingComplete, so cleanup waits on the event instead of polling. */
  trace.completed = new Promise(resolve => { trace.markComplete = resolve; });
  const traceLimit = 24;
  const traceByteLimit = 10_000;
  let traceBytes = 0;
  const safeTraceValue = (value, depth = 0) => {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      return typeof value === 'string' ? value.slice(0, 140) : value;
    }
    if (depth >= 2) return '[nested]';
    if (Array.isArray(value)) return value.slice(0, 4).map(item => safeTraceValue(item, depth + 1));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([key]) => ['type', 'value', 'description', 'delta'].includes(key))
        .slice(0, 4).map(([key, item]) => [key, safeTraceValue(item, depth + 1)]));
    }
    return String(value).slice(0, 80);
  };
  const onTraceMessage = ({ data }) => {
    let message;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (message.method === 'Tracing.tracingComplete') { trace.complete = true; trace.markComplete(); }
    if (message.method !== 'Tracing.dataCollected') return;
    for (const event of message.params?.value ?? []) {
      if (!['FindAnchor', 'ComputeAdjustment'].includes(event.name)) continue;
      trace.matching++;
      const args = Object.fromEntries(Object.entries(event.args ?? {}).filter(([key]) => ['anchor_object_', 'delta'].includes(key))
        .map(([key, value]) => [key, safeTraceValue(value)]));
      const retained = { name: event.name, ts: event.ts ?? null, cat: String(event.cat ?? '').slice(0, 100), ph: event.ph ?? null, args };
      const bytes = Buffer.byteLength(JSON.stringify(retained), 'utf8');
      if (trace.events.length >= traceLimit || traceBytes + bytes > traceByteLimit) { trace.dropped++; continue; }
      trace.events.push(retained); traceBytes += bytes;
    }
  };
  chrome.socket.addEventListener('message', onTraceMessage);
  let traceStarted = false;
  try {
    await chrome.send('Tracing.start', { categories: 'disabled-by-default-blink.debug', transferMode: 'ReportEvents' });
    traceStarted = true;
  } catch (error) { trace.startError = String(error.message || error).slice(0, 240); }
  let pageArm;
  try {
    pageArm = JSON.parse(await chrome.stable(`JSON.stringify((() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return { armed: false };
    const identities = new WeakMap(), prior = new Map(), baseline = new Map(), retained = new Map(), changes = new Map(), events = [], scrollCalls = [];
    const dropped = { nodeLimit: 0, changedNodeLimit: 0, eventLimit: 0, scrollCallLimit: 0, frameLimit: 0 };
    let nextId = 0, frames = 0, stopped = false, animation = null;
    /** Name nodes without collecting board text, URLs or session capabilities. */
    const name = node => {
      if (!(node instanceof Element)) return null;
      if (!identities.has(node)) identities.set(node, ++nextId);
      return { node: identities.get(node), tag: node.tagName.toLowerCase(), id: node.id.slice(0, 80),
        className: typeof node.className === 'string' ? node.className.slice(0, 120) : '' };
    };
    /** Measure document and viewport coordinates separately to distinguish scrolling from layout movement. */
    const box = node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      const visible = !node.closest('[hidden]') && style.display !== 'none' && style.visibility !== 'hidden'
        && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
      return { ...name(node), top: rect.top, documentTop: rect.top + scrollY, height: rect.height,
        width: rect.width, hidden: !!node.closest('[hidden]'), visible, overflowAnchor: style.overflowAnchor,
        position: style.position, connected: node.isConnected };
    };
    const aimedTarget = target, aimedTargetBox = box(target);
    let removedTargetRecorded = false;
    /** Retain bounded observations, reporting truncation instead of treating missing rows as evidence. */
    const append = (list, row, cap, reason) => { if (list.length < cap) list.push(row); else dropped[reason]++; };
    /** Keep one bounded history per node so early low-priority motion cannot evict later resizes. */
    const recordChange = (type, old, now) => {
      old = baseline.get(now.node) ?? old;
      let entry = changes.get(now.node);
      if (!entry) {
        if (changes.size >= 2000) { dropped.changedNodeLimit++; return; }
        entry = { node: { node: now.node, tag: now.tag, id: now.id, className: now.className }, firstAt: performance.now(),
          lastAt: performance.now(), first: old, last: now, minHeight: Math.min(old?.height ?? now.height, now.height),
          maxHeight: Math.max(old?.height ?? now.height, now.height),
          minDocumentTop: Math.min(old?.documentTop ?? now.documentTop, now.documentTop),
          maxDocumentTop: Math.max(old?.documentTop ?? now.documentTop, now.documentTop), transitions: 1, types: [type] };
        changes.set(now.node, entry);
        return;
      }
      if (!entry.first && old) { entry.first = old; entry.firstAt = performance.now(); }
      entry.lastAt = performance.now();
      entry.last = now;
      entry.minHeight = Math.min(entry.minHeight, old?.height ?? now.height, now.height);
      entry.maxHeight = Math.max(entry.maxHeight, old?.height ?? now.height, now.height);
      entry.minDocumentTop = Math.min(entry.minDocumentTop, old?.documentTop ?? now.documentTop, now.documentTop);
      entry.maxDocumentTop = Math.max(entry.maxDocumentTop, old?.documentTop ?? now.documentTop, now.documentTop);
      entry.transitions++;
      if (!entry.types.includes(type)) entry.types.push(type);
    };
    /** Compare only the bounded aim-time set, even if its boxes later move below the target. */
    const sample = (type, point = null) => {
      const target = document.querySelector(${JSON.stringify(selector)}), targetBox = target ? box(target) : null;
      if (!aimedTarget.isConnected && !removedTargetRecorded) {
        recordChange(type, aimedTargetBox, { ...aimedTargetBox, connected: false, height: 0, width: 0 });
        removedTargetRecorded = true;
      }
      for (const node of retained.values()) {
        const now = box(node), old = prior.get(now.node);
        if (old && (old.connected !== now.connected || old.height !== now.height || old.documentTop !== now.documentTop
          || old.hidden !== now.hidden || old.visible !== now.visible)) {
          recordChange(type, old, now);
        }
        if (!old) recordChange(type, null, now);
        prior.set(now.node, now);
      }
      for (const [id, node] of retained) {
        const old = prior.get(id);
        if (!node.isConnected && old.connected) {
          const now = { ...old, connected: false, height: 0, width: 0 };
          recordChange(type, old, now); prior.set(id, now);
        }
      }
      append(events, { type, at: performance.now(), scrollX, scrollY, target: targetBox,
        point, activeElement: name(document.activeElement) }, 160, 'eventLimit');
    };
    // Freeze eligibility at aim: DOM-earlier boxes below cannot evict an above-target zero-height box.
    const targetTop = target.getBoundingClientRect().top;
    const initialNodes = [...document.body.querySelectorAll('*')].filter(node => {
      if (node === target || node.contains(target)) return false;
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return node.getClientRects().length > 0 && !node.closest('[hidden]') && style.visibility !== 'hidden'
        && (rect.top < targetTop || (rect.height === 0 && rect.top === targetTop));
    });
    dropped.nodeLimit = Math.max(0, initialNodes.length - 2000);
    const initial = initialNodes.slice(0, 2000).map(node => {
      const entry = box(node);
      baseline.set(entry.node, entry); prior.set(entry.node, entry); retained.set(entry.node, node);
      return entry;
    });
    /** Observe native pointer boundaries before the shared press rechecks its aimed point. */
    const listener = event => sample(event.type, Number.isFinite(event.clientX)
      ? { x: event.clientX, y: event.clientY, target: name(event.target) } : null);
    for (const type of ['pointermove', 'pointerdown', 'mousedown', 'click']) document.addEventListener(type, listener, true);
    window.addEventListener('scroll', listener, true);
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    /** Record the shared helper's real scroll request while preserving its native arguments and return value. */
    Element.prototype.scrollIntoView = function(...args) {
      const call = { at: performance.now(), method: 'scrollIntoView', target: name(this), scrollYBefore: scrollY };
      const result = Reflect.apply(originalScrollIntoView, this, args);
      call.scrollYAfter = scrollY;
      append(scrollCalls, call, 40, 'scrollCallLimit');
      return result;
    };
    /** Sample layout changes per animation frame without scheduling any extra production work. */
    const tick = () => {
      if (stopped) return;
      if (++frames > 120) { dropped.frameLimit++; return; }
      sample('frame'); animation = requestAnimationFrame(tick);
    };
    sample('armed'); animation = requestAnimationFrame(tick);
    window.__laneReleaseCapture = {
      /** Disconnect all observers and restore the native method even when the original press refused to click. */
      finish() {
        stopped = true;
        try {
          sample('finish');
        } finally {
          cancelAnimationFrame(animation);
          for (const type of ['pointermove', 'pointerdown', 'mousedown', 'click']) document.removeEventListener(type, listener, true);
          window.removeEventListener('scroll', listener, true);
          Element.prototype.scrollIntoView = originalScrollIntoView;
          delete window.__laneReleaseCapture;
        }
        /** Keep only the named box fields needed to compare layout before and after the press. */
        const summarizeBox = value => value && ({ node: value.node, tag: value.tag, id: value.id,
          className: value.className, top: value.top, documentTop: value.documentTop, height: value.height,
          hidden: value.hidden, visible: value.visible, connected: value.connected, position: value.position });
        const changed = [...changes.values()].map(raw => {
          const entry = { ...raw, first: summarizeBox(raw.first), last: summarizeBox(raw.last), lastPosition: raw.last.position };
          const final = entry.last;
          const first = entry.first;
          const heightChanged = entry.minHeight !== entry.maxHeight;
          const connectionOrVisibilityChanged = first !== null && (first.connected !== final.connected || first.visible !== final.visible);
          const visibleFlowMoved = first !== null && first.connected && final.connected && first.visible && final.visible
            && !['fixed', 'sticky'].includes(entry.lastPosition) && first.documentTop !== final.documentTop;
          const priority = connectionOrVisibilityChanged ? 0 : heightChanged ? 1 : visibleFlowMoved ? 2 : 3;
          return { ...entry, priority, heightChanged, connectionOrVisibilityChanged, visibleFlowMoved };
        }).sort((a, b) => a.priority - b.priority || a.firstAt - b.firstAt);
        const keyEvents = events.filter(event => event.type !== 'frame').map(event => ({
          type: event.type, at: event.at, scrollX: event.scrollX, scrollY: event.scrollY,
          target: summarizeBox(event.target), point: event.point,
          activeElement: event.activeElement && ({ tag: event.activeElement.tag, id: event.activeElement.id,
            className: event.activeElement.className })
        }));
        return { armed: true, observedNodes: initial.length, changedNodes: changed.slice(0, 10).map(({ priority, heightChanged,
          connectionOrVisibilityChanged, visibleFlowMoved, ...entry }) => ({ ...entry, priority, heightChanged,
          connectionOrVisibilityChanged, visibleFlowMoved })),
          eventSamples: keyEvents.slice(0, 16), scrollCalls: scrollCalls.slice(0, 8), frames,
          scrollY: { before: scrollCalls[0]?.scrollYAfter ?? events[0]?.scrollY ?? null, after: scrollY },
          changeCounts: { collected: changed.length, heightChanged: changed.filter(entry => entry.heightChanged).length,
            connectionOrVisibilityChanged: changed.filter(entry => entry.connectionOrVisibilityChanged).length,
            visibleFlowMoved: changed.filter(entry => entry.visibleFlowMoved).length },
          truncated: { droppedByReason: dropped, remainingChangedNodes: Math.max(0, changed.length - 10),
            eventSamples: Math.max(0, keyEvents.length - 16), scrollCalls: Math.max(0, scrollCalls.length - 8) },
          scrollAnchoring: { selectedNode: null, status: 'The browser-selected anchor is not captured by this probe; geometry alone does not identify it.' },
          rootCauseStatus: 'NOT PROVEN' };
      }
    };
    return { armed: true, observed: initial.length };
  })())`, stableRoot));
  } catch (error) {
    pageArm = { armed: false, error: String(error.message || error).slice(0, 240) };
  }
  return { ...pageArm, trace, traceStarted, onTraceMessage, stableRoot };
}

/** Finish lane-release observations through the stable root after either a successful or refused press. */
export async function finishLaneReleaseCapture(chrome, capture) {
  if (capture?.traceStarted) {
    try {
      await chrome.send('Tracing.end');
      /** Budget: bounded wait for the trace-complete event after Tracing.end, not a browser timing assertion. */
      const bound = AbortSignal.timeout(2000);
      await Promise.race([capture.trace.completed, new Promise(resolve => bound.addEventListener('abort', resolve, { once: true }))]);
      if (!capture.trace.complete) capture.trace.endError = 'Tracing.tracingComplete was not observed within the cleanup bound';
    } catch (error) { capture.trace.endError = String(error.message || error).slice(0, 240); }
  }
  if (capture?.onTraceMessage) chrome.socket.removeEventListener('message', capture.onTraceMessage);
  let page = null, pageError = null;
  try { page = JSON.parse(await chrome.stable('JSON.stringify(window.__laneReleaseCapture?.finish() || null)', capture?.stableRoot ?? "document.querySelector('#lanes')")); }
  catch (error) { pageError = String(error.message || error).slice(0, 240); }
  return { page, pageError, tracing: capture ? { events: capture.trace.events, matching: capture.trace.matching,
    dropped: capture.trace.dropped, complete: capture.trace.complete, started: capture.traceStarted,
    startError: capture.trace.startError, endError: capture.trace.endError } : null };
}

