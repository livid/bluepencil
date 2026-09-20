/* Blue Pencil - on-page interface: the field button, the sentence review card,
   the rewrite menu and its preview. Everything lives in one shadow root so
   page styles cannot reach it and its styles cannot reach the page. */
(function (root) {
  'use strict';

  const BP = root.BP = root.BP || {};
  const Z_INDEX = 2147483001;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .layer { position: fixed; inset: 0; pointer-events: none; z-index: ${Z_INDEX}; }
  .layer > * { pointer-events: auto; position: fixed; }

  :host {
    --bg: #ffffff;
    --fg: #14181f;
    --muted: #5c6673;
    --line: #e3e7ee;
    --accent: #2563eb;
    --accent-fg: #ffffff;
    --danger: #e0342b;
    --ok: #0f9d58;
    --shadow: 0 6px 28px rgba(16, 24, 40, 0.18), 0 1px 3px rgba(16, 24, 40, 0.12);
    --btn-bg: #f4f6fa;
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: #1b1f27;
      --fg: #eef1f6;
      --muted: #a2adbd;
      --line: #2e353f;
      --accent: #5b8cff;
      --accent-fg: #0d1117;
      --danger: #ff6b61;
      --ok: #4ade80;
      --shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
      --btn-bg: #262c36;
    }
  }

  .fab {
    width: 22px; height: 22px; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    background: var(--bg); color: var(--accent);
    border: 1px solid var(--line);
    box-shadow: 0 1px 4px rgba(16, 24, 40, 0.22);
    cursor: pointer; padding: 0; font-size: 11px; font-weight: 600;
    transition: transform .12s ease, box-shadow .12s ease;
  }
  .fab:hover { transform: scale(1.12); }
  .fab svg { width: 13px; height: 13px; display: block; }
  .fab.state-issues { background: var(--danger); color: #fff; border-color: transparent; }
  .fab.state-improve { background: var(--accent); color: #fff; border-color: transparent; }
  .fab.state-clean { color: var(--ok); }
  .fab.state-error { background: #f6a609; color: #201500; border-color: transparent; }
  .fab.state-off { color: var(--muted); opacity: .65; }
  .fab .count { font-size: 11px; line-height: 1; }
  .fab .spinner {
    width: 11px; height: 11px; border-radius: 999px;
    border: 2px solid var(--line); border-top-color: var(--accent);
    animation: bp-spin .7s linear infinite;
  }
  @keyframes bp-spin { to { transform: rotate(360deg); } }

  .card {
    width: 328px; max-width: calc(100vw - 20px);
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 12px;
    box-shadow: var(--shadow); overflow: hidden;
    font-size: 13px; line-height: 1.45;
    animation: bp-pop .1s ease-out;
  }
  .card.wide { width: 400px; }
  @keyframes bp-pop { from { opacity: 0; transform: translateY(-3px); } }

  .head { display: flex; align-items: center; gap: 8px; padding: 9px 10px 0 12px; }
  .chip {
    font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    padding: 2px 7px; border-radius: 999px; background: var(--btn-bg); color: var(--muted);
  }
  .chip.correct { background: rgba(224, 52, 43, .13); color: var(--danger); }
  .chip.improve { background: rgba(37, 99, 235, .13); color: var(--accent); }
  .counter { margin-left: auto; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .iconbtn {
    background: none; border: 0; color: var(--muted); cursor: pointer;
    padding: 2px 4px; border-radius: 6px; font-size: 14px; line-height: 1;
  }
  .iconbtn:hover { background: var(--btn-bg); color: var(--fg); }

  del { text-decoration: line-through; text-decoration-color: var(--danger); color: var(--muted); }
  ins { text-decoration: none; color: var(--ok); font-weight: 600; background: rgba(15, 157, 88, .12); border-radius: 3px; padding: 0 2px; }
  .reason { padding: 6px 12px 0; color: var(--muted); font-size: 12.5px; }

  /* The sentence under review, with every proposed change shown in place. */
  .sentence {
    padding: 9px 12px 2px; font-size: 13.5px; line-height: 1.65;
    max-height: 170px; overflow: auto; word-break: break-word;
  }
  .sentence .ctx { white-space: pre-wrap; }
  .sentence .edit {
    border-radius: 3px; padding: 0 1px; cursor: pointer;
    box-shadow: inset 0 -1.5px 0 var(--accent);
  }
  .sentence .edit.correct { box-shadow: inset 0 -1.5px 0 var(--danger); }
  .sentence .edit ins { margin-left: 3px; }
  .sentence .edit.active { background: rgba(37, 99, 235, .13); box-shadow: inset 0 -2px 0 var(--accent); }
  .sentence .edit.active.correct { background: rgba(224, 52, 43, .11); box-shadow: inset 0 -2px 0 var(--danger); }

  .rows { margin-top: 7px; border-top: 1px solid var(--line); max-height: 176px; overflow: auto; }
  .row {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 7px 8px 7px 12px; cursor: pointer;
    border-bottom: 1px solid var(--line);
  }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: var(--btn-bg); }
  .row.active { background: rgba(37, 99, 235, .09); }
  .row .dot { width: 6px; height: 6px; border-radius: 999px; margin-top: 7px; flex: none; background: var(--accent); }
  .row .dot.correct { background: var(--danger); }
  .row .rowbody { flex: 1; min-width: 0; }
  .row .rowdiff { font-size: 13px; word-break: break-word; }
  .row .rowmeta { font-size: 11.5px; color: var(--muted); margin-top: 1px; }
  .row .rowacts { display: flex; gap: 2px; margin-left: auto; flex: none; }
  .row .iconbtn { font-size: 13px; padding: 3px 5px; }
  .row .iconbtn.ok:hover { background: rgba(15, 157, 88, .14); color: var(--ok); }
  .row .iconbtn.no:hover { background: rgba(224, 52, 43, .12); color: var(--danger); }

  .foot { display: flex; align-items: center; gap: 6px; padding: 10px 12px 11px; }
  .btn {
    font: inherit; font-size: 12.5px; padding: 5px 11px; border-radius: 7px;
    border: 1px solid var(--line); background: var(--btn-bg); color: var(--fg); cursor: pointer;
  }
  .btn:hover { border-color: var(--muted); }
  .btn.primary { background: var(--accent); border-color: transparent; color: #fff; font-weight: 600; }
  .btn.primary:hover { filter: brightness(1.08); }
  .btn.ghost { background: none; border-color: transparent; color: var(--muted); padding: 5px 7px; }
  .btn.ghost:hover { background: var(--btn-bg); color: var(--fg); }
  .btn:disabled { opacity: .5; cursor: default; }
  .spacer { margin-left: auto; }
  .kbd {
    font-size: 10.5px; color: var(--muted); border: 1px solid var(--line);
    border-radius: 4px; padding: 1px 4px; background: var(--btn-bg);
  }

  .menu {
    width: 232px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 11px; box-shadow: var(--shadow);
    padding: 5px; overflow: hidden; animation: bp-pop .1s ease-out;
  }
  .menu button {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    font: inherit; font-size: 13px; padding: 7px 9px; border: 0; border-radius: 7px;
    background: none; color: var(--fg); cursor: pointer;
  }
  .menu button:hover { background: var(--btn-bg); }
  .menu .sep { height: 1px; background: var(--line); margin: 5px 4px; }
  .menu .label { padding: 7px 9px 4px; font-size: 10.5px; text-transform: uppercase;
    letter-spacing: .05em; color: var(--muted); font-weight: 700; }
  .menu button .hint { margin-left: auto; font-size: 11px; color: var(--muted); }

  .body {
    padding: 10px 12px 0; max-height: 240px; overflow: auto;
    white-space: pre-wrap; word-break: break-word; font-size: 13.5px;
  }
  .body.muted { color: var(--muted); }
  .loading { display: flex; align-items: center; gap: 8px; color: var(--muted); padding: 14px 12px; }
  .loading .spinner {
    width: 13px; height: 13px; border-radius: 999px;
    border: 2px solid var(--line); border-top-color: var(--accent);
    animation: bp-spin .7s linear infinite;
  }
  .error { padding: 10px 12px 0; color: var(--danger); font-size: 13px; }
  .error-detail { padding: 6px 12px 0; color: var(--muted); font-size: 12px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px;
    background: var(--btn-bg); padding: 1px 4px; border-radius: 4px; }
  .hidden { display: none !important; }
  `;

  const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 20.5 8.2 19.4 20 7.6a2 2 0 0 0 0-2.8l-.8-.8a2 2 0 0 0-2.8 0L4.6 15.8Z"/>' +
    '<path d="m14.8 6 3.2 3.2"/></svg>';

  function place(node, anchorRect, options) {
    const opts = options || {};
    const gap = typeof opts.gap === 'number' ? opts.gap : 8;
    const rect = node.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = anchorRect.bottom + gap;
    if (top + rect.height > vh - 8 && anchorRect.top - gap - rect.height > 8) {
      top = anchorRect.top - gap - rect.height;
    }
    top = Math.max(8, Math.min(top, vh - rect.height - 8));

    let left = opts.alignRight
      ? anchorRect.right - rect.width
      : anchorRect.left;
    left = Math.max(8, Math.min(left, vw - rect.width - 8));

    node.style.top = Math.round(top) + 'px';
    node.style.left = Math.round(left) + 'px';
  }

  function createUI(handlers) {
    const doc = document;
    const host = doc.createElement('div');
    host.className = 'bp-root';
    host.setAttribute('data-blue-pencil-ui', 'panel');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:' + Z_INDEX + ';';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = doc.createElement('style');
    style.textContent = CSS;
    const layer = doc.createElement('div');
    layer.className = 'layer';

    const fab = doc.createElement('button');
    fab.className = 'fab hidden';
    fab.type = 'button';
    fab.title = 'Blue Pencil';

    const panel = doc.createElement('div');
    panel.className = 'hidden';

    layer.appendChild(fab);
    layer.appendChild(panel);
    shadow.appendChild(style);
    shadow.appendChild(layer);
    (doc.body || doc.documentElement).appendChild(host);

    let panelKind = null;
    let pointerInside = false;
    let sentenceSignature = '';

    // Never let a click on our own chrome pull focus out of the text field.
    function keepFocus(event) {
      event.preventDefault();
      event.stopPropagation();
    }
    layer.addEventListener('mousedown', keepFocus, true);
    layer.addEventListener('pointerdown', keepFocus, true);
    layer.addEventListener('mouseenter', function () { pointerInside = true; }, true);
    layer.addEventListener('mouseleave', function () { pointerInside = false; }, true);
    panel.addEventListener('mouseover', function () { pointerInside = true; });
    panel.addEventListener('mouseout', function () { pointerInside = false; });

    fab.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      handlers.onButtonClick && handlers.onButtonClick(fab.getBoundingClientRect());
    });
    fab.addEventListener('contextmenu', function (event) {
      event.preventDefault();
      handlers.onButtonMenu && handlers.onButtonMenu(fab.getBoundingClientRect());
    });

    panel.addEventListener('click', function (event) {
      const target = event.target.closest('[data-act],[data-preset]');
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const preset = target.getAttribute('data-preset');
      if (preset) {
        handlers.onRewrite && handlers.onRewrite(preset);
        return;
      }
      const act = target.getAttribute('data-act');
      const id = target.getAttribute('data-sid') || null;
      const map = {
        apply: handlers.onApply,
        dismiss: handlers.onDismiss,
        focus: handlers.onFocus,
        'apply-all': handlers.onApplyAll,
        'dismiss-all': handlers.onDismissAll,
        next: function () { handlers.onNavigate && handlers.onNavigate(1); },
        prev: function () { handlers.onNavigate && handlers.onNavigate(-1); },
        close: handlers.onClose,
        check: handlers.onCheckNow,
        menu: function () { handlers.onButtonMenu && handlers.onButtonMenu(fab.getBoundingClientRect()); },
        site: handlers.onDisableSite,
        options: handlers.onOpenOptions,
        'apply-rewrite': handlers.onApplyRewrite,
        copy: handlers.onCopyRewrite,
        retry: handlers.onCheckNow
      };
      const fn = map[act];
      if (fn) fn(id);
    });

    function showPanel(kind, html, anchorRect, wide) {
      if (kind !== 'suggestion') sentenceSignature = '';
      panelKind = kind;
      panel.className = '';
      panel.innerHTML = html;
      const node = panel.firstElementChild;
      if (node && wide) node.classList.add('wide');
      panel.style.top = '-9999px';
      panel.style.left = '-9999px';
      // Measure after paint-less layout, then position.
      place(panel, anchorRect, { alignRight: kind === 'menu' });
      return node;
    }

    function hidePanel() {
      sentenceSignature = '';
      panelKind = null;
      panel.className = 'hidden';
      panel.innerHTML = '';
    }

    function escape(text) { return BP.util.escapeHtml(text); }

    function editClass(suggestion) {
      return BP.CORRECTION_CATEGORIES.indexOf(suggestion.category) === -1 ? 'improve' : 'correct';
    }

    function editSpan(suggestion, active) {
      return '<span class="edit ' + editClass(suggestion) +
        (active ? ' active' : '') + '" data-act="focus" data-sid="' + suggestion.id + '">' +
        '<del>' + escape(suggestion.before) + '</del>' +
        (suggestion.after ? '<ins>' + escape(suggestion.after) + '</ins>' : '') +
        '</span>';
    }

    /* The sentence, verbatim, with each proposed change spliced in where it
       sits. Very long sentences are trimmed to the changes plus context. */
    const CONTEXT_CHARS = 180;

    function renderSentence(view) {
      const text = view.text;
      const items = view.group.items;
      let from = view.group.start;
      let to = view.group.end;
      let head = '';
      let tail = '';

      if (items[0].start - from > CONTEXT_CHARS) {
        from = items[0].start - CONTEXT_CHARS;
        head = '<span class="ctx">… </span>';
      }
      const lastEnd = items[items.length - 1].end;
      if (to - lastEnd > CONTEXT_CHARS) {
        to = lastEnd + CONTEXT_CHARS;
        tail = '<span class="ctx"> …</span>';
      }

      let html = head;
      let cursor = from;
      items.forEach(function (item) {
        if (item.start < cursor || item.end > to) return;
        if (item.start > cursor) html += '<span class="ctx">' + escape(text.slice(cursor, item.start)) + '</span>';
        html += editSpan(item, item.id === view.focusId);
        cursor = item.end;
      });
      if (cursor < to) html += '<span class="ctx">' + escape(text.slice(cursor, to)) + '</span>';
      return html + tail;
    }

    /* Rows show only the part that actually changes, so a long span stays
       readable; the sentence above already carries the context. */
    function renderRowDiff(item) {
      const parts = BP.util.diffParts(item.before, item.after);
      // Trimming to the changed part helps a substitution, but a pure
      // insertion would come out as a stray letter, so show it whole.
      const trim = Boolean(parts.removed) && Boolean(parts.added);
      const removed = trim ? parts.removed : item.before;
      const added = trim ? parts.added : item.after;
      return (removed ? '<del>' + escape(removed) + '</del>' : '') +
        (added ? '<ins>' + escape(added) + '</ins>' : '');
    }

    function renderRow(item, active) {
      const label = BP.CATEGORY_LABELS[item.category] || item.category;
      const meta = item.reason ? label + ' · ' + item.reason : label;
      return '<div class="row' + (active ? ' active' : '') + '" data-act="focus" data-sid="' + item.id + '">' +
        '<span class="dot ' + editClass(item) + '"></span>' +
        '<div class="rowbody">' +
          '<div class="rowdiff">' + renderRowDiff(item) + '</div>' +
          '<div class="rowmeta">' + escape(meta) + '</div>' +
        '</div>' +
        '<div class="rowacts">' +
          '<button class="iconbtn ok" data-act="apply" data-sid="' + item.id + '" title="Accept">&#10003;</button>' +
          '<button class="iconbtn no" data-act="dismiss" data-sid="' + item.id + '" title="Ignore">&#10005;</button>' +
        '</div>' +
      '</div>';
    }

    return {
      host: host,

      isPointerInside: function () { return pointerInside; },
      panelKind: function () { return panelKind; },

      setButton: function (state) {
        if (!state || !state.visible || !state.rect) {
          fab.className = 'fab hidden';
          return;
        }
        const rect = state.rect;
        let inner = PENCIL_SVG;
        let cls = 'fab state-' + state.state;
        let title = 'Blue Pencil';

        if (state.state === 'checking') {
          inner = '<span class="spinner"></span>';
          title = 'Checking...';
        } else if (state.state === 'issues') {
          inner = '<span class="count">' + state.count + '</span>';
          cls = 'fab state-' + (state.onlyImprovements ? 'improve' : 'issues');
          title = state.count + (state.count === 1 ? ' suggestion' : ' suggestions');
        } else if (state.state === 'error') {
          inner = '<span class="count">!</span>';
          title = state.title || 'Blue Pencil could not reach Ollama';
        } else if (state.state === 'clean') {
          title = 'No issues found';
        } else if (state.state === 'off') {
          title = 'Blue Pencil is off here';
        }

        fab.className = cls;
        fab.innerHTML = inner;
        fab.title = title;

        const size = 22;
        const inset = 6;
        // Sit inside the bottom-right corner, or just outside for short fields.
        const fits = rect.height >= size + inset * 2;
        const top = fits
          ? rect.bottom - size - inset
          : rect.top + (rect.height - size) / 2;
        const left = fits
          ? rect.right - size - inset
          : rect.right + 4;
        fab.style.top = Math.round(BP.util.clamp(top, 4, window.innerHeight - size - 4)) + 'px';
        fab.style.left = Math.round(BP.util.clamp(left, 4, window.innerWidth - size - 4)) + 'px';
      },

      buttonRect: function () { return fab.getBoundingClientRect(); },

      /* The sentence under review: its full text, with every change the model
         proposed shown where it belongs, and one row per change to act on. */
      showSentence: function (view, anchorRect) {
        const items = view.group.items;

        // Typing re-opens the card on every keystroke; only redraw when what
        // it shows has actually changed, so it does not flicker under you.
        const signature = [
          view.group.start, view.group.end, view.focusId, view.index, view.total,
          items.map(function (item) { return item.id; }).join(','),
          view.text.slice(view.group.start, view.group.end)
        ].join('|');
        if (panelKind === 'suggestion' && signature === sentenceSignature) return;
        sentenceSignature = signature;

        const focused = items.find(function (s) { return s.id === view.focusId; }) || items[0];
        const multiple = items.length > 1;
        const isCorrection = BP.CORRECTION_CATEGORIES.indexOf(focused.category) !== -1;
        const chip = multiple
          ? '<span class="chip">' + items.length + ' changes</span>'
          : '<span class="chip ' + (isCorrection ? 'correct' : 'improve') + '">' +
            escape(BP.CATEGORY_LABELS[focused.category] || focused.category) + '</span>';
        const counter = view.total > 1
          ? 'Sentence ' + (view.index + 1) + ' of ' + view.total
          : '';

        const html =
          '<div class="card">' +
            '<div class="head">' +
              chip +
              '<span class="counter">' + counter + '</span>' +
              '<button class="iconbtn" data-act="close" title="Close">&#10005;</button>' +
            '</div>' +
            '<div class="sentence">' + renderSentence(view) + '</div>' +
            (multiple
              ? '<div class="rows">' + items.map(function (item) {
                  return renderRow(item, item.id === view.focusId);
                }).join('') + '</div>'
              : (focused.reason ? '<div class="reason">' + escape(focused.reason) + '</div>' : '')) +
            '<div class="foot">' +
              (multiple
                ? '<button class="btn primary" data-act="apply-all">Accept all ' + items.length + '</button>' +
                  '<button class="btn" data-act="dismiss-all">Ignore all</button>'
                : '<button class="btn primary" data-act="apply" data-sid="' + focused.id + '">Accept</button>' +
                  '<button class="btn" data-act="dismiss" data-sid="' + focused.id + '">Ignore</button>') +
              '<span class="spacer"></span>' +
              (view.total > 1 ? '<button class="btn ghost" data-act="prev" title="Previous sentence">&#8249;</button>' +
                                '<button class="btn ghost" data-act="next" title="Next sentence">&#8250;</button>' : '') +
              '<button class="btn ghost" data-act="menu" title="More">&#8943;</button>' +
            '</div>' +
          '</div>';
        showPanel('suggestion', html, anchorRect, true);
      },

      showMenu: function (anchorRect, options) {
        const presets = BP.REWRITE_PRESETS;
        let items = '';
        Object.keys(presets).forEach(function (key) {
          items += '<button type="button" data-preset="' + key + '">' + escape(presets[key].label) + '</button>';
        });
        const html =
          '<div class="menu">' +
            '<div class="label">Rewrite' + (options && options.hasSelection ? ' selection' : '') + '</div>' +
            items +
            '<div class="sep"></div>' +
            '<button type="button" data-act="check">Check now<span class="hint">Alt+Shift+B</span></button>' +
            '<button type="button" data-act="site">Turn off on ' + escape(options && options.hostname ? options.hostname : 'this site') + '</button>' +
            '<button type="button" data-act="options">Settings…</button>' +
          '</div>';
        showPanel('menu', html, anchorRect);
      },

      showRewriteLoading: function (label, anchorRect) {
        const html =
          '<div class="card wide">' +
            '<div class="head">' +
              '<span class="chip improve">' + escape(label) + '</span>' +
              '<span class="counter"></span>' +
              '<button class="iconbtn" data-act="close" title="Cancel">&#10005;</button>' +
            '</div>' +
            '<div class="loading"><span class="spinner"></span>Asking your model…</div>' +
          '</div>';
        showPanel('rewrite', html, anchorRect, true);
      },

      showRewriteResult: function (label, text, anchorRect) {
        const html =
          '<div class="card wide">' +
            '<div class="head">' +
              '<span class="chip improve">' + escape(label) + '</span>' +
              '<span class="counter"></span>' +
              '<button class="iconbtn" data-act="close" title="Close">&#10005;</button>' +
            '</div>' +
            '<div class="body">' + escape(text) + '</div>' +
            '<div class="foot">' +
              '<button class="btn primary" data-act="apply-rewrite">Replace text</button>' +
              '<button class="btn" data-act="copy">Copy</button>' +
              '<span class="spacer"></span>' +
              '<button class="btn ghost" data-act="close">Cancel</button>' +
            '</div>' +
          '</div>';
        showPanel('rewrite', html, anchorRect, true);
      },

      showMessage: function (options, anchorRect) {
        const html =
          '<div class="card">' +
            '<div class="head">' +
              '<span class="chip">' + escape(options.title || 'Blue Pencil') + '</span>' +
              '<span class="counter"></span>' +
              '<button class="iconbtn" data-act="close" title="Close">&#10005;</button>' +
            '</div>' +
            '<div class="' + (options.tone === 'error' ? 'error' : 'body muted') + '">' +
              escape(options.message) + '</div>' +
            (options.detail ? '<div class="error-detail">' + options.detail + '</div>' : '') +
            '<div class="foot">' +
              (options.retry ? '<button class="btn primary" data-act="retry">Try again</button>' : '') +
              '<button class="btn" data-act="options">Settings</button>' +
              '<span class="spacer"></span>' +
              '<button class="btn ghost" data-act="close">Close</button>' +
            '</div>' +
          '</div>';
        showPanel('message', html, anchorRect);
      },

      hidePanel: hidePanel,

      reposition: function (anchorRect) {
        if (!panelKind || !anchorRect) return;
        place(panel, anchorRect, { alignRight: panelKind === 'menu' });
      },

      destroy: function () {
        hidePanel();
        if (host.parentNode) host.parentNode.removeChild(host);
      }
    };
  }

  BP.createUI = createUI;
})(typeof self !== 'undefined' ? self : this);
