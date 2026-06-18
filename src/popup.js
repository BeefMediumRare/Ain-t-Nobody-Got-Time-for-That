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

  var importArea = document.getElementById('import-json');
  var importBtn = document.getElementById('import-track');

  var resetBtn = document.getElementById('reset');

  var recording = false;
  var videoId = null;
  var speedLevels = null;     // code->rate prefs, loaded once on open
  var pendingCues = null;     // cues from a just-ended recording, awaiting a title
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
    if (!videoId) {
      currentTracks = [];
      headingEl.textContent = 'Open a YouTube video to see its tracks.';
      show(emptyEl, false);
      refreshSaveButton();
      return Promise.resolve();
    }
    headingEl.textContent = 'Tracks for this video';
    return SpeedTrackStore.getTracksForVideo(videoId).then(function (tracks) {
      // Local-storage tracks are writable. Read-only tracks pulled from a repo
      // (a future source) would render with writable=false: Apply/Download only.
      currentTracks = tracks.map(function (t) { return { track: t, writable: true }; });
      show(emptyEl, currentTracks.length === 0);
      currentTracks.forEach(function (e) { listEl.appendChild(renderTrackItem(e.track, e.writable)); });
      refreshSaveButton();
    });
  }

  // The existing track (if any) for the current video matching a title.
  function findTrackEntry(title) {
    for (var i = 0; i < currentTracks.length; i++) {
      if (currentTracks[i].track.title === title) return currentTracks[i];
    }
    return null;
  }

  // Saving with an existing title overwrites it (a new title makes a new track),
  // so the button says so. A read-only (repo) track can't be written over, so
  // saving under its title is blocked — change the title to keep a local copy.
  function refreshSaveButton() {
    var match = findTrackEntry(titleInput.value.trim());
    if (match && !match.writable) {
      saveBtn.textContent = 'Cannot overwrite a read-only track';
      saveBtn.disabled = true;
    } else {
      saveBtn.textContent = match ? 'Overwrite track' : 'Save track';
      saveBtn.disabled = false;
    }
  }

  function renderTrackItem(track, writable) {
    var li = document.createElement('li');
    li.className = 'track';

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

    var actions = document.createElement('div');
    actions.className = 'track-actions';
    actions.appendChild(smallButton('Apply', function () { applyTrack(track); }));
    if (writable) actions.appendChild(smallButton('Edit', function () { editTrack(track); }));
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
    var name = (track.youtubeVideoId || 'video') + '_' + SpeedTrack.slugifyTitle(track.title) + '.json';
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
    SpeedTrackStore.deleteTrack(track.youtubeVideoId, track.title).then(function () {
      setStatus('Deleted "' + track.title + '".', 'ok');
      return renderTracks();
    });
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
        type: 'editTrack', cues: cues, title: track.title, description: track.description
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
    setStatus(meta && meta.title
      ? 'Editing "' + meta.title + '". Keep the title to overwrite, or change it to save a new track.'
      : 'Recording ended. Name it and Save.', 'ok');
  }

  saveBtn.addEventListener('click', function () {
    var title = titleInput.value.trim();
    if (!title) { setStatus('Give the track a title.', 'error'); titleInput.focus(); return; }
    if (!videoId) { setStatus('No video id for this page — open the video first.', 'error'); return; }
    if (!pendingCues || !pendingCues.length) { setStatus('Nothing recorded to save.', 'error'); return; }

    var match = findTrackEntry(title);
    if (match && !match.writable) {
      setStatus('"' + title + '" is read-only — change the title to save a local copy.', 'error');
      titleInput.focus();
      return;
    }

    var track = SpeedTrack.cuesToTrack(pendingCues, {
      videoId: videoId, title: title, description: descInput.value.trim()
    });
    SpeedTrackStore.saveTrack(track).then(function () {
      pendingCues = null;
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
