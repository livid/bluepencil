/* Blue Pencil - thin Ollama HTTP client.
   Only ever called from the service worker, which holds the host permission
   for localhost, so the page's CSP and CORS rules never apply. */
(function (root) {
  'use strict';

  const BP = root.BP = root.BP || {};

  class OllamaError extends Error {
    constructor(message, code, detail) {
      super(message);
      this.name = 'OllamaError';
      this.code = code || 'error';
      this.detail = detail || '';
    }
  }

  function url(endpoint, path) {
    return BP.normalizeEndpoint(endpoint) + path;
  }

  // Chains an external abort signal with a timeout into one signal.
  function withTimeout(timeoutMs, external) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort(new DOMException('timeout', 'TimeoutError'));
    }, Math.max(1000, timeoutMs || 60000));

    function onExternalAbort() { controller.abort(external.reason); }
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    return {
      signal: controller.signal,
      done: function () {
        clearTimeout(timer);
        if (external) external.removeEventListener('abort', onExternalAbort);
      }
    };
  }

  function describeNetworkError(label, err) {
    if (err && err.name === 'TimeoutError') {
      return new OllamaError(
        'The model took too long to answer.',
        'timeout',
        'A model being loaded for the first time is slow. Try again, or pick a ' +
        'smaller model or a longer timeout in settings.'
      );
    }
    if (err && err.name === 'AbortError') {
      return new OllamaError('Cancelled.', 'aborted');
    }
    return new OllamaError(
      'Cannot reach Ollama at ' + label + '.',
      'unreachable',
      'Start it with "ollama serve", then check the endpoint in Blue Pencil settings.'
    );
  }

  async function readError(response) {
    let body = '';
    try { body = await response.text(); } catch (err) { /* ignore */ }
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed && parsed.error) message = parsed.error;
    } catch (err) { /* body was not JSON */ }
    return String(message || ('HTTP ' + response.status)).slice(0, 400);
  }

  async function requestUrl(target, init, timeoutMs, signal, label) {
    const gate = withTimeout(timeoutMs, signal);
    let response;
    try {
      response = await fetch(target, Object.assign({ signal: gate.signal }, init));
    } catch (err) {
      gate.done();
      throw describeNetworkError(label || target, err);
    }

    if (!response.ok) {
      const message = await readError(response);
      gate.done();
      if (response.status === 404 && /model|not found|pull/i.test(message)) {
        throw new OllamaError(message, 'model_missing');
      }
      if (response.status === 403) {
        throw new OllamaError(
          'Ollama refused the request (403).',
          'forbidden',
          'Allow extensions with: OLLAMA_ORIGINS="chrome-extension://*" ollama serve'
        );
      }
      throw new OllamaError(message, 'http_' + response.status);
    }

    try {
      return await response.json();
    } finally {
      gate.done();
    }
  }

  function request(endpoint, path, init, timeoutMs, signal) {
    const base = BP.normalizeEndpoint(endpoint);
    return requestUrl(base + path, init, timeoutMs, signal, base);
  }

  async function tags(endpoint, timeoutMs) {
    const data = await request(endpoint, '/api/tags', { method: 'GET' }, timeoutMs || 8000);
    const models = Array.isArray(data && data.models) ? data.models : [];
    return models.map(function (m) {
      return {
        name: m.name || m.model,
        size: m.size || 0,
        remote: Boolean(m.remote_host || /[:-]cloud$/.test(m.name || '')),
        installed: true,
        family: (m.details && m.details.family) || '',
        parameters: (m.details && m.details.parameter_size) || '',
        capabilities: m.capabilities || []
      };
    }).filter(function (m) { return m.name; });
  }

  /* Ollama Cloud ------------------------------------------------------------

     The local server only lists models you already have, so the catalogue of
     cloud models comes from ollama.com. A cloud model is addressed by suffixing
     the catalogue name: "glm-5.3" becomes "glm-5.3:cloud", and a name that
     already carries a tag becomes "gpt-oss:20b-cloud". Ollama resolves those
     names on the fly - there is nothing to pull first. */

  const CLOUD_CATALOG_URL = 'https://ollama.com/api/tags';

  function toCloudName(catalogName) {
    const name = String(catalogName || '').trim();
    if (!name) return '';
    if (/[:-]cloud$/.test(name)) return name;
    return name.indexOf(':') === -1 ? name + ':cloud' : name + '-cloud';
  }

  async function cloudCatalog(timeoutMs) {
    const data = await requestUrl(CLOUD_CATALOG_URL, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-cache'
    }, timeoutMs || 10000, null, 'ollama.com');

    const models = Array.isArray(data && data.models) ? data.models : [];
    return models.map(function (m) {
      const catalogName = m.name || m.model || '';
      return {
        name: toCloudName(catalogName),
        catalogName: catalogName,
        size: m.size || 0,
        remote: true,
        installed: false,
        family: (m.details && m.details.family) || '',
        parameters: (m.details && m.details.parameter_size) || '',
        capabilities: m.capabilities || []
      };
    }).filter(function (m) { return m.name; });
  }

  /** Who the local Ollama is signed in as, or null. Cloud models need this. */
  async function account(endpoint, timeoutMs) {
    try {
      const data = await request(endpoint, '/api/me', { method: 'POST' }, timeoutMs || 6000);
      if (!data || (!data.email && !data.name)) return null;
      return { name: data.name || '', email: data.email || '', plan: data.plan || '' };
    } catch (err) {
      return null;
    }
  }

  async function version(endpoint, timeoutMs) {
    const data = await request(endpoint, '/api/version', { method: 'GET' }, timeoutMs || 6000);
    return (data && data.version) || 'unknown';
  }

  /* Reasoning models leak their working into `content` in two shapes: a matched
     <think>…</think> block, or - more often, because Ollama eats the opening
     tag - raw reasoning that simply ends at a stray </think>. Everything before
     that last closing tag is working, not answer. */
  function stripThinking(text) {
    let out = String(text || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');

    const orphan = /<\/think(?:ing)?>/gi;
    let last = -1;
    let match;
    while ((match = orphan.exec(out)) !== null) last = match.index + match[0].length;
    if (last !== -1) out = out.slice(last);

    return out.trim();
  }

  function stripFences(text) {
    const match = /```(?:json|markdown|text)?\s*([\s\S]*?)```/i.exec(text);
    return match ? match[1].trim() : text.trim();
  }

  // Models sometimes wrap JSON in prose even with a schema; salvage the object.
  // Candidate openings are tried from the end, because when a model narrates
  // before answering, the real answer is the last object in the reply.
  function parseJsonLoose(raw) {
    const text = stripFences(stripThinking(raw));
    if (!text) return null;
    try { return JSON.parse(text); } catch (err) { /* fall through */ }

    const end = text.lastIndexOf('}');
    if (end === -1) return null;

    let start = text.lastIndexOf('{');
    let guard = 0;
    while (start !== -1 && guard++ < 50) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch (err) { /* keep looking */ }
      start = text.lastIndexOf('{', start - 1);
    }
    return null;
  }

  /**
   * POST /api/chat with stream disabled.
   * Retries once without `think` for models that reject the field.
   */
  async function chat(options) {
    const settings = options.settings;
    const body = {
      model: options.model,
      messages: options.messages,
      stream: false,
      keep_alive: settings.keepAlive || '30m',
      options: {
        temperature: typeof options.temperature === 'number' ? options.temperature : (settings.temperature || 0),
        num_ctx: settings.numCtx || 8192
      }
    };
    if (options.format) body.format = options.format;

    /* `think` carries the effort level: false to skip reasoning, a level for
       models that grade it, or absent to leave the choice to the model.
       allowThinking overrides "off" for the one retry we make when a model
       answers with nothing at all. */
    const effort = options.allowThinking && settings.thinkingEffort === 'off'
      ? 'model'
      : settings.thinkingEffort;
    if (effort === 'off') body.think = false;
    else if (effort && effort !== 'model') body.think = effort;

    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    };

    let data;
    try {
      data = await request(settings.endpoint, '/api/chat', init, settings.timeoutMs, options.signal);
    } catch (err) {
      // Some models reject the `think` field, or a graded level; drop it and retry.
      const rejectsThink = body.think !== undefined &&
        err instanceof OllamaError &&
        /think/i.test(err.message || '');
      if (!rejectsThink) throw err;
      delete body.think;
      init.body = JSON.stringify(body);
      data = await request(settings.endpoint, '/api/chat', init, settings.timeoutMs, options.signal);
    }

    const content = (data && data.message && data.message.content) || '';
    const thinking = (data && data.message && data.message.thinking) || '';
    return {
      content: stripThinking(content),
      raw: content,
      thinkingChars: thinking.length,
      model: (data && data.model) || options.model,
      evalDurationMs: data && data.total_duration ? Math.round(data.total_duration / 1e6) : 0
    };
  }

  /**
   * Ask Ollama to load a model into memory without generating anything.
   * A cold 12B model can take minutes to load; doing it when the user focuses
   * a field means the load overlaps with them typing their first sentence.
   */
  async function preload(settings, model) {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: '',
        stream: false,
        keep_alive: settings.keepAlive || '30m'
      })
    };
    return request(settings.endpoint, '/api/generate', init, Math.max(settings.timeoutMs, 120000));
  }

  BP.ollama = {
    tags: tags,
    cloudCatalog: cloudCatalog,
    toCloudName: toCloudName,
    account: account,
    version: version,
    chat: chat,
    preload: preload,
    parseJsonLoose: parseJsonLoose,
    stripThinking: stripThinking,
    stripFences: stripFences,
    OllamaError: OllamaError
  };
})(typeof self !== 'undefined' ? self : this);
