/* Blue Pencil - options page. Every control saves itself; there is no
   Save button to forget to press. */
(function () {
  'use strict';

  const BP = window.BP;
  const $ = function (id) { return document.getElementById(id); };

  let settings = BP.mergeSettings(null);
  let savedTimer = 0;
  let statusTimer = 0;
  let lastOllama = null;

  function flashSaved() {
    const badge = $('saved');
    badge.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(function () { badge.hidden = true; }, 1200);
  }

  function send(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (response) {
        if (chrome.runtime.lastError) {
          resolve({ error: { message: chrome.runtime.lastError.message, code: 'disconnected' } });
          return;
        }
        resolve(response || { error: { message: 'No response.', code: 'empty' } });
      });
    });
  }

  async function save(patch) {
    Object.assign(settings, patch);
    await BP.setSettings(patch);
    flashSaved();
  }

  /* ------------------------------------------------------------- controls */

  function controls() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-setting]'));
  }

  function readControl(el) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number' || el.type === 'range') {
      const value = parseInt(el.value, 10);
      return isNaN(value) ? BP.DEFAULTS[key] : value;
    }
    return el.value;
  }

  function writeControl(el) {
    const key = el.dataset.setting;
    const value = settings[key];
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value === undefined || value === null ? '' : value;
  }

  function renderDelay() {
    const ms = settings.checkDelayMs;
    $('delay-value').textContent = ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : ms + ' ms';
  }

  /* --------------------------------------------------------------- tabs */

  const TAB_STORAGE_KEY = 'bp.options.tab';

  function tabs() {
    return Array.prototype.slice.call(document.querySelectorAll('.tab'));
  }

  function showTab(name, options) {
    const all = tabs();
    const match = all.find(function (tab) { return tab.dataset.tab === name; }) || all[0];
    const chosen = match.dataset.tab;

    all.forEach(function (tab) {
      const selected = tab === match;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById('panel-' + tab.dataset.tab);
      panel.classList.toggle('active', selected);
      panel.hidden = !selected;
    });

    if (options && options.focus) match.focus();
    try { localStorage.setItem(TAB_STORAGE_KEY, chosen); } catch (err) { /* private mode */ }
    if (location.hash.slice(1) !== chosen) {
      history.replaceState(null, '', '#' + chosen);
    }
  }

  function wireTabs() {
    const all = tabs();
    all.forEach(function (tab) {
      tab.addEventListener('click', function () { showTab(tab.dataset.tab); });
    });

    document.querySelector('.tabs').addEventListener('keydown', function (event) {
      const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
      const move = keys[event.key];
      if (move === undefined) return;
      event.preventDefault();
      const index = all.findIndex(function (tab) { return tab.getAttribute('aria-selected') === 'true'; });
      let next;
      if (move === 'first') next = 0;
      else if (move === 'last') next = all.length - 1;
      else next = (index + move + all.length) % all.length;
      showTab(all[next].dataset.tab, { focus: true });
    });

    window.addEventListener('hashchange', function () {
      const name = location.hash.slice(1);
      if (name) showTab(name);
    });

    let start = location.hash.slice(1);
    if (!start) {
      try { start = localStorage.getItem(TAB_STORAGE_KEY) || 'model'; } catch (err) { start = 'model'; }
    }
    showTab(start);
  }

  /** A dot on the Model tab when Ollama cannot be reached from another tab. */
  function flagConnection(ok) {
    $('tab-dot-model').hidden = Boolean(ok);
  }

  function renderEffortOptions() {
    const select = $('thinkingEffort');
    select.textContent = '';
    BP.EFFORT_LEVELS.forEach(function (level) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = BP.EFFORT_LABELS[level];
      select.appendChild(option);
    });
    select.value = settings.thinkingEffort;
  }

  /** Warn when the chosen model cannot reason, so the setting does nothing. */
  function renderEffortNote(ollama, model, effort) {
    const note = $('effort-note');
    const known = ((ollama && ollama.local) || []).concat((ollama && ollama.cloud) || [])
      .find(function (m) { return m.name === model; });

    if (!known || !known.capabilities || !known.capabilities.length) {
      note.textContent = '';
      return;
    }
    if (known.capabilities.indexOf('thinking') === -1) {
      note.className = 'hint warn';
      note.textContent = model + ' does not reason, so this setting has no effect on it.';
      return;
    }
    note.className = 'hint';
    note.textContent = effort === 'off'
      ? ''
      : model + ' will reason before each check, which costs time.';
  }

  function renderCategories() {
    const host = $('cats');
    host.textContent = '';
    Object.keys(BP.DEFAULTS.categories).forEach(function (key) {
      const label = document.createElement('label');
      label.className = 'checkline';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(settings.categories[key]);
      input.addEventListener('change', function () {
        const next = Object.assign({}, settings.categories);
        next[key] = input.checked;
        save({ categories: next });
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(BP.CATEGORY_LABELS[key]));
      host.appendChild(label);
    });
  }

  function renderSites() {
    const host = $('sites');
    host.textContent = '';
    const list = settings.disabledSites || [];
    if (!list.length) {
      const empty = document.createElement('span');
      empty.className = 'hint';
      empty.textContent = 'No sites yet.';
      host.appendChild(empty);
      return;
    }
    list.forEach(function (site) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.appendChild(document.createTextNode(site));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = 'Remove ' + site;
      remove.textContent = '✕';
      remove.addEventListener('click', function () {
        save({ disabledSites: list.filter(function (entry) { return entry !== site; }) })
          .then(renderSites);
      });
      chip.appendChild(remove);
      host.appendChild(chip);
    });
  }

  function addSite() {
    const input = $('site-input');
    let value = input.value.trim().toLowerCase();
    if (!value) return;
    value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (!value) return;
    const list = (settings.disabledSites || []).slice();
    if (list.indexOf(value) === -1) list.push(value);
    input.value = '';
    save({ disabledSites: list }).then(renderSites);
  }

  /* ----------------------------------------------------------- connection */

  function setStatus(tone, text, hint) {
    $('conn-dot').className = 'dot ' + tone;
    $('conn-text').textContent = text;
    $('conn-hint').innerHTML = hint || '';
    // Trouble here is invisible from the other tabs, so mark the tab itself.
    flagConnection(tone !== 'bad');
  }

  function describeModel(model) {
    // A cloud model's local entry is a pointer of a few hundred bytes; only a
    // figure big enough to be a real model is worth showing.
    const size = model.size > 1e6 ? (model.size >= 1e12
      ? (model.size / 1e12).toFixed(1) + ' TB'
      : (model.size / 1e9).toFixed(model.size >= 1e11 ? 0 : 1) + ' GB') : '';
    const bits = [model.parameters, size].filter(Boolean);
    if (model.remote && model.installed) bits.push('in your list');
    return bits.length ? '  (' + bits.join(', ') + ')' : '';
  }

  function addGroup(select, label, models, selected) {
    if (!models.length) return false;
    const group = document.createElement('optgroup');
    group.label = label;
    models.forEach(function (model) {
      const option = document.createElement('option');
      option.value = model.name;
      option.textContent = model.name + describeModel(model);
      option.selected = model.name === selected;
      group.appendChild(option);
    });
    select.appendChild(group);
    return true;
  }

  function renderModels(ollama, selected) {
    const select = $('model');
    const local = (ollama && ollama.local) || [];
    const cloud = (ollama && ollama.cloud) || [];
    select.textContent = '';

    if (!local.length && !cloud.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No models installed';
      select.appendChild(option);
      select.disabled = true;
      renderModelNote(ollama, '');
      return;
    }

    select.disabled = false;
    addGroup(select, 'Downloaded — runs on this machine', local, selected);
    addGroup(select, 'Ollama Cloud — runs on Ollama’s servers', cloud, selected);

    const known = local.concat(cloud);
    if (!known.some(function (m) { return m.name === selected; })) {
      // The saved model is gone (deleted, or cloud models turned off).
      const orphan = document.createElement('optgroup');
      orphan.label = 'Selected';
      const option = document.createElement('option');
      option.value = selected;
      option.textContent = selected + '  (not installed)';
      option.selected = true;
      orphan.appendChild(option);
      select.insertBefore(orphan, select.firstChild);
    }
    select.value = selected;
    renderModelNote(ollama, select.value);
  }

  /** Say plainly where the chosen model runs, and flag anything in the way. */
  function renderModelNote(ollama, selected) {
    const note = $('model-note');
    const cloud = (ollama && ollama.cloud) || [];
    const isCloud = cloud.some(function (m) { return m.name === selected; });

    if (!isCloud) {
      note.className = 'hint';
      note.textContent = selected
        ? 'Runs on this machine. Nothing you type leaves it.'
        : '';
      return;
    }

    if (ollama && !ollama.account) {
      note.className = 'hint warn';
      note.textContent = 'Runs on Ollama’s servers — your text is sent to them. ' +
        'Sign in first with: ollama signin';
      return;
    }
    note.className = 'hint warn';
    note.textContent = 'Runs on Ollama’s servers — your text is sent to them' +
      (ollama && ollama.account && ollama.account.email ? ' as ' + ollama.account.email : '') + '.';
  }

  async function refreshStatus(options) {
    clearTimeout(statusTimer);
    setStatus('wait', 'Checking connection…', '');
    const status = await send({
      type: 'status',
      refreshCloud: Boolean(options && options.refreshCloud)
    });

    if (status.error || !status.ollama) {
      setStatus('bad', status.error ? status.error.message : 'Could not reach the extension worker.', '');
      return;
    }
    settings = BP.mergeSettings(status.settings);
    lastOllama = status.ollama;
    controls().forEach(writeControl);
    renderDelay();

    if (!status.ollama.ok) {
      const error = status.ollama.error || {};
      setStatus('bad', error.message || 'Ollama is not reachable.',
        error.detail ? BP.util.escapeHtml(error.detail) : 'Start Ollama, then press Test.');
      renderModels(null, '');
      return;
    }

    const local = status.ollama.local || [];
    const cloud = status.ollama.cloud || [];
    const account = status.ollama.account;

    // Cloud models already in `ollama list` stay listed even with the cloud
    // catalogue turned off, so count what the dropdown actually shows.
    const counts = [local.length + ' downloaded'];
    if (cloud.length) {
      counts.push(cloud.length + ' on Ollama Cloud' + (account ? '' : ', not signed in'));
    }
    let hint = counts.join(' · ');
    if (!local.length && !cloud.length) {
      hint = 'No models installed yet. Try <code>ollama pull llama3.2</code>.';
    } else if (status.ollama.cloudError) {
      hint += ' — could not reach ollama.com for the cloud list';
    }

    setStatus('ok', 'Connected to Ollama ' + status.ollama.version, hint);
    renderModels(status.ollama, settings.model);
    renderEffortNote(status.ollama, settings.model, settings.thinkingEffort);
  }

  /* ----------------------------------------------------------- playground */

  function renderResults(items, note) {
    const host = $('playground-results');
    host.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = note || 'No problems found in that text.';
      host.appendChild(li);
      return;
    }
    items.forEach(function (item) {
      const li = document.createElement('li');
      const cat = document.createElement('span');
      const isCorrection = BP.CORRECTION_CATEGORIES.indexOf(item.category) !== -1;
      cat.className = 'cat ' + (isCorrection ? 'correct' : 'improve');
      cat.textContent = BP.CATEGORY_LABELS[item.category] || item.category;
      li.appendChild(cat);

      const body = document.createElement('span');
      const del = document.createElement('del');
      del.textContent = item.before;
      const ins = document.createElement('ins');
      ins.textContent = item.after;
      body.appendChild(del);
      body.appendChild(document.createTextNode(' → '));
      body.appendChild(ins);
      if (item.reason) {
        const why = document.createElement('div');
        why.className = 'why';
        why.textContent = item.reason;
        body.appendChild(why);
      }
      li.appendChild(body);
      host.appendChild(li);
    });
  }

  async function runPlayground() {
    const button = $('run-playground');
    const status = $('playground-status');
    const text = $('playground').value;
    if (!text.trim()) return;

    button.disabled = true;
    status.textContent = 'Asking ' + (settings.model || 'the model') + '…';
    $('playground-results').textContent = '';

    const started = Date.now();
    const response = await send({ type: 'check', text: text });
    button.disabled = false;

    if (response.error) {
      status.textContent = '';
      renderResults([], response.error.message +
        (response.error.detail ? ' — ' + response.error.detail : ''));
      return;
    }

    const located = BP.util.locateEdits(text, response.edits || [], {
      categories: Object.keys(settings.categories).filter(function (k) { return settings.categories[k]; })
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const dropped = (response.edits || []).length - located.length;
    status.textContent = seconds + ' s' + (response.cached ? ' (cached)' : '') +
      (dropped > 0 ? ' — ' + dropped + ' unusable edit' + (dropped === 1 ? '' : 's') + ' discarded' : '');
    renderResults(located);
  }

  /* ----------------------------------------------------------------- wire */

  function wire() {
    controls().forEach(function (el) {
      const event = (el.type === 'text' || el.tagName === 'TEXTAREA' || el.type === 'number')
        ? 'input'
        : 'change';
      let timer = 0;
      el.addEventListener(event, function () {
        clearTimeout(timer);
        const commit = function () {
          const key = el.dataset.setting;
          const patch = {};
          patch[key] = readControl(el);

          if (key === 'endpoint') {
            patch.endpoint = BP.normalizeEndpoint(patch.endpoint);
            save(patch).then(function () { refreshStatus(); });
            return;
          }
          if (key === 'showCloudModels') {
            save(patch).then(function () { refreshStatus({ refreshCloud: patch[key] }); });
            return;
          }
          save(patch);
          if (key === 'checkDelayMs') renderDelay();
        };
        if (event === 'input') timer = setTimeout(commit, 500);
        else commit();
      });
    });

    // A range slider should show its value while being dragged.
    $('checkDelayMs').addEventListener('input', function () {
      settings.checkDelayMs = parseInt(this.value, 10);
      renderDelay();
    });

    $('endpoint').addEventListener('blur', async function () {
      const endpoint = BP.normalizeEndpoint(this.value);
      this.value = endpoint;
      if (BP.isLocalEndpoint(endpoint)) return;
      // Anything beyond localhost needs its own host permission.
      try {
        const origin = new URL(endpoint).origin + '/*';
        const granted = await chrome.permissions.contains({ origins: [origin] });
        if (!granted) {
          const ok = await chrome.permissions.request({ origins: [origin] });
          if (!ok) {
            setStatus('bad', 'Blue Pencil may not contact ' + endpoint + ' without permission.', '');
          }
        }
      } catch (err) {
        setStatus('bad', 'That address could not be used: ' + err.message, '');
      }
    });

    $('test').addEventListener('click', function () { refreshStatus(); });
    $('refresh-models').addEventListener('click', function () {
      refreshStatus({ refreshCloud: true });
    });
    $('model').addEventListener('change', function () {
      renderModelNote(lastOllama, this.value);
      renderEffortNote(lastOllama, this.value, $('thinkingEffort').value);
    });
    $('thinkingEffort').addEventListener('change', function () {
      renderEffortNote(lastOllama, $('model').value, this.value);
    });
    $('add-site').addEventListener('click', addSite);
    $('site-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') addSite();
    });
    $('run-playground').addEventListener('click', runPlayground);

    $('shortcuts-link').addEventListener('click', function (event) {
      event.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    $('reset').addEventListener('click', async function () {
      await new Promise(function (resolve) { chrome.storage.sync.clear(resolve); });
      settings = BP.mergeSettings(null);
      controls().forEach(writeControl);
      renderDelay();
      renderCategories();
      renderSites();
      flashSaved();
      refreshStatus();
    });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      BP.getSettings().then(function (next) {
        settings = next;
        controls().forEach(function (el) {
          if (document.activeElement !== el) writeControl(el);
        });
        renderDelay();
        renderSites();
      });
    });
  }

  async function init() {
    settings = await BP.getSettings();
    $('version').textContent = chrome.runtime.getManifest().version;
    wireTabs();
    renderEffortOptions();
    controls().forEach(writeControl);
    renderDelay();
    renderCategories();
    renderSites();
    wire();
    refreshStatus();
  }

  init();
})();
