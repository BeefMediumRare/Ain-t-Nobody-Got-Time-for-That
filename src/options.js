// options.js — manage track repositories (add / refresh / delete).
//
// Repos are immutable once added: to change a URL or depth, delete and re-add.
// Adding requests GitHub host access on the click (a user gesture), then syncs.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;
  var GH_ORIGINS = ['https://api.github.com/*', 'https://raw.githubusercontent.com/*'];

  var listEl = document.getElementById('source-list');
  var labelInput = document.getElementById('add-label');
  var urlInput = document.getElementById('add-url');
  var deepToggle = document.getElementById('add-deep');
  var depthWarning = document.getElementById('depth-warning');
  var addBtn = document.getElementById('add-btn');
  var statusEl = document.getElementById('status');

  // Shallow (default) scans only the chosen folder (maxDepth 0); deep scans
  // every subfolder (maxDepth -1). Warn only for the deep case.
  function syncDepthWarning() {
    depthWarning.classList.toggle('hidden', !deepToggle.checked);
  }
  deepToggle.addEventListener('change', syncDepthWarning);

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function depthLabel(d) {
    if (d == null || d < 0) return 'all subfolders';
    if (d === 0) return 'this folder only';
    return d + ' level(s) deep';
  }

  function noticeText(r) {
    return (r && r.notices && r.notices.length) ? ' ' + r.notices.join(' ') : '';
  }

  function button(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  function countOf(entry) {
    if (!entry || !entry.byVideo) return 0;
    var n = 0;
    Object.keys(entry.byVideo).forEach(function (v) { n += entry.byVideo[v].length; });
    return n;
  }

  function renderSources() {
    return Promise.all([
      SpeedTrackStore.getSources(),
      SpeedTrackStore.getAllRepoTracks()
    ]).then(function (arr) {
      var sources = arr[0], repoAll = arr[1];
      listEl.textContent = '';
      sources.forEach(function (s) { listEl.appendChild(renderSourceItem(s, repoAll[s.id])); });
    });
  }

  function renderSourceItem(s, repoEntry) {
    var li = document.createElement('li');
    li.className = 'track';

    var title = document.createElement('div');
    title.className = 'track-title';
    title.textContent = s.label || (s.type === 'local' ? 'This device' : (s.owner + '/' + s.repo));
    li.appendChild(title);

    if (s.type === 'local') {
      var lm = document.createElement('div');
      lm.className = 'source-meta';
      lm.textContent = 'Tracks saved on this device.';
      li.appendChild(lm);
      return li;
    }

    var meta = document.createElement('div');
    meta.className = 'source-meta';
    meta.textContent = s.url || (s.owner + '/' + s.repo + ' @ ' + s.branch + (s.path ? '/' + s.path : ''));
    li.appendChild(meta);

    var count = countOf(repoEntry);
    var when = (repoEntry && repoEntry.syncedAt) ? new Date(repoEntry.syncedAt).toLocaleString() : 'never';
    var meta2 = document.createElement('div');
    meta2.className = 'source-meta';
    meta2.textContent = count + ' track(s) · ' + depthLabel(s.maxDepth) + ' · synced ' + when;
    li.appendChild(meta2);

    var actions = document.createElement('div');
    actions.className = 'track-actions';
    actions.appendChild(button('Refresh', function () { onRefresh(s); }));
    var del = button('Delete', function () { onDelete(s, count); });
    del.className = 'danger';
    actions.appendChild(del);
    li.appendChild(actions);

    return li;
  }

  function onRefresh(s) {
    var name = s.label || s.repo;
    setStatus('Syncing "' + name + '"…');
    SpeedTrackSources.refreshSource(s.id).then(function (r) {
      if (r && r.unchanged) setStatus('"' + name + '" is already up to date.', 'ok');
      else setStatus('Synced "' + name + '" — ' + (r ? r.count : 0) + ' track(s).' + noticeText(r), 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus('Could not sync "' + name + '": ' + err.message, 'error');
    });
  }

  function onDelete(s, count) {
    var name = s.label || s.repo;
    if (!window.confirm('Remove "' + name + '" and its ' + count + ' synced track(s)?')) return;
    SpeedTrackStore.deleteSource(s.id).then(function () {
      setStatus('Removed "' + name + '".', 'ok');
      return renderSources();
    }).catch(function (err) {
      setStatus('Could not remove "' + name + '": ' + err.message, 'error');
    });
  }

  addBtn.addEventListener('click', function () {
    var url = urlInput.value.trim();
    var label = labelInput.value.trim();
    var depth = deepToggle.checked ? -1 : 0;

    // Parse synchronously so the permission request stays in the user gesture.
    var parsed = SpeedTrackSources.parseRepoUrl(url);
    if (!parsed) {
      setStatus('That doesn’t look like a GitHub repository folder URL.', 'error');
      urlInput.focus();
      return;
    }

    setStatus('Requesting access to GitHub…');
    browserApi.permissions.request({ origins: GH_ORIGINS }).then(function (granted) {
      if (!granted) {
        setStatus('GitHub access was not granted, so the repository can’t be synced.', 'error');
        return;
      }
      setStatus('Adding and syncing…');
      return SpeedTrackSources.addAndSync({ parsed: parsed, label: label, maxDepth: depth, url: url })
        .then(function (res) {
          labelInput.value = '';
          urlInput.value = '';
          setStatus('Added "' + res.source.label + '" — synced ' + res.count + ' track(s).' + noticeText(res), 'ok');
          return renderSources();
        });
    }).catch(function (err) {
      setStatus('Could not add repository: ' + err.message, 'error');
    });
  });

  SpeedTrackStore.ensureSeeded();
  syncDepthWarning();
  renderSources();
})();
