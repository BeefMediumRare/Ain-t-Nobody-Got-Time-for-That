// popup.js — per-video track picker.
//
// Tracks are JSON documents persisted in storage.local and matched to the page's
// video by id. The popup lists the tracks for the current video, applies a chosen
// one (resolving its codes through the user's speed prefs into segments for the
// playback engine), saves new recordings, and imports/exports track JSON.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;

  var recordBtn = document.getElementById('record');
  var statusEl = document.getElementById('status');

  var saveForm = document.getElementById('save-form');
  var titleInput = document.getElementById('save-title');
  var descInput = document.getElementById('save-desc');
  var saveBtn = document.getElementById('save-track');

  var headingEl = document.getElementById('tracks-heading');
  var listEl = document.getElementById('track-list');
  var emptyEl = document.getElementById('tracks-empty');
  var noticesEl = document.getElementById('source-notices');

  var importArea = document.getElementById('import-json');
  var importBtn = document.getElementById('import-track');

  var resetBtn = document.getElementById('reset');

  var refreshBtn = document.getElementById('refresh-repos');
  var optionsBtn = document.getElementById('open-options');

  var recording = false;
  var videoId = null;
  var speedLevels = null;     // code->rate prefs, loaded once on open
  var pendingCues = null;     // cues from a just-ended recording, awaiting a title
  var editingId = null;       // id of the track being edited (null = saving a new one)
  var currentTracks = [];     // [{ track, writable }] for the current video

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function show(el, on) {
    el.classList.toggle('hidden', !on);
  }

  // The Stop/reset button only makes sense while a track is driving playback.
  function setResetEnabled(on) {
    resetBtn.disabled = !on;
  }

  function activeTab() {
    return browserApi.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0];
    });
  }

  function setRecording(on) {
    recording = on;
    recordBtn.textContent = (on ? 'End recording' : 'Start recording') + ' (⌥⇧R)';
  }

  function smallButton(label, onClick) {
    var b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---- Render the matching tracks -------------------------------------------

  function renderTracks() {
    listEl.textContent = '';
    noticesEl.textContent = '';
    if (!videoId) {
      currentTracks = [];
      headingEl.textContent = 'Open a YouTube video to see its tracks.';
      show(emptyEl, false);
      refreshSaveButton();
      return Promise.resolve();
    }
    headingEl.textContent = 'Tracks for this video';
    // Local tracks are writable; tracks synced from a repo are read-only
    // (Apply/Download only) and carry the source label for display.
    return SpeedTrackSources.listTracksForVideo(videoId).then(function (result) {
      currentTracks = result.entries.map(function (e) {
        return { track: e.track, writable: e.writable, sourceLabel: e.sourceLabel };
      });
      show(emptyEl, currentTracks.length === 0);
      currentTracks.forEach(function (e) {
        listEl.appendChild(renderTrackItem(e.track, e.writable, e.sourceLabel));
      });
      if (result.notices && result.notices.length) noticesEl.textContent = result.notices.join(' ');
      refreshSaveButton();
    });
  }

  // The existing track (if any) for the current video matching a title. When
  // editing, the track being edited is excluded so its own (unchanged) title
  // isn't read as a clash with itself.
  function findTrackEntry(title, excludeId) {
    for (var i = 0; i < currentTracks.length; i++) {
      var entry = currentTracks[i];
      if (entry.track.title !== title) continue;
      if (excludeId && entry.track.id === excludeId) continue;
      return entry;
    }
    return null;
  }

  // The Save button reflects what saving the current title would do:
  // - editing, no title clash -> "Update track" (updates in place by id)
  // - editing, title now owned by a different local track -> blocked (titles stay unique)
  // - new track, title matches a local one -> "Overwrite track"
  // - any title that matches a read-only repo track -> blocked
  function refreshSaveButton() {
    var match = findTrackEntry(titleInput.value.trim(), editingId);
    if (match && !match.writable) {
      saveBtn.textContent = 'Cannot overwrite a read-only track';
      saveBtn.disabled = true;
    } else if (editingId) {
      saveBtn.textContent = match ? 'Title already used by another track' : 'Update track';
      saveBtn.disabled = !!match;
    } else {
      saveBtn.textContent = match ? 'Overwrite track' : 'Save track';
      saveBtn.disabled = false;
    }
  }

  function renderTrackItem(track, writable, sourceLabel) {
    var li = document.createElement('li');
    li.className = 'track';
    // Tint the user's own (local, authored) tracks so they stand apart from the
    // read-only ones synced from a repo.
    li.classList.add(writable ? 'track--local' : 'track--repo');

    var title = document.createElement('div');
    title.className = 'track-title';
    title.textContent = track.title || '(untitled)';
    li.appendChild(title);

    if (track.description) {
      var desc = document.createElement('div');
      desc.className = 'track-desc';
      desc.textContent = track.description;
      li.appendChild(desc);
    }

    // Read-only tracks come from a repo; show where so it's clear they can't be
    // edited or overwritten here.
    if (!writable && sourceLabel) {
      var src = document.createElement('div');
      src.className = 'muted';
      src.textContent = 'from ' + sourceLabel;
      li.appendChild(src);
    }

    var actions = document.createElement('div');
    actions.className = 'track-actions';
    actions.appendChild(smallButton('Apply', function () { applyTrack(track); }));
    if (writable) actions.appendChild(smallButton('Edit', function () { editTrack(track); }));
    // Clone forks any track into a new, editable local copy. For repo tracks it's
    // the only way to make them editable; for local tracks it's how you fork a
    // variant without overwriting the original (since Edit now updates in place).
    actions.appendChild(smallButton('Clone', function () { cloneTrack(track); }));
    actions.appendChild(smallButton('Download', function () { downloadTrack(track); }));
    if (writable) {
      var del = smallButton('Delete', function () { deleteTrack(track); });
      del.className = 'danger';
      actions.appendChild(del);
    }
    li.appendChild(actions);

    return li;
  }

  // ---- Actions --------------------------------------------------------------

  function applyTrack(track) {
    var segments = SpeedTrack.trackToSegments(track, speedLevels);
    if (!segments.length) { setStatus('Track has no usable cues.', 'error'); return; }
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, { type: 'applyTrack', segments: segments });
    }).then(function (resp) {
      if (resp && resp.ok) {
        setResetEnabled(true);
        var note = resp.videoFound ? '' : ' (no <video> on page yet)';
        setStatus('Applied "' + track.title + '" — ' + resp.segmentCount + ' segment(s).' + note, 'ok');
      } else if (resp !== undefined) {
        setStatus('Applied, but no response from page.', 'ok');
      }
    }).catch(function (err) {
      setStatus('Could not reach the page. Is this a YouTube tab?\n' + err.message, 'error');
    });
  }

  function downloadTrack(track) {
    var name = (track.youtubeVideoId || 'video') + '_' + SpeedTrack.slugifyTitle(track.title) + SpeedTrack.TRACK_EXT;
    var blob = new Blob([JSON.stringify(track, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    setStatus('Downloaded ' + name + ' — commit it to a track repo.', 'ok');
  }

  function deleteTrack(track) {
    SpeedTrackStore.deleteTrack(track.youtubeVideoId, track.id).then(function () {
      setStatus('Deleted "' + track.title + '".', 'ok');
      return renderTracks();
    });
  }

  // Clone a read-only repo track into an editable local copy. No page round-trip
  // is needed — the repo track already carries its cues, so we just prime the save
  // dialog (prefilled, title suffixed " (clone)") and let the normal save path mint
  // a fresh local track.
  function cloneTrack(track) {
    pendingCues = SpeedTrack.trackToCues(track);
    if (!pendingCues.length) { setStatus('Track has no usable cues to clone.', 'error'); return; }
    editingId = null;
    titleInput.value = (track.title || 'Untitled') + ' (clone)';
    descInput.value = track.description || '';
    show(saveForm, true);
    refreshSaveButton();
    titleInput.focus();
    titleInput.select();
    setStatus('Cloning "' + track.title + '" into a local copy. Adjust and Save.', 'ok');
  }

  // Reopen a saved track as a recording, seeded with its cues. Ending the session
  // brings back the save dialog prefilled with the original title/description:
  // keep the title to overwrite, change it to save as a separate track. Editing
  // only the title/description (without touching cues) is a valid use.
  function editTrack(track) {
    var cues = SpeedTrack.trackToCues(track);
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, {
        type: 'editTrack', cues: cues, id: track.id, title: track.title, description: track.description
      }).then(function (resp) {
        if (resp && resp.ok) {
          setRecording(true);
          show(saveForm, false);
          setStatus('Editing "' + track.title + '". Adjust cues if you like, then End recording.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus('Could not reach the page. Is this a YouTube tab?\n' + err.message, 'error');
    });
  }

  // ---- Recording / saving ---------------------------------------------------

  recordBtn.addEventListener('click', function () {
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      if (!recording) {
        return browserApi.tabs.sendMessage(tab.id, { type: 'startRecording' }).then(function () {
          editingId = null;
          setRecording(true);
          show(saveForm, false);
          setStatus('Recording. Press 1-4 at any moment to set the speed there.', 'ok');
        });
      }
      return browserApi.tabs.sendMessage(tab.id, { type: 'stopRecording' }).then(function (resp) {
        setRecording(false);
        if (resp && resp.videoId) videoId = resp.videoId;
        offerSave(resp && resp.cues, resp && resp.edit);
      });
    }).catch(function (err) {
      setStatus('Could not reach the page. Is this a YouTube tab?\n' + err.message, 'error');
    });
  });

  // Show the title/description form for recorded cues. When editing, meta carries
  // the original title/description to prefill (keep title = overwrite).
  function offerSave(cues, meta) {
    pendingCues = (cues && cues.length) ? cues : null;
    editingId = (meta && meta.id) || null;
    if (!pendingCues) {
      show(saveForm, false);
      setStatus('Recording ended (nothing recorded).', 'ok');
      return;
    }
    titleInput.value = (meta && meta.title) || '';
    descInput.value = (meta && meta.description) || '';
    show(saveForm, true);
    refreshSaveButton();
    titleInput.focus();
    setStatus(editingId
      ? 'Editing "' + meta.title + '". Save to update it — rename freely; it stays the same track.'
      : 'Recording ended. Name it and Save.', 'ok');
  }

  saveBtn.addEventListener('click', function () {
    var title = titleInput.value.trim();
    if (!title) { setStatus('Give the track a title.', 'error'); titleInput.focus(); return; }
    if (!videoId) { setStatus('No video id for this page — open the video first.', 'error'); return; }
    if (!pendingCues || !pendingCues.length) { setStatus('Nothing recorded to save.', 'error'); return; }

    var match = findTrackEntry(title, editingId);
    if (match && !match.writable) {
      setStatus('"' + title + '" is read-only — change the title to save a local copy.', 'error');
      titleInput.focus();
      return;
    }
    if (match && editingId) {
      setStatus('Another track already uses the title "' + title + '". Pick a unique title.', 'error');
      titleInput.focus();
      return;
    }

    var track = SpeedTrack.cuesToTrack(pendingCues, {
      videoId: videoId, title: title, description: descInput.value.trim()
    });
    if (editingId) track.id = editingId;
    SpeedTrackStore.saveTrack(track).then(function () {
      pendingCues = null;
      editingId = null;
      show(saveForm, false);
      setStatus('Saved "' + title + '". Apply it, or Download to commit to a repo.', 'ok');
      // Forget the take on the page so reopening the popup won't re-offer to save.
      activeTab().then(function (tab) {
        if (tab) browserApi.tabs.sendMessage(tab.id, { type: 'clearRecording' }).catch(function () {});
      });
      return renderTracks();
    }).catch(function (err) {
      setStatus('Could not save: ' + err.message, 'error');
    });
  });

  // ---- Stop / reset ---------------------------------------------------------

  resetBtn.addEventListener('click', function () {
    activeTab().then(function (tab) {
      if (!tab) { setStatus('No active tab.', 'error'); return; }
      return browserApi.tabs.sendMessage(tab.id, { type: 'stopTrack' }).then(function (resp) {
        if (resp && resp.ok) {
          setResetEnabled(false);
          setStatus('Stopped. Playback speed reset to 1×.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus('Could not reach the page. Is this a YouTube tab?\n' + err.message, 'error');
    });
  });

  // ---- Import ---------------------------------------------------------------

  titleInput.addEventListener('input', refreshSaveButton);

  importBtn.addEventListener('click', function () {
    var result = SpeedTrack.validateTrack(importArea.value);
    if (result.errors.length) {
      setStatus(result.errors.map(function (e) { return e.message; }).join('\n'), 'error');
      return;
    }
    SpeedTrackStore.saveTrack(result.track).then(function () {
      importArea.value = '';
      var t = result.track;
      if (t.youtubeVideoId === videoId) {
        setStatus('Imported "' + t.title + '".', 'ok');
      } else {
        setStatus('Imported "' + t.title + '" for video ' + t.youtubeVideoId +
          ' (not the one open now).', 'ok');
      }
      return renderTracks();
    }).catch(function (err) {
      setStatus('Could not import: ' + err.message, 'error');
    });
  });

  // ---- Repositories ---------------------------------------------------------

  optionsBtn.addEventListener('click', function () {
    if (browserApi.runtime.openOptionsPage) browserApi.runtime.openOptionsPage();
  });

  refreshBtn.addEventListener('click', function () {
    setStatus('Refreshing repositories…');
    SpeedTrackSources.refreshAll().then(function (results) {
      return renderTracks().then(function () {
        var errs = (results || []).filter(function (r) { return r.error; });
        if (errs.length) {
          setStatus('Refreshed with ' + errs.length + ' problem(s): ' +
            errs.map(function (e) { return e.error.message; }).join(' '), 'error');
        } else {
          setStatus('Repositories refreshed.', 'ok');
        }
      });
    }).catch(function (err) {
      setStatus('Refresh failed: ' + err.message, 'error');
    });
  });

  // Only offer Refresh once at least one GitHub repository is configured.
  SpeedTrackStore.getSources().then(function (sources) {
    show(refreshBtn, sources.some(function (s) { return s.type === 'github'; }));
  });

  // ---- Init -----------------------------------------------------------------

  SpeedTrackStore.ensureSeeded();
  SpeedTrackStore.getSpeedLevels().then(function (m) { speedLevels = m; });

  activeTab().then(function (tab) {
    if (!tab) return renderTracks();
    // Reflect whether a track is currently driving playback (enables Stop).
    browserApi.tabs.sendMessage(tab.id, { type: 'getPlaybackStatus' }).then(function (resp) {
      setResetEnabled(!!(resp && resp.applied));
    }).catch(function () { setResetEnabled(false); });
    return browserApi.tabs.sendMessage(tab.id, { type: 'getStatus' }).then(function (resp) {
      setRecording(!!(resp && resp.recording));
      if (resp && resp.videoId) videoId = resp.videoId;
      // Render first so the save form's Overwrite/Save label knows the existing
      // tracks; a session ended via the keyboard leaves cues waiting to save.
      return renderTracks().then(function () {
        if (resp && !resp.recording && resp.cues && resp.cues.length) offerSave(resp.cues, resp.edit);
      });
    });
  }).catch(function () {
    // Not a YouTube tab (or content script not present): no video, just render empty.
    renderTracks();
  });
})();
