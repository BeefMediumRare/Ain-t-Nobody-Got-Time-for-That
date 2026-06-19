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

  var tabVideo = {};      // tabId -> videoId reported by the content script
  var recordingTabs = {}; // tabId -> true while authoring (recording badge wins)

  function setText(tabId, text) {
    action.setBadgeText({ text: text, tabId: tabId });
  }

  // Blue badge: how many tracks match this tab's video — local plus those synced
  // from repos (all read from storage, no network). Cleared at zero. Skipped
  // while recording so the red indicator isn't clobbered.
  function updateTrackBadge(tabId) {
    if (tabId == null || recordingTabs[tabId]) return;
    var videoId = tabVideo[tabId];
    var lookup = videoId ? Promise.all([
      SpeedTrackStore.getTracksForVideo(videoId),
      SpeedTrackStore.getRepoTracksForVideo(videoId)
    ]).then(function (lists) { return lists[0].length + lists[1].length; }) : Promise.resolve(0);
    lookup.then(function (count) {
      if (recordingTabs[tabId]) return; // recording started while we awaited
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

  // Forget tabs as they close.
  if (browserApi.tabs && browserApi.tabs.onRemoved) {
    browserApi.tabs.onRemoved.addListener(function (tabId) {
      delete tabVideo[tabId];
      delete recordingTabs[tabId];
    });
  }
})();
