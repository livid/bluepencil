/* Blue Pencil - shared settings. Loaded as a classic script by the service
   worker (importScripts), the extension pages (<script src>) and the content
   script (manifest content_scripts), so it must not use ES module syntax. */
(function (root) {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    autoCheck: true,

    endpoint: 'http://localhost:11434',
    model: '',
    showCloudModels: true,
    keepAlive: '30m',
    temperature: 0,
    numCtx: 8192,
    thinkingEffort: 'off',
    timeoutMs: 150000,

    checkDelayMs: 900,
    minChars: 12,
    maxChars: 6000,

    categories: {
      spelling: true,
      grammar: true,
      punctuation: true,
      style: true,
      clarity: true
    },
    dialect: 'auto',
    customInstructions: '',

    showUnderlines: true,
    showButton: true,

    disabledSites: [],
    excludeSelectors: ''
  };

  const CATEGORY_LABELS = {
    spelling: 'Spelling',
    grammar: 'Grammar',
    punctuation: 'Punctuation',
    style: 'Style',
    clarity: 'Clarity'
  };

  // Categories that are corrections (red) vs improvements (blue).
  const CORRECTION_CATEGORIES = ['spelling', 'grammar', 'punctuation'];

  /* How hard the model should think before answering. Ollama takes this as the
     `think` field: false, or one of the levels for models that support them.
     "model" leaves the field off entirely and lets the model decide. */
  const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'model'];

  const EFFORT_LABELS = {
    off: 'Off — fastest',
    low: 'Low',
    medium: 'Medium',
    high: 'High — slowest',
    model: 'Whatever the model does by default'
  };

  /* The rewrite menu. Lives here rather than with the other prompt text
     because the content script renders these labels and never loads
     prompt.js, which is only needed where requests are actually built. */
  const REWRITE_PRESETS = {
    fix: {
      label: 'Fix spelling & grammar',
      instruction: 'Correct every spelling, grammar, punctuation and capitalization error. Change nothing else - keep the wording, tone, length and formatting exactly as they are.'
    },
    improve: {
      label: 'Improve writing',
      instruction: 'Rewrite so it reads clearly and naturally. Fix errors and tighten clumsy phrasing while keeping the voice of the author and every fact. Keep roughly the same length.'
    },
    shorten: {
      label: 'Make it shorter',
      instruction: 'Rewrite to be noticeably shorter while keeping every point that matters. Cut filler, not content.'
    },
    formal: {
      label: 'Make it formal',
      instruction: 'Rewrite in a professional register suitable for work correspondence. No slang, no contractions. Keep the meaning and the length.'
    },
    casual: {
      label: 'Make it friendly',
      instruction: 'Rewrite in a warm, conversational register, as if writing to a colleague you know well. Keep the meaning and the length.'
    }
  };

  function normalizeEndpoint(raw) {
    let value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) return DEFAULTS.endpoint;
    if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
    return value;
  }

  function isLocalEndpoint(endpoint) {
    try {
      const host = new URL(normalizeEndpoint(endpoint)).hostname;
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    } catch (err) {
      return false;
    }
  }

  function merge(stored) {
    const out = Object.assign({}, DEFAULTS, stored || {});
    out.categories = Object.assign({}, DEFAULTS.categories, (stored && stored.categories) || {});
    out.disabledSites = Array.isArray(out.disabledSites) ? out.disabledSites : [];
    out.endpoint = normalizeEndpoint(out.endpoint);

    // Carried over from the earlier on/off thinking switch.
    if (stored && stored.thinkingEffort === undefined && stored.disableThinking !== undefined) {
      out.thinkingEffort = stored.disableThinking ? 'off' : 'model';
    }
    if (EFFORT_LEVELS.indexOf(out.thinkingEffort) === -1) {
      out.thinkingEffort = DEFAULTS.thinkingEffort;
    }
    return out;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.sync.get(null, function (stored) {
          if (chrome.runtime.lastError) return resolve(merge(null));
          resolve(merge(stored));
        });
      } catch (err) {
        resolve(merge(null));
      }
    });
  }

  function setSettings(patch) {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.set(patch, function () {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    });
  }

  function onSettingsChanged(callback) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      getSettings().then(callback);
    });
  }

  function siteDisabled(settings, hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^www\./, '');
    return (settings.disabledSites || []).some(function (entry) {
      const clean = String(entry).toLowerCase().replace(/^www\./, '');
      return clean === host || host.endsWith('.' + clean);
    });
  }

  root.BP = root.BP || {};
  root.BP.DEFAULTS = DEFAULTS;
  root.BP.CATEGORY_LABELS = CATEGORY_LABELS;
  root.BP.CORRECTION_CATEGORIES = CORRECTION_CATEGORIES;
  root.BP.REWRITE_PRESETS = REWRITE_PRESETS;
  root.BP.EFFORT_LEVELS = EFFORT_LEVELS;
  root.BP.EFFORT_LABELS = EFFORT_LABELS;
  root.BP.normalizeEndpoint = normalizeEndpoint;
  root.BP.isLocalEndpoint = isLocalEndpoint;
  root.BP.mergeSettings = merge;
  root.BP.getSettings = getSettings;
  root.BP.setSettings = setSettings;
  root.BP.onSettingsChanged = onSettingsChanged;
  root.BP.siteDisabled = siteDisabled;
})(typeof self !== 'undefined' ? self : this);
