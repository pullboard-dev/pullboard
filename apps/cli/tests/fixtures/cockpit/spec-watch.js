/** Real-Chrome observers for the Spec cockpit press and filter checks [C7]. */

/** Observe a real Spec control's native pointer sequence and any replacement inside its detail card. */
export async function watchSpecPress(chrome, selector) {
  await chrome.stable(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)}), detail = document.querySelector('#spec-detail');
    if (!target || !detail) throw Error('Spec press observer target is missing: ' + ${JSON.stringify(selector)});
    const name = node => node ? { tag: node.tagName, id: node.id, decision: node.dataset.rowDecision || '', connected: node.isConnected } : null;
    const box = node => { const r = node?.getBoundingClientRect(); return r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null; };
    const originalRender = window.render;
    if (typeof originalRender !== 'function') throw Error('Spec press observer cannot instrument the real render function');
    const trace = window.__pullboardSpecPress = { selector:${JSON.stringify(selector)}, target, initial:box(target), events:[], childListRecords:0, renderAttempts:0, removedTarget:false, originalRender };
    window.render = function(...args) { trace.renderAttempts += 1; return originalRender.apply(this, args); };
    const types = ['mousedown', 'mouseup', 'click'];
    trace.listeners = types.map(type => {
      const listener = event => {
        const current = document.querySelector(trace.selector);
        trace.events.push({ type, at:performance.now(), target:name(event.target), intendedConnected:target.isConnected,
          intendedBox:box(target), currentSame:current === target, currentBox:box(current), hit:name(document.elementFromPoint(event.clientX, event.clientY)),
          renderAttempts:trace.renderAttempts, childListRecords:trace.childListRecords, dialogHidden:document.querySelector('#spec-decline-dialog').hidden,
          selected:view.row.spec, path:location.pathname, x:event.clientX, y:event.clientY });
      };
      document.addEventListener(type, listener, true);
      return [type, listener];
    });
    trace.observer = new MutationObserver(records => {
      trace.childListRecords += records.length;
      trace.removedTarget ||= records.some(record => [...record.removedNodes].some(node => node === target || node.contains?.(target)));
    });
    trace.observer.observe(document.body, { childList:true, subtree:true });
  })()`);
  return {
    /** Capture original/current identity, event targets and selected state without changing the page. */
    async snapshot() {
      return JSON.parse(await chrome.stable(`JSON.stringify((() => {
        const trace = window.__pullboardSpecPress, current = document.querySelector(trace.selector);
        const box = node => { const r = node?.getBoundingClientRect(); return r ? { x:r.x, y:r.y, width:r.width, height:r.height } : null; };
        return { width:innerWidth, path:location.pathname, selected:view.row.spec, dialogHidden:document.querySelector('#spec-decline-dialog').hidden,
          originalConnected:trace.target.isConnected, originalBox:box(trace.target), currentSame:current === trace.target, currentBox:box(current),
          childListRecords:trace.childListRecords, renderAttempts:trace.renderAttempts, removedTarget:trace.removedTarget, events:trace.events };
      })())`));
    },
    /** Disconnect only the observers installed for this trace. */
    async dispose() {
      await chrome.stable(`(() => { const trace=window.__pullboardSpecPress; if (!trace) return; trace.observer.disconnect(); for (const [type, listener] of trace.listeners) document.removeEventListener(type, listener, true); window.render=trace.originalRender; delete window.__pullboardSpecPress; })()`);
    },
  };
}

/** Record real filter input and completed Spec renders so a stale row read can name its render provenance. */
export async function watchSpecFilter(chrome) {
  await chrome.stable(`(() => {
    const originalRender = window.render;
    if (typeof originalRender !== 'function') throw Error('Spec filter observer cannot instrument the real render function');
    const trace = window.__specFilterTrace = { originalRender, renderCount:0, renderAttemptCount:0, lastRow:null, lastRenderId:null, events:[], attempts:[], renders:[], listeners:[], captureErrors:[] };
    /** Read source state and the row DOM immediately after a completed render. */
    const state = () => {
      const row = document.querySelector('#spec-list [data-row="spec:G1"]');
      const chip = row?.querySelector(':scope > .chip');
      const filter = typeof view === 'object' ? view.rows?.spec ?? null : null;
      const source = typeof data === 'object' ? data.project?.spec?.find(entry => entry.id === 'G1') : null;
      return { readAt:performance.now(), filter, sourceDataStatus:source?.status ?? null, rowStatus:chip?.textContent.trim() ?? null, row };
    };
    /** Keep diagnostic failures from changing the original page action or renderer result. */
    const recordError = error => {
      try { trace.captureErrors.push(String(error?.stack || error)); if (trace.captureErrors.length > 4) trace.captureErrors.shift(); }
      catch { /* Diagnostics never replace the original page behavior. */ }
    };
    /** Preserve the actual renderer while assigning an ordinal and post-render snapshot. */
    window.render = function(...args) {
      const result = originalRender.apply(this, args);
      try {
        const current = state();
        trace.renderAttemptCount += 1;
        if (typeof deferredClickRender !== 'undefined' && deferredClickRender) {
          trace.attempts.push({ at:current.readAt, deferred:true, filter:current.filter, sourceDataStatus:current.sourceDataStatus, rowStatus:current.rowStatus });
          if (trace.attempts.length > 8) trace.attempts.shift();
        } else {
          trace.renderCount += 1;
          trace.lastRow = current.row;
          trace.lastRenderId = trace.renderCount;
          trace.renders.push({ id:trace.renderCount, at:current.readAt, filter:current.filter, sourceDataStatus:current.sourceDataStatus, rowStatus:current.rowStatus });
          if (trace.renders.length > 8) trace.renders.shift();
        }
      } catch (error) { recordError(error); }
      return result;
    };
    /** Record the filter control and pre-handler state for the native pointer sequence. */
    const listen = type => {
      const listener = event => {
        const target = event.target.closest?.('[data-rows^="spec:"]');
        if (!target) return;
        try {
          const current = state();
          trace.events.push({ type, at:current.readAt, target:target.dataset.rows, filter:current.filter, sourceDataStatus:current.sourceDataStatus, rowStatus:current.rowStatus });
          if (trace.events.length > 8) trace.events.shift();
        } catch (error) { recordError(error); }
      };
      document.addEventListener(type, listener, true);
      trace.listeners.push([type, listener]);
    };
    for (const type of ['mousedown', 'mouseup', 'click']) listen(type);
  })()`);
  return {
    /** Restore only the renderer and pointer listeners installed for this measurement. */
    async dispose() {
      try {
        await chrome.stable(`(() => { const trace=window.__specFilterTrace; if (!trace) return; window.render=trace.originalRender; for (const [type, listener] of trace.listeners) document.removeEventListener(type, listener, true); delete window.__specFilterTrace; })()`);
        return null;
      } catch (error) { return String(error?.stack || error); }
    },
  };
}
