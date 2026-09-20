/* Blue Pencil - underline rendering and geometry.

   <input>/<textarea>: the browser gives no access to the text layout inside a
   form control, so we lay a pixel-identical transparent copy of the text over
   it and underline spans in the copy.
   contenteditable: the CSS Custom Highlight API underlines real ranges without
   touching the page's DOM, which matters inside editors like Gmail or Slack. */
(function (root) {
  'use strict';

  const BP = root.BP = root.BP || {};

  const Z_INDEX = 2147483000;

  const COPIED_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'fontStretch', 'letterSpacing', 'wordSpacing', 'textTransform',
    'textIndent', 'textAlign', 'textRendering', 'lineHeight', 'direction',
    'tabSize', 'wordBreak', 'overflowWrap', 'fontKerning', 'fontFeatureSettings'
  ];

  function correctionClass(category) {
    return BP.CORRECTION_CATEGORIES.indexOf(category) === -1 ? 'bp-improve' : 'bp-correct';
  }

  const MIRROR_CSS = [
    ':host { all: initial; }',
    '.mirror {',
    '  position: absolute; top: 0; left: 0;',
    '  overflow: hidden; box-sizing: border-box;',
    '  border-style: solid; border-color: transparent;',
    '  background: transparent; color: transparent;',
    '  -webkit-text-fill-color: transparent;',
    '  pointer-events: none; user-select: none;',
    '}',
    '.content { margin: 0; padding: 0; border: 0; background: transparent; }',
    '.bp-mark {',
    '  text-decoration-line: underline;',
    '  text-decoration-style: wavy;',
    '  text-decoration-thickness: 1.5px;',
    '  text-underline-offset: 2px;',
    '  text-decoration-skip-ink: none;',
    '  border-radius: 2px;',
    '}',
    '.bp-mark.bp-correct { text-decoration-color: #e0342b; }',
    '.bp-mark.bp-improve { text-decoration-color: #2563eb; }',
    '.bp-mark.bp-active.bp-correct { background: rgba(224, 52, 43, 0.16); }',
    '.bp-mark.bp-active.bp-improve { background: rgba(37, 99, 235, 0.16); }',
    '.hidden { display: none; }'
  ].join('\n');

  /* ------------------------------------------------- input / textarea mirror */

  function createMirrorHighlighter(adapter) {
    const el = adapter.el;
    const doc = el.ownerDocument || document;

    const host = doc.createElement('div');
    host.className = 'bp-root';
    host.setAttribute('data-blue-pencil-ui', 'mirror');
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;margin:0;padding:0;border:0;' +
      'pointer-events:none;z-index:' + Z_INDEX + ';';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = MIRROR_CSS;
    const mirror = doc.createElement('div');
    mirror.className = 'mirror';
    const content = doc.createElement('div');
    content.className = 'content';
    mirror.appendChild(content);
    shadow.appendChild(style);
    shadow.appendChild(mirror);

    let attached = false;
    let frame = 0;
    let signature = '';
    let suggestions = [];
    let activeId = null;
    let underlinesOn = true;

    function attach() {
      if (attached) return;
      (doc.body || doc.documentElement).appendChild(host);
      attached = true;
    }

    function syncStyles() {
      const computed = getComputedStyle(el);
      for (let i = 0; i < COPIED_STYLES.length; i++) {
        const prop = COPIED_STYLES[i];
        content.style[prop] = computed[prop];
      }
      mirror.style.borderTopWidth = computed.borderTopWidth;
      mirror.style.borderRightWidth = computed.borderRightWidth;
      mirror.style.borderBottomWidth = computed.borderBottomWidth;
      mirror.style.borderLeftWidth = computed.borderLeftWidth;
      mirror.style.paddingTop = computed.paddingTop;
      mirror.style.paddingRight = computed.paddingRight;
      mirror.style.paddingBottom = computed.paddingBottom;
      mirror.style.paddingLeft = computed.paddingLeft;
      mirror.style.direction = computed.direction;

      if (adapter.multiline) {
        content.style.whiteSpace = computed.whiteSpace === 'pre' ? 'pre' : 'pre-wrap';
        content.style.overflowWrap = computed.overflowWrap === 'normal' ? 'break-word' : computed.overflowWrap;
        content.style.lineHeight = computed.lineHeight;
        content.style.height = 'auto';
      } else {
        // A single-line input centres its text in the content box; matching the
        // line height to that box reproduces the same baseline.
        const contentHeight = el.clientHeight -
          parseFloat(computed.paddingTop || '0') -
          parseFloat(computed.paddingBottom || '0');
        content.style.whiteSpace = 'pre';
        content.style.lineHeight = contentHeight > 0 ? contentHeight + 'px' : computed.lineHeight;
      }

      // A visible scrollbar shrinks the control's content box; pad the mirror
      // by the same amount so wrapping stays identical.
      const borderX = parseFloat(computed.borderLeftWidth || '0') + parseFloat(computed.borderRightWidth || '0');
      const borderY = parseFloat(computed.borderTopWidth || '0') + parseFloat(computed.borderBottomWidth || '0');
      const scrollbarX = Math.max(0, el.offsetWidth - el.clientWidth - borderX);
      const scrollbarY = Math.max(0, el.offsetHeight - el.clientHeight - borderY);
      if (scrollbarX) {
        const padRight = parseFloat(computed.paddingRight || '0');
        mirror.style.paddingRight = (padRight + scrollbarX) + 'px';
      }
      if (scrollbarY) {
        const padBottom = parseFloat(computed.paddingBottom || '0');
        mirror.style.paddingBottom = (padBottom + scrollbarY) + 'px';
      }
    }

    function render() {
      const text = adapter.getText();
      content.textContent = '';

      if (!suggestions.length) {
        content.appendChild(doc.createTextNode(text));
        return;
      }

      let cursor = 0;
      for (let i = 0; i < suggestions.length; i++) {
        const item = suggestions[i];
        if (item.start < cursor || item.end > text.length) continue;
        if (cursor < item.start) {
          content.appendChild(doc.createTextNode(text.slice(cursor, item.start)));
        }
        const span = doc.createElement('span');
        span.className = 'bp-mark ' + correctionClass(item.category) +
          (item.id === activeId ? ' bp-active' : '') +
          (underlinesOn ? '' : ' hidden-underline');
        if (!underlinesOn) {
          span.style.textDecorationLine = 'none';
          span.style.background = 'transparent';
        }
        span.setAttribute('data-id', item.id);
        span.textContent = text.slice(item.start, item.end);
        content.appendChild(span);
        cursor = item.end;
      }
      if (cursor < text.length) {
        content.appendChild(doc.createTextNode(text.slice(cursor)));
      }
      // A trailing newline is not rendered without a following character.
      content.appendChild(doc.createTextNode('​'));
    }

    function reposition(force) {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 &&
        rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth;

      const next = [
        Math.round(rect.top), Math.round(rect.left),
        Math.round(rect.width), Math.round(rect.height),
        el.scrollTop, el.scrollLeft, visible ? 1 : 0
      ].join(':');
      if (!force && next === signature) return;
      signature = next;

      host.style.display = visible ? 'block' : 'none';
      if (!visible) return;

      host.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
      mirror.style.width = rect.width + 'px';
      mirror.style.height = rect.height + 'px';
      content.style.transform = 'translate(' + (-el.scrollLeft) + 'px,' + (-el.scrollTop) + 'px)';
      if (adapter.multiline) {
        content.style.width = '100%';
      }
    }

    function loop() {
      frame = 0;
      if (!attached) return;
      reposition(false);
      if (suggestions.length || activeId) frame = requestAnimationFrame(loop);
    }

    function startLoop() {
      if (!frame) frame = requestAnimationFrame(loop);
    }

    return {
      kind: 'mirror',
      setUnderlinesEnabled: function (enabled) { underlinesOn = enabled; },
      update: function (items, active) {
        suggestions = items || [];
        activeId = active || null;
        attach();
        syncStyles();
        render();
        reposition(true);
        startLoop();
      },
      setActive: function (active) {
        activeId = active || null;
        render();
        reposition(true);
      },
      reposition: function () { reposition(true); },
      /** Viewport rects for a suggestion, read from the mirrored layout. */
      rectsFor: function (id) {
        const span = content.querySelector('[data-id="' + id + '"]');
        if (!span) return [];
        return Array.prototype.slice.call(span.getClientRects());
      },
      /** Which suggestion sits under a viewport point, if any. */
      hitTest: function (x, y) {
        const spans = content.querySelectorAll('.bp-mark');
        for (let i = 0; i < spans.length; i++) {
          const rects = spans[i].getClientRects();
          for (let r = 0; r < rects.length; r++) {
            const rect = rects[r];
            if (x >= rect.left && x <= rect.right && y >= rect.top - 2 && y <= rect.bottom + 2) {
              return spans[i].getAttribute('data-id');
            }
          }
        }
        return null;
      },
      clear: function () {
        suggestions = [];
        activeId = null;
        if (attached) render();
      },
      destroy: function () {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (attached && host.parentNode) host.parentNode.removeChild(host);
        attached = false;
      }
    };
  }

  /* -------------------------------------------- contenteditable highlighter */

  const SUPPORTS_CSS_HIGHLIGHT = typeof CSS !== 'undefined' && CSS.highlights &&
    typeof Highlight !== 'undefined';

  function createRangeHighlighter(adapter) {
    let suggestions = [];
    let activeId = null;
    let underlinesOn = true;

    function paint() {
      if (!SUPPORTS_CSS_HIGHLIGHT) return;
      const groups = { 'bp-correct': [], 'bp-improve': [], 'bp-active': [] };
      if (underlinesOn) {
        for (let i = 0; i < suggestions.length; i++) {
          const item = suggestions[i];
          const range = adapter.rangeFor(item.start, item.end);
          if (!range) continue;
          groups[correctionClass(item.category)].push(range);
          if (item.id === activeId) groups['bp-active'].push(range);
        }
      }
      Object.keys(groups).forEach(function (name) {
        if (groups[name].length) {
          CSS.highlights.set(name, new Highlight(...groups[name]));
        } else {
          CSS.highlights.delete(name);
        }
      });
    }

    return {
      kind: 'range',
      setUnderlinesEnabled: function (enabled) { underlinesOn = enabled; },
      update: function (items, active) {
        suggestions = items || [];
        activeId = active || null;
        adapter.refresh();
        paint();
      },
      setActive: function (active) {
        activeId = active || null;
        paint();
      },
      reposition: function () {},
      rectsFor: function (id) {
        for (let i = 0; i < suggestions.length; i++) {
          if (suggestions[i].id !== id) continue;
          const range = adapter.rangeFor(suggestions[i].start, suggestions[i].end);
          if (!range) return [];
          return Array.prototype.slice.call(range.getClientRects());
        }
        return [];
      },
      hitTest: function (x, y) {
        for (let i = 0; i < suggestions.length; i++) {
          const range = adapter.rangeFor(suggestions[i].start, suggestions[i].end);
          if (!range) continue;
          const rects = range.getClientRects();
          for (let r = 0; r < rects.length; r++) {
            const rect = rects[r];
            if (x >= rect.left && x <= rect.right && y >= rect.top - 2 && y <= rect.bottom + 2) {
              return suggestions[i].id;
            }
          }
        }
        return null;
      },
      clear: function () {
        suggestions = [];
        activeId = null;
        paint();
      },
      destroy: function () {
        suggestions = [];
        activeId = null;
        if (SUPPORTS_CSS_HIGHLIGHT) {
          CSS.highlights.delete('bp-correct');
          CSS.highlights.delete('bp-improve');
          CSS.highlights.delete('bp-active');
        }
      }
    };
  }

  BP.createHighlighter = function (adapter) {
    return adapter.kind === 'input'
      ? createMirrorHighlighter(adapter)
      : createRangeHighlighter(adapter);
  };
  BP.SUPPORTS_CSS_HIGHLIGHT = SUPPORTS_CSS_HIGHLIGHT;
})(typeof self !== 'undefined' ? self : this);
