// background.js — owns the toolbar badge (the only place allowed to set it).
//   - While authoring: a red recording indicator + live marker count.
//   - Otherwise: a blue count of saved tracks available for the tab's video.
//
// Badges are per-tab. The content script reports the tab's video id on load and
// again whenever an in-tab SPA navigation swaps the video, so the cached id (and
// the badge) follow along.

(function () {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser : chrome;
  var action = browserApi.action || browserApi.browserAction;

  var RECORD_COLOR = '#c0392b'; // red
  var TRACKS_COLOR = '#1565c0'; // blue (matches the "fast" timeline tick)
  var ACTIVE_COLOR = '#2e7d32'; // green (matches the popup's active-track marker)

  var tabVideo = {};      // tabId -> videoId reported by the content script
  var recordingTabs = {}; // tabId -> true while authoring (recording badge wins)
  var activeTabs = {};    // tabId -> true while a track is driving playback

  function setText(tabId, text) {
    action.setBadgeText({ text: text, tabId: tabId });
  }

  // The tab's badge. Precedence: recording (red, set elsewhere) > a track actively
  // driving playback (green ▶) > the count of tracks matching the video (blue) >
  // empty. The green flag is the on-page "a track is live here" cue now that the
  // timeline bands are optional.
  function updateTrackBadge(tabId) {
    if (tabId == null || recordingTabs[tabId]) return;
    if (activeTabs[tabId]) {
      action.setBadgeBackgroundColor({ color: ACTIVE_COLOR, tabId: tabId });
      setText(tabId, '▶');
      return;
    }
    var videoId = tabVideo[tabId];
    var lookup = videoId ? Promise.all([
      SpeedTrackStore.getTracksForVideo(videoId),
      SpeedTrackStore.getRepoTracksForVideo(videoId)
    ]).then(function (lists) { return lists[0].length + lists[1].length; }) : Promise.resolve(0);
    lookup.then(function (count) {
      if (recordingTabs[tabId] || activeTabs[tabId]) return; // state changed while we awaited
      if (count) {
        action.setBadgeBackgroundColor({ color: TRACKS_COLOR, tabId: tabId });
        setText(tabId, String(count));
      } else {
        setText(tabId, '');
      }
    });
  }

  browserApi.runtime.onMessage.addListener(function (msg, sender) {
    if (!msg) return;
    var tabId = sender.tab && sender.tab.id;

    if (msg.type === 'badge') {
      if (msg.recording) {
        recordingTabs[tabId] = true;
        action.setBadgeBackgroundColor({ color: RECORD_COLOR, tabId: tabId });
        setText(tabId, msg.count ? String(msg.count) : '●');
      } else {
        delete recordingTabs[tabId];
        updateTrackBadge(tabId); // back to the blue track count
      }
    } else if (msg.type === 'videoId') {
      if (tabId != null) {
        tabVideo[tabId] = msg.videoId || null;
        updateTrackBadge(tabId);
        // Lazily pull this video's repo tracks. Caching them writes repoTracks,
        // which trips the storage.onChanged listener below and refreshes the badge.
        if (msg.videoId && typeof SpeedTrackSources !== 'undefined') {
          SpeedTrackSources.ensureTracksForVideo(msg.videoId).catch(function () {});
        }
      }
    } else if (msg.type === 'active') {
      if (tabId != null) {
        if (msg.on) activeTabs[tabId] = true; else delete activeTabs[tabId];
        updateTrackBadge(tabId);
      }
    } else if (msg.type === 'sessionEnded') {
      // Pop the popup so the just-recorded track can be named and saved.
      // No-op on Firefox < 118, which requires a user-gesture handler.
      if (action.openPopup) {
        try {
          var opening = action.openPopup();
          if (opening && opening.catch) opening.catch(function () {});
        } catch (e) { /* needs a gesture on this version; user opens it manually */ }
      }
    }
  });

  // Tracks changed (recorded/imported/deleted locally, or a repo synced/removed)
  // — refresh every known tab.
  if (browserApi.storage && browserApi.storage.onChanged) {
    var KEYS = SpeedTrackStore.KEYS;
    browserApi.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (!changes[KEYS.tracks] && !changes[KEYS.repoTracks] && !changes[KEYS.sources]) return;
      Object.keys(tabVideo).forEach(function (id) { updateTrackBadge(Number(id)); });
    });
  }

  // On load, prune cached repo tracks past their expiry so storage doesn't grow
  // without bound. Anything dropped is re-fetched on demand when its video opens.
  SpeedTrackStore.getCacheExpiryDays().then(function (days) {
    return SpeedTrackStore.pruneRepoCache(days * 24 * 60 * 60 * 1000);
  }).catch(function () {});

  // Forget tabs as they close.
  if (browserApi.tabs && browserApi.tabs.onRemoved) {
    browserApi.tabs.onRemoved.addListener(function (tabId) {
      delete tabVideo[tabId];
      delete recordingTabs[tabId];
      delete activeTabs[tabId];
    });
  }
})();
