/* Blue Pencil - content script entry point.

   Tracks whichever editable field has focus, asks the service worker (and
   through it, Ollama) for edits when typing pauses, and drives the underlines
   and the sentence review card. */
(function () {
  'use strict';

  const BP = window.BP;
  if (!BP || window.__bluePencilLoaded) return;
  window.__bluePencilLoaded = true;

  const HOSTNAME = location.hostname || '';

  let settings = BP.mergeSettings(null);
  let ui = null;
  let active = null;
  let ticker = 0;
  let buttonSignature = '';
  let hoverTimer = 0;
  let hoveredId = null;
  let pendingRewrite = null;
  let extensionAlive = true;

  /* ------------------------------------------------------------ messaging */

  function send(message) {
    return new Promise(function (resolve) {
      if (!extensionAlive) return resolve({ error: { message: 'Blue Pencil was reloaded. Refresh this page.', code: 'context' } });
      try {
        chrome.runtime.sendMessage(message, function (response) {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            if (/context invalidated|Receiving end does not exist/i.test(lastError.message || '')) {
              extensionAlive = false;
            }
            return resolve({ error: { message: lastError.message, code: 'disconnected' } });
          }
          resolve(response || { error: { message: 'No response from Blue Pencil.', code: 'empty' } });
        });
      } catch (err) {
        extensionAlive = false;
        resolve({ error: { message: String(err && err.message || err), code: 'context' } });
      }
    });
  }

  /* -------------------------------------------------------------- helpers */

  function enabledHere() {
    return settings.enabled && !BP.siteDisabled(settings, HOSTNAME);
  }

  function activeCategoryList() {
    return Object.keys(settings.categories || {}).filter(function (key) {
      return settings.categories[key];
    });
  }

  function dismissKey(suggestion) {
    return suggestion.category + ' ' + suggestion.before + ' ' + suggestion.after;
  }

  function anchorRectFor(suggestion) {
    if (!active) return null;
    if (suggestion) {
      const rects = active.highlighter.rectsFor(suggestion.id);
      if (rects.length) {
        const first = rects[0];
        return {
          top: first.top, bottom: first.bottom,
          left: first.left, right: first.right,
          width: first.width, height: first.height
        };
      }
    }
    return ui ? ui.buttonRect() : null;
  }

  function currentSuggestion() {
    if (!active || !active.activeId) return null;
    return active.suggestions.find(function (s) { return s.id === active.activeId; }) || null;
  }

  /* ---------------------------------------------------------------- status */

  function refreshButton() {
    if (!ui) return;
    if (!active) {
      if (buttonSignature !== 'none') {
        buttonSignature = 'none';
        ui.setButton(null);
      }
      return;
    }

    const rect = active.adapter.el.getBoundingClientRect();
    const visible = settings.showButton &&
      rect.width > 4 && rect.height > 4 &&
      rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;

    const count = active.suggestions.length;
    const onlyImprovements = count > 0 && active.suggestions.every(function (s) {
      return BP.CORRECTION_CATEGORIES.indexOf(s.category) === -1;
    });

    let state = active.status;
    if (state === 'ready') state = count ? 'issues' : 'clean';

    const signature = [
      state, count, onlyImprovements ? 1 : 0, visible ? 1 : 0,
      Math.round(rect.top), Math.round(rect.left),
      Math.round(rect.width), Math.round(rect.height)
    ].join(':');
    if (signature === buttonSignature) return;
    buttonSignature = signature;

    ui.setButton({
      visible: visible,
      rect: rect,
      state: state,
      count: count,
      onlyImprovements: onlyImprovements,
      title: active.error ? active.error.message : ''
    });
  }

  function tick() {
    ticker = 0;
    if (!active) return;
    if (!active.adapter.el.isConnected) {
      teardown();
      return;
    }
    refreshButton();
    if (ui && ui.panelKind()) {
      const suggestion = currentSuggestion();
      ui.reposition(anchorRectFor(ui.panelKind() === 'suggestion' ? suggestion : null));
    }
    ticker = requestAnimationFrame(tick);
  }

  function startTicker() {
    if (!ticker) ticker = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------- checking */

  function clearSuggestions() {
    if (!active) return;
    active.suggestions = [];
    active.activeId = null;
    active.highlighter.clear();
    if (ui && ui.panelKind() === 'suggestion') ui.hidePanel();
  }

  /* Long documents: check a window around the caret rather than the whole
     text, so a big draft does not blow past the model's context. */
  function checkWindow(text, caret) {
    const max = Math.max(400, settings.maxChars || 6000);
    if (text.length <= max) return { text: text, offset: 0 };

    const anchorPoint = typeof caret === 'number' ? caret : text.length;
    let start = Math.max(0, Math.round(anchorPoint - max * 0.7));
    let end = Math.min(text.length, start + max);
    start = Math.max(0, end - max);

    if (start > 0) {
      const boundary = text.lastIndexOf('\n', start + 200);
      const space = text.indexOf(' ', start);
      const pick = boundary > start - 200 && boundary !== -1 ? boundary + 1 : (space !== -1 ? space + 1 : start);
      if (pick < end) start = pick;
    }
    return { text: text.slice(start, end), offset: start };
  }

  async function runCheck(options) {
    const opts = options || {};
    if (!active || !enabledHere() || !extensionAlive) return;
    if (active.composing) return;

    const adapter = active.adapter;
    const text = adapter.getText();
    const selection = adapter.getSelection();
    const caret = selection ? selection.end : text.length;

    if (!text.trim() || text.trim().length < (settings.minChars || 12)) {
      active.status = 'idle';
      active.error = null;
      active.lastCheckedText = text;
      clearSuggestions();
      refreshButton();
      return;
    }

    if (!opts.force && text === active.lastCheckedText) return;

    const slice = checkWindow(text, caret);
    const requestId = BP.util.hashString(text + ':' + Date.now());
    active.requestId = requestId;
    active.status = 'checking';
    active.error = null;
    refreshButton();

    const response = await send({ type: 'check', text: slice.text, requestId: requestId });

    if (!active || active.requestId !== requestId) return;

    if (response.error) {
      if (response.error.code === 'aborted') return;
      active.status = 'error';
      active.error = response.error;
      clearSuggestions();
      refreshButton();
      if (opts.showErrors) {
        ui.showMessage({
          title: 'Blue Pencil',
          tone: 'error',
          message: response.error.message,
          detail: response.error.detail ? BP.util.escapeHtml(response.error.detail) : '',
          retry: true
        }, ui.buttonRect());
      }
      return;
    }

    // The field may have changed while the model was thinking; re-anchor
    // everything against the text that is on screen right now.
    const currentText = adapter.getText();
    const allowed = activeCategoryList();
    const located = BP.util.locateEdits(currentText, (response.edits || []).map(function (edit) {
      return Object.assign({}, edit, { hint: slice.offset });
    }), { categories: allowed }).filter(function (suggestion) {
      if (active.dismissed.has(dismissKey(suggestion))) return false;
      return adapter.isEditableRange(suggestion.start, suggestion.end);
    });

    active.suggestions = located;
    active.lastCheckedText = currentText;
    active.status = 'ready';
    active.truncated = slice.text.length < currentText.length;

    const cardOpen = ui.panelKind() === 'suggestion';
    if (active.activeId && !located.some(function (s) { return s.id === active.activeId; })) {
      active.activeId = null;
      if (cardOpen) ui.hidePanel();
    }
    active.highlighter.update(located, active.activeId);
    refreshButton();

    // A card left open belongs to the text as it was; redraw it on the new run.
    if (cardOpen && active.activeId) showSentence(active.activeId, active.pinned);

    if (opts.reveal && located.length) {
      showSentence(located[0].id, true);
    } else if (opts.reveal) {
      ui.showMessage({
        title: 'Blue Pencil',
        message: 'No issues found in this text.'
      }, ui.buttonRect());
    }
  }

  let checkTimer = 0;

  function cancelCheck() {
    clearTimeout(checkTimer);
    checkTimer = 0;
  }

  /** Check once typing pauses, at the delay the user configured. */
  function rescheduleCheck() {
    cancelCheck();
    if (!settings.autoCheck) return;
    checkTimer = setTimeout(function () {
      runCheck({});
    }, Math.max(250, settings.checkDelayMs || 900));
  }

  /* ----------------------------------------------------------- suggestions */

  function suggestionById(id) {
    if (!active || !id) return null;
    return active.suggestions.find(function (s) { return s.id === id; }) || null;
  }

  /* Suggestions are reviewed a sentence at a time: the card shows the whole
     sentence with every proposed change in place, and each can be taken or
     left on its own. */
  function sentenceGroups() {
    if (!active || !active.suggestions.length) return [];
    return BP.util.groupBySentence(active.adapter.getText(), active.suggestions);
  }

  function groupIndexOf(groups, id) {
    for (let i = 0; i < groups.length; i++) {
      const hit = groups[i].items.some(function (s) { return s.id === id; });
      if (hit) return i;
    }
    return -1;
  }

  function currentGroup(groups) {
    const list = groups || sentenceGroups();
    const index = groupIndexOf(list, active ? active.activeId : null);
    return index === -1 ? null : list[index];
  }

  /** The change to fall back to once the one at `offset` is gone. */
  function nearestSuggestion(offset) {
    if (!active || !active.suggestions.length) return null;
    return active.suggestions.find(function (s) { return s.start >= offset; }) ||
      active.suggestions[active.suggestions.length - 1];
  }

  /** Open the card on the sentence holding `id`, focused on that change. */
  function showSentence(id, pinned) {
    if (!active || !ui) return;
    const groups = sentenceGroups();
    if (!groups.length) return;
    const index = Math.max(0, groupIndexOf(groups, id));
    const group = groups[index];
    const focused = group.items.find(function (s) { return s.id === id; }) || group.items[0];

    active.activeId = focused.id;
    active.pinned = Boolean(pinned);
    active.highlighter.setActive(focused.id);
    ui.showSentence({
      text: active.adapter.getText(),
      group: group,
      focusId: focused.id,
      index: index,
      total: groups.length
    }, anchorRectFor(focused));
  }

  function hideSuggestion() {
    if (!active || !ui) return;
    active.activeId = null;
    active.pinned = false;
    active.highlighter.setActive(null);
    ui.hidePanel();
  }

  /** Move to the previous or next sentence that has suggestions. */
  function navigate(delta) {
    if (!active) return;
    const groups = sentenceGroups();
    if (!groups.length) return;
    const index = Math.max(0, groupIndexOf(groups, active.activeId));
    const next = (index + delta + groups.length) % groups.length;
    showSentence(groups[next].items[0].id, true);
  }

  /** Re-find every remaining suggestion after the text changed underneath us. */
  function reanchorAll() {
    if (!active) return;
    const text = active.adapter.getText();
    const taken = [];
    const kept = [];
    active.suggestions.forEach(function (suggestion) {
      const hit = BP.util.anchor(text, suggestion.before, taken, suggestion.start);
      if (!hit) return;
      taken.push(hit);
      kept.push(Object.assign({}, suggestion, { start: hit.start, end: hit.end }));
    });
    kept.sort(function (a, b) { return a.start - b.start; });
    active.suggestions = kept;
    active.highlighter.update(kept, active.activeId);
  }

  function dropSuggestion(id) {
    if (!active) return;
    active.suggestions = active.suggestions.filter(function (s) { return s.id !== id; });
    if (active.activeId === id) active.activeId = null;
    active.highlighter.update(active.suggestions, active.activeId);
  }

  /* Put the text change into the field. Returns 'ok', 'missing' when the text
     it targeted is no longer there, or 'refused' when the editor said no. */
  function applyOne(id) {
    const suggestion = suggestionById(id);
    if (!suggestion) return 'missing';

    const text = active.adapter.getText();
    const hit = BP.util.anchor(text, suggestion.before, [], suggestion.start);
    if (!hit) {
      dropSuggestion(id);
      return 'missing';
    }
    if (!active.adapter.replaceRange(hit.start, hit.end, suggestion.after)) return 'refused';

    dropSuggestion(id);
    active.lastCheckedText = active.adapter.getText();
    reanchorAll();
    return 'ok';
  }

  /** Redraw or close the card once a change has been taken or left. */
  function settle(offset, recheck) {
    if (!active) return;
    refreshButton();
    if (recheck) rescheduleCheck();
    if (active.pinned) {
      const next = nearestSuggestion(offset);
      if (next) {
        showSentence(next.id, true);
        return;
      }
    }
    hideSuggestion();
  }

  function applySuggestion(id) {
    if (!active) return;
    const suggestion = suggestionById(id || active.activeId);
    if (!suggestion) return;
    // Acting on a change means the reviewer is working through the sentence,
    // so the card stays put rather than fading away like a hover preview.
    active.pinned = true;

    const offset = suggestion.start;
    if (applyOne(suggestion.id) === 'refused') {
      ui.showMessage({
        title: 'Blue Pencil',
        tone: 'error',
        message: 'This editor would not accept the change. Try editing it by hand.'
      }, anchorRectFor(suggestion));
      return;
    }
    settle(offset, true);
  }

  /** Take every change in the sentence on screen, top to bottom. */
  function applyGroup() {
    if (!active) return;
    const group = currentGroup();
    if (!group) return;
    active.pinned = true;

    const offset = group.start;
    let refused = false;
    group.items.forEach(function (item) {
      if (applyOne(item.id) === 'refused') refused = true;
    });
    if (refused) {
      ui.showMessage({
        title: 'Blue Pencil',
        tone: 'error',
        message: 'This editor would not accept some of the changes. Try editing it by hand.'
      }, ui.buttonRect());
      refreshButton();
      return;
    }
    settle(offset, true);
  }

  function dismissSuggestion(id) {
    if (!active) return;
    const suggestion = suggestionById(id || active.activeId);
    if (!suggestion) return;
    active.pinned = true;
    const offset = suggestion.start;
    active.dismissed.add(dismissKey(suggestion));
    dropSuggestion(suggestion.id);
    settle(offset, false);
  }

  function dismissGroup() {
    if (!active) return;
    const group = currentGroup();
    if (!group) return;
    active.pinned = true;
    const offset = group.start;
    group.items.forEach(function (item) {
      active.dismissed.add(dismissKey(item));
      dropSuggestion(item.id);
    });
    settle(offset, false);
  }

  /* -------------------------------------------------------------- rewrite */

  async function runRewrite(presetKey) {
    if (!active || !ui) return;
    const preset = BP.REWRITE_PRESETS[presetKey];
    if (!preset) return;

    const adapter = active.adapter;
    const text = adapter.getText();
    const selection = adapter.getSelection();
    const useSelection = Boolean(selection && selection.end - selection.start >= 8);
    const target = useSelection ? text.slice(selection.start, selection.end) : text;

    if (!target.trim()) {
      ui.showMessage({ title: 'Blue Pencil', message: 'There is nothing to rewrite yet.' }, ui.buttonRect());
      return;
    }

    pendingRewrite = null;
    const anchorRect = ui.buttonRect();
    ui.showRewriteLoading(preset.label, anchorRect);

    const requestId = BP.util.hashString('rewrite:' + Date.now());
    active.rewriteId = requestId;
    const response = await send({ type: 'rewrite', text: target, preset: presetKey, requestId: requestId });

    if (!active || active.rewriteId !== requestId) return;
    if (ui.panelKind() !== 'rewrite') return;

    if (response.error) {
      ui.showMessage({
        title: preset.label,
        tone: 'error',
        message: response.error.message,
        detail: response.error.detail ? BP.util.escapeHtml(response.error.detail) : '',
        retry: false
      }, ui.buttonRect());
      return;
    }

    pendingRewrite = {
      text: response.text,
      source: target,
      whole: !useSelection,
      label: preset.label
    };
    ui.showRewriteResult(preset.label, response.text, ui.buttonRect());
  }

  function applyRewrite() {
    if (!active || !pendingRewrite) return;
    const adapter = active.adapter;
    const text = adapter.getText();

    let start = 0;
    let end = text.length;
    if (!pendingRewrite.whole || text !== pendingRewrite.source) {
      const hit = BP.util.anchor(text, pendingRewrite.source, []);
      if (!hit) {
        ui.showMessage({
          title: pendingRewrite.label,
          tone: 'error',
          message: 'The text changed since the rewrite was made. Run it again.'
        }, ui.buttonRect());
        return;
      }
      start = hit.start;
      end = hit.end;
    }

    const ok = adapter.replaceRange(start, end, pendingRewrite.text);
    pendingRewrite = null;
    ui.hidePanel();
    if (!ok) {
      ui.showMessage({
        title: 'Blue Pencil',
        tone: 'error',
        message: 'This editor would not accept the change.'
      }, ui.buttonRect());
      return;
    }
    clearSuggestions();
    active.lastCheckedText = adapter.getText();
    rescheduleCheck();
  }

  function copyRewrite() {
    if (!pendingRewrite) return;
    const value = pendingRewrite.text;
    navigator.clipboard.writeText(value).then(function () {
      ui.showMessage({ title: 'Blue Pencil', message: 'Rewrite copied to the clipboard.' }, ui.buttonRect());
    }, function () {
      ui.showMessage({ title: 'Blue Pencil', tone: 'error', message: 'The page blocked clipboard access.' }, ui.buttonRect());
    });
  }

  /* ------------------------------------------------------- field lifecycle */

  function teardown() {
    cancelCheck();
    if (active) {
      active.highlighter.destroy();
      active = null;
    }
    if (ui) {
      ui.hidePanel();
      ui.setButton(null);
    }
    buttonSignature = '';
    if (ticker) cancelAnimationFrame(ticker);
    ticker = 0;
  }

  function attach(el) {
    const adapter = BP.Editor.adapt(el, settings.excludeSelectors);
    if (!adapter) return false;
    if (active && active.adapter.el === adapter.el) return true;

    teardown();
    const highlighter = BP.createHighlighter(adapter);
    highlighter.setUnderlinesEnabled(settings.showUnderlines);

    active = {
      adapter: adapter,
      highlighter: highlighter,
      suggestions: [],
      dismissed: new Set(),
      activeId: null,
      pinned: false,
      status: enabledHere() ? 'idle' : 'off',
      error: null,
      lastCheckedText: null,
      requestId: null,
      rewriteId: null,
      composing: false,
      truncated: false
    };

    startTicker();
    refreshButton();
    if (enabledHere()) {
      // Get the model loading now, while the user is still typing.
      send({ type: 'warmup' });
      if (settings.autoCheck) rescheduleCheck();
    }
    return true;
  }

  /* --------------------------------------------------------------- events */

  document.addEventListener('focusin', function (event) {
    const target = event.target;
    if (!target || target.nodeType !== 1) return;
    if (target.closest && target.closest('[data-blue-pencil-ui]')) return;
    if (!attach(target) && active && !active.adapter.el.contains(target)) {
      teardown();
    }
  }, true);

  document.addEventListener('focusout', function () {
    setTimeout(function () {
      if (!active) return;
      if (ui && ui.isPointerInside()) return;
      const focused = document.activeElement;
      if (focused && active.adapter.el.contains(focused)) return;
      if (focused === active.adapter.el) return;
      teardown();
    }, 180);
  }, true);

  document.addEventListener('input', function (event) {
    if (!active || !event.target || !active.adapter.el.contains(event.target)) return;
    if (active.composing) return;
    active.adapter.refresh();
    if (active.suggestions.length) reanchorAll();
    if (ui && ui.panelKind() === 'suggestion') {
      if (currentSuggestion()) showSentence(active.activeId, active.pinned);
      else hideSuggestion();
    }
    active.status = active.suggestions.length ? 'ready' : 'idle';
    refreshButton();
    rescheduleCheck();
  }, true);

  document.addEventListener('compositionstart', function (event) {
    if (active && active.adapter.el.contains(event.target)) active.composing = true;
  }, true);

  document.addEventListener('compositionend', function (event) {
    if (active && active.adapter.el.contains(event.target)) {
      active.composing = false;
      rescheduleCheck();
    }
  }, true);

  document.addEventListener('mousemove', function (event) {
    if (!active || !active.suggestions.length || !ui) return;
    if (ui.isPointerInside()) return;
    const id = active.highlighter.hitTest(event.clientX, event.clientY);
    if (id === hoveredId) return;
    hoveredId = id;
    clearTimeout(hoverTimer);
    if (!id) {
      if (!active.pinned && ui.panelKind() === 'suggestion') {
        hoverTimer = setTimeout(function () {
          if (!ui.isPointerInside() && active && !active.pinned) hideSuggestion();
        }, 420);
      }
      return;
    }
    hoverTimer = setTimeout(function () {
      if (active && hoveredId === id) showSentence(id, false);
    }, 200);
  }, true);

  document.addEventListener('mousedown', function (event) {
    if (!active || !ui) return;
    if (event.target.closest && event.target.closest('[data-blue-pencil-ui]')) return;
    if (!active.adapter.el.contains(event.target)) {
      if (ui.panelKind()) ui.hidePanel();
      return;
    }
    const id = active.highlighter.hitTest(event.clientX, event.clientY);
    if (id) {
      setTimeout(function () { showSentence(id, true); }, 0);
    } else if (ui.panelKind() === 'suggestion') {
      hideSuggestion();
    }
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!active || !ui) return;
    const panel = ui.panelKind();

    if (event.key === 'Escape' && panel) {
      ui.hidePanel();
      if (panel === 'suggestion') hideSuggestion();
      pendingRewrite = null;
      return;
    }
    if (event.altKey && event.key === 'Enter') {
      if (panel === 'suggestion' && currentSuggestion()) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) applyGroup();
        else applySuggestion();
      } else if (panel === 'rewrite' && pendingRewrite) {
        event.preventDefault();
        applyRewrite();
      } else if (active.suggestions.length) {
        event.preventDefault();
        showSentence(active.suggestions[0].id, true);
      }
      return;
    }
    if (panel === 'suggestion' && event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      navigate(event.key === 'ArrowDown' ? 1 : -1);
    }
  }, true);

  window.addEventListener('scroll', function () {
    if (active) refreshButton();
  }, true);

  /* --------------------------------------------------- worker notifications */

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;
    if (message.type === 'command') {
      if (message.command === 'check-now') {
        if (!active) {
          sendResponse({ ok: false });
          return;
        }
        active.lastCheckedText = null;
        runCheck({ force: true, reveal: true, showErrors: true });
        sendResponse({ ok: true });
        return true;
      }
    }
  });

  function applySettings(next) {
    const previous = settings;
    settings = BP.mergeSettings(next);
    cancelCheck();

    if (active) {
      active.highlighter.setUnderlinesEnabled(settings.showUnderlines);
      if (!enabledHere()) {
        active.status = 'off';
        clearSuggestions();
      } else if (active.status === 'off') {
        active.status = 'idle';
        active.lastCheckedText = null;
      }
      const relevant = ['model', 'endpoint', 'dialect', 'customInstructions'];
      const changed = relevant.some(function (key) { return previous[key] !== settings[key]; }) ||
        JSON.stringify(previous.categories) !== JSON.stringify(settings.categories);
      if (changed) {
        active.lastCheckedText = null;
        clearSuggestions();
      }
      buttonSignature = '';
      refreshButton();
      if (enabledHere() && settings.autoCheck) rescheduleCheck();
    }
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    ui = BP.createUI({
      onButtonClick: function (rect) {
        if (!active) return;
        if (ui.panelKind()) { ui.hidePanel(); hideSuggestion(); return; }
        if (!enabledHere()) {
          ui.showMessage({
            title: 'Blue Pencil',
            message: settings.enabled
              ? 'Blue Pencil is turned off on ' + HOSTNAME + '.'
              : 'Blue Pencil is turned off.'
          }, rect);
          return;
        }
        if (active.status === 'error' && active.error) {
          ui.showMessage({
            title: 'Blue Pencil',
            tone: 'error',
            message: active.error.message,
            detail: active.error.detail ? BP.util.escapeHtml(active.error.detail) : '',
            retry: true
          }, rect);
          return;
        }
        if (active.suggestions.length) {
          showSentence(active.suggestions[0].id, true);
          return;
        }
        ui.showMenu(rect, { hostname: HOSTNAME, hasSelection: hasSelection() });
      },
      onButtonMenu: function (rect) {
        ui.showMenu(rect, { hostname: HOSTNAME, hasSelection: hasSelection() });
      },
      onApply: applySuggestion,
      onDismiss: dismissSuggestion,
      onApplyAll: applyGroup,
      onDismissAll: dismissGroup,
      onFocus: function (id) { if (id) showSentence(id, true); },
      onNavigate: navigate,
      onClose: function () {
        pendingRewrite = null;
        ui.hidePanel();
        hideSuggestion();
      },
      onRewrite: runRewrite,
      onApplyRewrite: applyRewrite,
      onCopyRewrite: copyRewrite,
      onCheckNow: function () {
        if (!active) return;
        active.lastCheckedText = null;
        runCheck({ force: true, reveal: true, showErrors: true });
      },
      onDisableSite: function () {
        const list = (settings.disabledSites || []).slice();
        if (list.indexOf(HOSTNAME) === -1) list.push(HOSTNAME);
        BP.setSettings({ disabledSites: list }).catch(function () {});
        ui.hidePanel();
      },
      onOpenOptions: function () {
        send({ type: 'open-options' });
        ui.hidePanel();
      }
    });

    BP.getSettings().then(function (loaded) {
      settings = loaded;
      cancelCheck();
      const focused = document.activeElement;
      if (focused && focused !== document.body) attach(focused);
    });

    BP.onSettingsChanged(function (next) {
      applySettings(next);
    });
  }

  function hasSelection() {
    if (!active) return false;
    const selection = active.adapter.getSelection();
    return Boolean(selection && selection.end - selection.start >= 8);
  }

  /* A window onto the content script's state, for debugging a field that is
     not behaving. Lives in the isolated world, so pages cannot see or call it.
     From the extension's devtools console: __bluePencil.state() */
  window.__bluePencil = {
    state: function () {
      return {
        enabledHere: enabledHere(),
        extensionAlive: extensionAlive,
        autoCheck: settings.autoCheck,
        model: settings.model,
        field: active ? active.adapter.el.tagName + '.' + active.adapter.kind : null,
        status: active ? active.status : null,
        composing: active ? active.composing : null,
        suggestions: active ? active.suggestions.length : 0,
        lastCheckedText: active ? active.lastCheckedText : null,
        error: active && active.error ? active.error : null,
        checkPending: Boolean(checkTimer)
      };
    },
    check: function () {
      if (!active) return 'no field focused';
      active.lastCheckedText = null;
      return runCheck({ force: true, reveal: true, showErrors: true });
    }
  };

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });

  window.addEventListener('pagehide', teardown);
})();
