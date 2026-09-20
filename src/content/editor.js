/* Blue Pencil - one uniform interface over <input>, <textarea> and
   contenteditable hosts: read the text, map plain-text offsets to the DOM,
   and replace a span without breaking the page's own undo stack. */
(function (root) {
  'use strict';

  const BP = root.BP = root.BP || {};

  const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', ''];

  const SENSITIVE_AUTOCOMPLETE = /(cc-|credit|card|cvc|cvv|one-time-code|otp|current-password|new-password)/i;

  const CODE_EDITOR_SELECTOR = [
    '.CodeMirror', '.cm-editor', '.monaco-editor', '.ace_editor',
    '[data-mode-id]', '.CodeMirror-code'
  ].join(',');

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL',
    'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
    'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
    'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TD', 'TH', 'TR', 'UL'
  ]);

  const MAX_WALK_NODES = 6000;

  function optedOut(el) {
    return Boolean(
      el.closest('[data-blue-pencil="off"]') ||
      el.closest('[data-gramm="false"]') ||
      el.closest('[data-enable-grammarly="false"]')
    );
  }

  /** Decide whether an element is something we should proofread. */
  function isEligible(el, extraSelectors) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('.bp-root, [data-blue-pencil-ui]')) return false;
    if (el.closest(CODE_EDITOR_SELECTOR)) return false;
    if (optedOut(el)) return false;
    if (extraSelectors) {
      try { if (el.closest(extraSelectors)) return false; } catch (err) { /* bad selector */ }
    }

    const tag = el.tagName;
    if (tag === 'TEXTAREA') {
      return !el.readOnly && !el.disabled;
    }
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (TEXT_INPUT_TYPES.indexOf(type) === -1) return false;
      if (el.readOnly || el.disabled) return false;
      if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return false;
      if (SENSITIVE_AUTOCOMPLETE.test(el.getAttribute('name') || '')) return false;
      if ((el.getAttribute('inputmode') || '') === 'numeric') return false;
      return true;
    }
    return el.isContentEditable;
  }

  function editingHost(el) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el;
    let host = el;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    return host;
  }

  /* ---------------------------------------------------------------- input */

  function createInputAdapter(el) {
    return {
      el: el,
      kind: 'input',
      multiline: el.tagName === 'TEXTAREA',
      getText: function () { return el.value || ''; },
      refresh: function () {},
      getSelection: function () {
        try {
          if (el.selectionStart === null) return null;
          return { start: el.selectionStart, end: el.selectionEnd };
        } catch (err) {
          return null;
        }
      },
      setSelection: function (start, end) {
        try { el.setSelectionRange(start, end); } catch (err) { /* unsupported */ }
      },
      isEditableRange: function () { return true; },
      replaceRange: function (start, end, replacement) {
        const previous = el.value;
        el.focus();
        try { el.setSelectionRange(start, end); } catch (err) { return false; }

        // execCommand keeps the browser's native undo history intact and emits
        // the beforeinput/input pair that frameworks listen for.
        let ok = false;
        try { ok = document.execCommand('insertText', false, replacement); } catch (err) { ok = false; }
        if (ok && el.value !== previous) return true;

        const proto = el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        const next = previous.slice(0, start) + replacement + previous.slice(end);
        if (descriptor && descriptor.set) descriptor.set.call(el, next);
        else el.value = next;

        const caret = start + replacement.length;
        try { el.setSelectionRange(caret, caret); } catch (err) { /* ignore */ }
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return el.value !== previous;
      }
    };
  }

  /* -------------------------------------------------------- contenteditable */

  function buildMap(host) {
    const segments = [];
    let text = '';
    let budget = MAX_WALK_NODES;

    const walker = document.createTreeWalker(
      host,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: function (node) {
          if (node.nodeType === 1) {
            const tag = node.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
              return NodeFilter.FILTER_REJECT;
            }
            if (node.hidden || node.style.display === 'none') return NodeFilter.FILTER_REJECT;
            if (node.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
            if (node.hasAttribute('data-blue-pencil-ui')) return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let node;
    while ((node = walker.nextNode()) && budget-- > 0) {
      if (node.nodeType === 1) {
        if (node.tagName === 'BR') {
          text += '\n';
        } else if (BLOCK_TAGS.has(node.tagName) && text.length && !text.endsWith('\n')) {
          text += '\n';
        }
        continue;
      }
      const data = node.data || '';
      if (!data) continue;
      const parent = node.parentElement;
      const editable = parent ? parent.isContentEditable : false;
      segments.push({ node: node, start: text.length, end: text.length + data.length, editable: editable });
      text += data;
    }

    return { text: text, segments: segments };
  }

  function createContentEditableAdapter(host) {
    let map = buildMap(host);

    function ensure() {
      return map;
    }

    function positionAt(offset) {
      const segments = map.segments;
      if (!segments.length) return { node: host, offset: 0 };
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (offset < seg.end || (offset === seg.end && i === segments.length - 1)) {
          return { node: seg.node, offset: Math.max(0, Math.min(seg.node.data.length, offset - seg.start)) };
        }
        if (offset === seg.end) {
          // Prefer staying at the end of this segment over jumping past a
          // virtual newline into the next block.
          const next = segments[i + 1];
          if (!next || next.start > seg.end) {
            return { node: seg.node, offset: seg.node.data.length };
          }
        }
        if (offset < seg.start) {
          return { node: seg.node, offset: 0 };
        }
      }
      const last = segments[segments.length - 1];
      return { node: last.node, offset: last.node.data.length };
    }

    function offsetOfNode(node, nodeOffset) {
      const segments = map.segments;
      if (node.nodeType === 3) {
        for (let i = 0; i < segments.length; i++) {
          if (segments[i].node === node) return segments[i].start + nodeOffset;
        }
      }
      const child = node.childNodes ? node.childNodes[nodeOffset] : null;
      const reference = child || node;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.node === reference || reference.contains(seg.node)) return seg.start;
        const position = reference.compareDocumentPosition(seg.node);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return seg.start;
      }
      return map.text.length;
    }

    function rangeFor(start, end) {
      const from = positionAt(start);
      const to = positionAt(end);
      const range = document.createRange();
      try {
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
      } catch (err) {
        return null;
      }
      return range;
    }

    return {
      el: host,
      kind: 'ce',
      multiline: true,
      getText: function () { return ensure().text; },
      refresh: function () { map = buildMap(host); },
      rangeFor: rangeFor,
      getSelection: function () {
        const selection = (host.ownerDocument || document).getSelection();
        if (!selection || !selection.rangeCount) return null;
        const range = selection.getRangeAt(0);
        if (!host.contains(range.startContainer)) return null;
        return {
          start: offsetOfNode(range.startContainer, range.startOffset),
          end: offsetOfNode(range.endContainer, range.endOffset)
        };
      },
      setSelection: function (start, end) {
        const range = rangeFor(start, end);
        if (!range) return;
        const selection = (host.ownerDocument || document).getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      },
      isEditableRange: function (start, end) {
        const segments = map.segments;
        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          if (seg.start < end && seg.end > start && !seg.editable) return false;
        }
        return true;
      },
      replaceRange: function (start, end, replacement) {
        const before = map.text;
        const range = rangeFor(start, end);
        if (!range) return false;

        host.focus();
        const selection = (host.ownerDocument || document).getSelection();
        selection.removeAllRanges();
        selection.addRange(range);

        let ok = false;
        try { ok = document.execCommand('insertText', false, replacement); } catch (err) { ok = false; }

        if (!ok) {
          try {
            range.deleteContents();
            const textNode = document.createTextNode(replacement);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            host.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              composed: true,
              inputType: 'insertText',
              data: replacement
            }));
          } catch (err) {
            return false;
          }
        }

        map = buildMap(host);
        return map.text !== before;
      }
    };
  }

  function adapt(el, extraSelectors) {
    if (!isEligible(el, extraSelectors)) return null;
    const host = editingHost(el);
    if (host.tagName === 'TEXTAREA' || host.tagName === 'INPUT') return createInputAdapter(host);
    if (!isEligible(host, extraSelectors)) return null;
    return createContentEditableAdapter(host);
  }

  BP.Editor = {
    adapt: adapt,
    isEligible: isEligible,
    editingHost: editingHost
  };
})(typeof self !== 'undefined' ? self : this);
