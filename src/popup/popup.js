/* Blue Pencil - toolbar popup. */
(function () {
  'use strict';

  const BP = window.BP;
  const $ = function (id) { return document.getElementById(id); };

  let settings = BP.mergeSettings(null);
  let hostname = '';
  let ollama = null;

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

  async function currentTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  function setStatus(tone, text, hint) {
    $('dot').className = 'dot ' + tone;
    $('status-text').textContent = text;
    $('status-hint').textContent = hint || '';
  }

  function renderSite() {
    const disabled = BP.siteDisabled(settings, hostname);
    $('site-name').textContent = hostname || 'This page';
    $('site-enabled').checked = !disabled;
    $('site-enabled').disabled = !hostname;
    $('site-hint').textContent = !hostname
      ? 'Blue Pencil does not run on this kind of page.'
      : (disabled ? 'Turned off here.' : 'Suggestions are on here.');
  }

  function renderEnabled() {
    $('enabled').checked = settings.enabled;
    document.body.classList.toggle('off', !settings.enabled);
  }

  function addGroup(select, label, models) {
    if (!models.length) return;
    const group = document.createElement('optgroup');
    group.label = label;
    models.forEach(function (model) {
      const option = document.createElement('option');
      option.value = model.name;
      option.textContent = model.name;
      option.selected = model.name === settings.model;
      group.appendChild(option);
    });
    select.appendChild(group);
  }

  function renderModels(ollama) {
    const select = $('model');
    const local = (ollama && ollama.local) || [];
    const cloud = (ollama && ollama.cloud) || [];
    select.textContent = '';

    if (!local.length && !cloud.length) {
      const option = document.createElement('option');
      option.textContent = 'No models';
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    select.disabled = false;
    addGroup(select, 'Downloaded', local);
    addGroup(select, 'Ollama Cloud', cloud);

    if (!local.concat(cloud).some(function (m) { return m.name === settings.model; })) {
      const option = document.createElement('option');
      option.value = settings.model;
      option.textContent = settings.model + ' (not installed)';
      option.selected = true;
      select.insertBefore(option, select.firstChild);
    }
    select.value = settings.model || (local[0] || cloud[0]).name;
  }

  function describeModel(ollama, name) {
    const cloud = (ollama && ollama.cloud) || [];
    if (cloud.some(function (m) { return m.name === name; })) {
      return 'Using ' + name + ' — runs on Ollama Cloud';
    }
    return 'Using ' + name;
  }

  async function load() {
    const tab = await currentTab();
    if (tab && tab.url && /^https?:/.test(tab.url)) {
      try { hostname = new URL(tab.url).hostname; } catch (err) { hostname = ''; }
    }

    const status = await send({ type: 'status' });
    if (status.error) {
      setStatus('bad', 'Blue Pencil could not start.', status.error.message);
      return;
    }

    settings = BP.mergeSettings(status.settings);
    renderEnabled();
    renderSite();

    if (status.ollama && status.ollama.ok) {
      ollama = status.ollama;
      renderModels(ollama);
      setStatus('ok', 'Ollama ' + status.ollama.version + ' is running',
        settings.model ? describeModel(ollama, settings.model) : 'Pick a model below');
    } else {
      const error = (status.ollama && status.ollama.error) || {};
      renderModels(null);
      setStatus('bad', error.message || 'Ollama is not running',
        error.detail || 'Start it, then reopen this popup.');
    }
  }

  $('enabled').addEventListener('change', function () {
    BP.setSettings({ enabled: this.checked }).then(function () {
      settings.enabled = $('enabled').checked;
      renderEnabled();
    });
  });

  $('site-enabled').addEventListener('change', function () {
    if (!hostname) return;
    const list = (settings.disabledSites || []).filter(function (entry) {
      return entry !== hostname;
    });
    if (!this.checked) list.push(hostname);
    settings.disabledSites = list;
    BP.setSettings({ disabledSites: list }).then(renderSite);
  });

  $('model').addEventListener('change', function () {
    const model = this.value;
    BP.setSettings({ model: model }).then(function () {
      settings.model = model;
      $('status-hint').textContent = describeModel(ollama, model);
    });
  });

  $('check').addEventListener('click', async function () {
    const tab = await currentTab();
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'command', command: 'check-now' });
      window.close();
    } catch (err) {
      setStatus('bad', 'No text field to check here.',
        'Open a page with a text box, click into it, then try again.');
    }
  });

  $('settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  load();
})();
