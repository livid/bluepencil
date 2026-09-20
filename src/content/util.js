/* Blue Pencil - text utilities and the edit anchoring engine.

   The model returns edits as {before, after}. It never returns offsets, because
   language models are unreliable at counting characters. Instead we re-find the
   `before` span in the text we actually have on screen, which also means an edit
   still lands correctly if the user kept typing while the model was thinking. */
(function (root) {
  'use strict';

  const BP = root.BP = root.BP || {};

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function debounce(fn, waitMs) {
    let timer = null;
    const wrapped = function () {
      const args = arguments;
      const self = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, waitMs);
    };
    wrapped.cancel = function () { clearTimeout(timer); timer = null; };
    wrapped.flush = function () { clearTimeout(timer); fn.apply(this, arguments); };
    return wrapped;
  }

  function hashString(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  const QUOTE_CLASSES = [
    { chars: "‘’‛'´ʼ", pattern: "[‘’‛'´ʼ]" },
    { chars: '“”‟"', pattern: '[“”‟"]' },
    { chars: '–—−-', pattern: '[–—−-]' },
    { chars: '…', pattern: '(?:…|\\.\\.\\.)' }
  ];

  function charPattern(ch) {
    for (let i = 0; i < QUOTE_CLASSES.length; i++) {
      if (QUOTE_CLASSES[i].chars.indexOf(ch) !== -1) return QUOTE_CLASSES[i].pattern;
    }
    return escapeRegExp(ch);
  }

  /* A tolerant pattern for `before`: whitespace runs collapse, and typographic
     variants of quotes, dashes and ellipses are treated as interchangeable,
     because models silently normalize them. */
  function tolerantPattern(before) {
    let out = '';
    for (let i = 0; i < before.length; i++) {
      const ch = before[i];
      if (/\s/.test(ch)) {
        while (i + 1 < before.length && /\s/.test(before[i + 1])) i++;
        out += '\\s+';
      } else {
        out += charPattern(ch);
      }
    }
    return out;
  }

  const WORD_CHAR = /[\p{L}\p{N}_]/u;

  function isWordBoundaryMatch(text, start, end, before) {
    const startsWord = before.length > 0 && WORD_CHAR.test(before[0]);
    const endsWord = before.length > 0 && WORD_CHAR.test(before[before.length - 1]);
    if (startsWord && start > 0 && WORD_CHAR.test(text[start - 1])) return false;
    if (endsWord && end < text.length && WORD_CHAR.test(text[end])) return false;
    return true;
  }

  function overlaps(start, end, taken) {
    for (let i = 0; i < taken.length; i++) {
      if (start < taken[i].end && end > taken[i].start) return true;
    }
    return false;
  }

  function collectMatches(text, pattern, flags) {
    const out = [];
    let regex;
    try {
      regex = new RegExp(pattern, flags.indexOf('g') === -1 ? flags + 'g' : flags);
    } catch (err) {
      return out;
    }
    let match;
    let guard = 0;
    while ((match = regex.exec(text)) !== null && guard++ < 500) {
      if (match[0].length === 0) { regex.lastIndex++; continue; }
      out.push({ start: match.index, end: match.index + match[0].length });
    }
    return out;
  }

  /**
   * Find where `before` lives in `text`, avoiding spans already claimed.
   * Tries strictest strategy first and only then loosens.
   * `near` biases toward the occurrence closest to a hint offset.
   */
  function anchor(text, before, taken, near) {
    if (!before) return null;
    const attempts = [
      { pattern: escapeRegExp(before), flags: '', boundary: true },
      { pattern: tolerantPattern(before), flags: 'u', boundary: true },
      { pattern: tolerantPattern(before), flags: 'iu', boundary: true },
      { pattern: tolerantPattern(before), flags: 'iu', boundary: false }
    ];

    for (let a = 0; a < attempts.length; a++) {
      const attempt = attempts[a];
      const matches = collectMatches(text, attempt.pattern, attempt.flags);
      let best = null;
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        if (overlaps(m.start, m.end, taken)) continue;
        if (attempt.boundary && !isWordBoundaryMatch(text, m.start, m.end, before)) continue;
        if (best === null) { best = m; continue; }
        if (typeof near === 'number' &&
            Math.abs(m.start - near) < Math.abs(best.start - near)) {
          best = m;
        }
      }
      if (best) return best;
    }
    return null;
  }

  function sameIgnoringInvisibles(a, b) {
    const norm = function (s) { return String(s).replace(/\s+/g, ' ').trim(); };
    return norm(a) === norm(b);
  }

  /**
   * Turn raw model edits into positioned suggestions against `text`.
   * Anything that cannot be verified against the real text is dropped.
   */
  function locateEdits(text, edits, options) {
    const opts = options || {};
    const allowed = opts.categories || null;
    const taken = [];
    const out = [];

    for (let i = 0; i < (edits || []).length; i++) {
      const edit = edits[i] || {};
      const before = typeof edit.before === 'string' ? edit.before : '';
      const after = typeof edit.after === 'string' ? edit.after : '';
      const category = String(edit.category || 'grammar').toLowerCase();

      if (!before.trim()) continue;
      if (sameIgnoringInvisibles(before, after)) continue;
      if (before.length > 400) continue;
      // A "before" covering nearly the whole text is a rewrite, not an edit.
      if (text.length > 120 && before.length > text.length * 0.9) continue;
      // Guard against a model that pads the replacement with commentary.
      if (after.length > before.length * 6 + 120) continue;
      if (allowed && allowed.indexOf(category) === -1) continue;

      const hit = anchor(text, before, taken, typeof edit.hint === 'number' ? edit.hint : undefined);
      if (!hit) continue;

      const actual = text.slice(hit.start, hit.end);
      if (sameIgnoringInvisibles(actual, after)) continue;

      taken.push(hit);
      out.push({
        id: hashString(category + '|' + actual + '|' + after + '|' + hit.start),
        start: hit.start,
        end: hit.end,
        before: actual,
        after: after,
        category: category,
        reason: String(edit.reason || '').slice(0, 200)
      });
    }

    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /** Trim the shared prefix/suffix so the card shows only what changes. */
  function diffParts(before, after) {
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before[start] === after[start]) start++;
    // Back up to a word boundary so we never split mid-word in the UI.
    while (start > 0 && WORD_CHAR.test(before[start - 1] || '') && WORD_CHAR.test(before[start] || '')) start--;

    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
      endBefore--;
      endAfter--;
    }
    while (endBefore < before.length && WORD_CHAR.test(before[endBefore - 1] || '') && WORD_CHAR.test(before[endBefore] || '')) {
      endBefore++;
      endAfter++;
    }

    return {
      prefix: before.slice(0, start),
      removed: before.slice(start, endBefore),
      added: after.slice(start, endAfter),
      suffix: before.slice(endBefore)
    };
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  BP.util = {
    escapeHtml: escapeHtml,
    escapeRegExp: escapeRegExp,
    debounce: debounce,
    hashString: hashString,
    anchor: anchor,
    locateEdits: locateEdits,
    diffParts: diffParts,
    clamp: clamp
  };
})(typeof self !== 'undefined' ? self : this);
