/* Blue Pencil - service worker.

   Every request to Ollama happens here. Content scripts cannot fetch localhost
   from an https page (mixed content, CORS, and the page's own CSP all get in
   the way), but the worker holds the host permission and is exempt. */

importScripts('../lib/defaults.js', '../lib/prompt.js', '../lib/ollama.js');

const BP = self.BP;

/* ---------------------------------------------------------- origin header

   Ollama answers 403 to any request carrying an `Origin: chrome-extension://…`
   header, so out of the box every call from an extension is refused. Rather
   than asking the user to restart their server with OLLAMA_ORIGINS set, we
   drop the Origin header from our own requests. The rule is scoped to
   tabIds [-1] - requests with no tab, which is only ever the worker itself -
   so nothing a page does is touched. */

const ORIGIN_RULE_ID = 1;

async function installOriginRule() {
  const settings = await BP.getSettings();
  const endpoint = BP.normalizeEndpoint(settings.endpoint);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ORIGIN_RULE_ID],
      addRules: [{
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Origin', operation: 'remove' }]
        },
        condition: {
          urlFilter: '|' + endpoint + '/',
          resourceTypes: ['xmlhttprequest', 'other'],
          tabIds: [-1]
        }
      }]
    });
  } catch (err) {
    // Not fatal: the user can still allow the extension via OLLAMA_ORIGINS.
    console.warn('Blue Pencil: could not adjust the Origin header —', err);
  }
}

let rulesReady = installOriginRule();

/* --------------------------------------------------------------- caching */

const CACHE_LIMIT = 80;
const cache = new Map();

function cacheKey(settings, kind, text) {
  // Every input that changes the answer belongs in the key, or switching one
  // of them appears to do nothing because the old answer comes straight back.
  return [
    kind,
    settings.model,
    settings.thinkingEffort,
    settings.numCtx,
    settings.dialect,
    settings.customInstructions,
    Object.keys(settings.categories).filter(function (c) { return settings.categories[c]; }).join(','),
    text
  ].join('');
}

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}

/* ------------------------------------------------------ request tracking */

const inFlight = new Map();

function trackerKey(sender) {
  const tabId = sender && sender.tab ? sender.tab.id : 'x';
  const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
  return tabId + ':' + frameId;
}

function beginRequest(sender) {
  const key = trackerKey(sender);
  const previous = inFlight.get(key);
  if (previous) previous.abort(new DOMException('superseded', 'AbortError'));
  const controller = new AbortController();
  inFlight.set(key, controller);
  return { key: key, controller: controller };
}

function endRequest(key, controller) {
  if (inFlight.get(key) === controller) inFlight.delete(key);
}

/* ------------------------------------------------------------ model pick */

/** Choose a sensible default the first time, so the extension works at once. */
function pickDefaultModel(models) {
  if (!models.length) return '';
  const local = models.filter(function (m) { return !m.remote; });
  const pool = local.length ? local : models;
  const preferred = ['llama3.2', 'llama3.1', 'qwen2.5', 'qwen3', 'mistral', 'gemma3', 'gemma4', 'phi4'];
  for (let i = 0; i < preferred.length; i++) {
    const hit = pool.find(function (m) { return m.name.toLowerCase().indexOf(preferred[i]) === 0; });
    if (hit) return hit.name;
  }
  // Otherwise the smallest local model, which will be the quickest to answer.
  const bySize = pool.slice().sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
  return bySize[0].name;
}

async function ensureModel(settings) {
  if (settings.model) return settings;
  const models = await BP.ollama.tags(settings.endpoint);
  const choice = pickDefaultModel(models);
  if (!choice) {
    throw new BP.ollama.OllamaError(
      'No models are installed in Ollama.',
      'no_models',
      'Install one, for example: ollama pull llama3.2'
    );
  }
  await BP.setSettings({ model: choice });
  settings.model = choice;
  return settings;
}

function toErrorPayload(err) {
  if (err && err.name === 'AbortError') {
    return { message: 'Cancelled.', code: 'aborted' };
  }
  if (err instanceof BP.ollama.OllamaError) {
    return { message: err.message, code: err.code, detail: err.detail || '' };
  }
  return { message: String((err && err.message) || err || 'Unknown error'), code: 'error' };
}

/* --------------------------------------------------------------- actions */

async function handleCheck(message, sender) {
  const settings = await ensureModel(await BP.getSettings());
  const text = String(message.text || '');
  if (!text.trim()) return { edits: [] };

  const key = cacheKey(settings, 'check', text);
  const cached = cacheGet(key);
  if (cached) return { edits: cached, cached: true };

  const tracked = beginRequest(sender);
  try {
    const request = {
      settings: settings,
      model: settings.model,
      messages: BP.buildCheckMessages(text, settings),
      format: BP.EDIT_SCHEMA,
      signal: tracked.controller.signal
    };

    let result = await BP.ollama.chat(request);
    let parsed = BP.ollama.parseJsonLoose(result.content);

    /* Thinking can break a model either way round: some answer with nothing at
       all when told not to think, while others ramble past any usable answer
       when allowed to. Whichever way it failed, try once the other way. */
    if (!parsed) {
      const retry = settings.thinkingEffort === 'off'
        ? Object.assign({}, request, { allowThinking: true })
        : Object.assign({}, request, {
          settings: Object.assign({}, settings, { thinkingEffort: 'off' })
        });
      result = await BP.ollama.chat(retry);
      parsed = BP.ollama.parseJsonLoose(result.content);
    }

    if (!parsed || !Array.isArray(parsed.edits)) {
      // Never cache this, and never report it as "no issues found" - a silent
      // clean result on text full of mistakes is worse than an error.
      throw new BP.ollama.OllamaError(
        'The model did not return a usable answer.',
        'bad_response',
        settings.model + ' replied with something Blue Pencil could not read. ' +
        'Try again, or choose a different model.'
      );
    }

    let edits = parsed.edits.slice(0, 40).map(function (edit) {
      return {
        before: String(edit && edit.before || ''),
        after: String(edit && edit.after || ''),
        category: String(edit && edit.category || 'grammar').toLowerCase(),
        reason: String(edit && edit.reason || '')
      };
    });

    cacheSet(key, edits);
    return { edits: edits, model: result.model, ms: result.evalDurationMs };
  } finally {
    endRequest(tracked.key, tracked.controller);
  }
}

function cleanRewrite(raw) {
  let text = BP.ollama.stripFences(BP.ollama.stripThinking(raw));
  text = text.replace(/^<<<TEXT\s*/i, '').replace(/\s*TEXT>>>$/i, '');
  // Models like to hand back the whole thing wrapped in quotes.
  const quoted = /^"([\s\S]+)"$/.exec(text) || /^'([\s\S]+)'$/.exec(text);
  if (quoted) text = quoted[1];
  return text.trim();
}

async function handleRewrite(message, sender) {
  const settings = await ensureModel(await BP.getSettings());
  const preset = BP.REWRITE_PRESETS[message.preset];
  const instruction = preset ? preset.instruction : String(message.instruction || '');
  const text = String(message.text || '');
  if (!text.trim() || !instruction) {
    return { error: { message: 'Nothing to rewrite.', code: 'empty' } };
  }

  const tracked = beginRequest(sender);
  try {
    const result = await BP.ollama.chat({
      settings: settings,
      model: settings.model,
      messages: BP.buildRewriteMessages(text, instruction, settings),
      format: BP.REWRITE_SCHEMA,
      temperature: 0.3,
      signal: tracked.controller.signal
    });

    // The schema keeps a model's reasoning out of the answer. If it ignored
    // the schema anyway, fall back to salvaging the raw reply.
    const parsed = BP.ollama.parseJsonLoose(result.content);
    const rewritten = parsed && typeof parsed.text === 'string'
      ? parsed.text.trim()
      : cleanRewrite(result.content);
    if (!rewritten) {
      return { error: { message: 'The model returned an empty rewrite.', code: 'empty' } };
    }
    return { text: rewritten, model: result.model, ms: result.evalDurationMs };
  } finally {
    endRequest(tracked.key, tracked.controller);
  }
}

/* The cloud catalogue changes rarely and lives on ollama.com, so it is cached
   rather than fetched every time the settings page opens. */
const CLOUD_CACHE_KEY = 'cloudCatalog';
const CLOUD_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

async function readCloudCache() {
  try {
    const stored = await chrome.storage.local.get(CLOUD_CACHE_KEY);
    const entry = stored && stored[CLOUD_CACHE_KEY];
    if (!entry || !Array.isArray(entry.models)) return null;
    if (Date.now() - (entry.at || 0) > CLOUD_CACHE_TTL_MS) return null;
    return entry.models;
  } catch (err) {
    return null;
  }
}

async function getCloudModels(force) {
  if (!force) {
    const cached = await readCloudCache();
    if (cached) return { models: cached, cached: true };
  }
  const models = await BP.ollama.cloudCatalog();
  try {
    await chrome.storage.local.set({ [CLOUD_CACHE_KEY]: { at: Date.now(), models: models } });
  } catch (err) { /* cache is best effort */ }
  return { models: models, cached: false };
}

/**
 * Merge what is installed locally with the cloud catalogue.
 * A cloud model already present in `ollama list` must not appear twice.
 */
function mergeModels(installed, cloud) {
  const local = installed.filter(function (m) { return !m.remote; });
  const byName = new Map();

  installed.filter(function (m) { return m.remote; }).forEach(function (m) {
    byName.set(m.name, Object.assign({}, m, { installed: true }));
  });
  (cloud || []).forEach(function (m) {
    // A cloud model's local entry is a pointer whose "size" describes the
    // remote model, so the catalogue's figures are the ones worth showing.
    const existing = byName.get(m.name);
    byName.set(m.name, existing ? Object.assign({}, existing, m, { installed: true }) : m);
  });

  const sortByName = function (a, b) { return a.name.localeCompare(b.name); };
  return {
    local: local.slice().sort(sortByName),
    cloud: Array.from(byName.values()).sort(sortByName)
  };
}

async function handleStatus(message) {
  const settings = await BP.getSettings();
  const status = { settings: settings, ollama: { ok: false } };

  try {
    const version = await BP.ollama.version(settings.endpoint);
    const installed = await BP.ollama.tags(settings.endpoint);

    let cloud = [];
    let cloudError = null;
    if (settings.showCloudModels) {
      try {
        const result = await getCloudModels(message && message.refreshCloud);
        cloud = result.models;
      } catch (err) {
        // Offline, or ollama.com unreachable: local models still work.
        cloudError = toErrorPayload(err);
      }
    }

    const merged = mergeModels(installed, cloud);
    status.ollama = {
      ok: true,
      version: version,
      models: installed,
      local: merged.local,
      cloud: merged.cloud,
      cloudError: cloudError,
      account: await BP.ollama.account(settings.endpoint)
    };

    if (!settings.model && installed.length) {
      const choice = pickDefaultModel(installed);
      await BP.setSettings({ model: choice });
      status.settings.model = choice;
    }
  } catch (err) {
    status.ollama = { ok: false, error: toErrorPayload(err) };
  }
  return status;
}

/* Loading a large model can take minutes. Warm it the moment a field is
   focused so the first real check does not sit behind that load. */
let lastWarm = { model: '', at: 0 };
const WARM_INTERVAL_MS = 4 * 60 * 1000;

async function handleWarmup() {
  const settings = await ensureModel(await BP.getSettings());
  if (!settings.enabled) return { ok: false, skipped: true };
  // Nothing is loaded locally for a cloud model, so there is nothing to warm.
  if (/[:-]cloud$/.test(settings.model)) return { ok: true, skipped: true };

  const now = Date.now();
  if (lastWarm.model === settings.model && now - lastWarm.at < WARM_INTERVAL_MS) {
    return { ok: true, skipped: true };
  }
  lastWarm = { model: settings.model, at: now };
  try {
    await BP.ollama.preload(settings, settings.model);
    return { ok: true };
  } catch (err) {
    lastWarm.at = 0;
    return { ok: false, error: toErrorPayload(err) };
  }
}

const HANDLERS = {
  check: handleCheck,
  rewrite: handleRewrite,
  status: handleStatus,
  warmup: handleWarmup,
  'open-options': async function () {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  const handler = message && HANDLERS[message.type];
  if (!handler) return false;

  Promise.resolve(rulesReady)
    .then(function () { return handler(message, sender); })
    .then(function (result) { sendResponse(result); })
    .catch(function (err) { sendResponse({ error: toErrorPayload(err) }); });

  return true; // keep the message channel open for the async reply
});

/* -------------------------------------------------------------- lifecycle */

async function updateBadge() {
  const settings = await BP.getSettings();
  try {
    await chrome.action.setBadgeText({ text: settings.enabled ? '' : 'off' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  } catch (err) { /* action API unavailable during startup */ }
}

chrome.runtime.onInstalled.addListener(function (details) {
  updateBadge();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'sync') return;
  if (changes.enabled) updateBadge();
  if (changes.endpoint || changes.model) cache.clear();
  if (changes.endpoint) rulesReady = installOriginRule();
});

chrome.commands.onCommand.addListener(async function (command) {
  if (command === 'toggle-enabled') {
    const settings = await BP.getSettings();
    await BP.setSettings({ enabled: !settings.enabled });
    return;
  }
  if (command === 'check-now') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return;
    try {
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'command', command: 'check-now' });
    } catch (err) { /* no content script on this page */ }
  }
});
