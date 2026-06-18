// content.js — the playback engine.
// Holds the active segments in memory and, on every animation frame, sets the
// video's playbackRate to match the timeline. Receives segments from the popup
// via runtime messaging.

(function () {
  'use strict';

  var segments = [];   // [{start, rate}], sorted ascending by start
  var running = false; // rAF loop active?

  function getVideo() {
    return document.querySelector('video');
  }

  // Rate active at time t: last segment whose start <= t, else null.
  function rateAt(t) {
    var rate = null;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].start <= t) rate = segments[i].rate;
      else break;
    }
    return rate;
  }

  function tick() {
    if (!running) return;
    var video = getVideo();
    // Don't fight the recorder: leave playback (and its ticks) alone while authoring.
    if (video && segments.length && !window.__speedTrackRecording) {
      var want = rateAt(video.currentTime);
      // null => before the first entry: leave the rate untouched.
      if (want !== null && Math.abs(video.playbackRate - want) > 1e-3) {
        video.playbackRate = want;
      }
      // Keep the ticks on the bar; cheap no-op unless YouTube re-rendered it.
      if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.refreshSegments(segments);
    }
    requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(tick);
  }

  // Stop driving playback: drop the track, reset to normal speed, clear the ticks.
  function stop() {
    running = false;
    segments = [];
    var video = getVideo();
    if (video) video.playbackRate = 1;
    if (window.SpeedTrackTimeline) window.SpeedTrackTimeline.clear();
  }

  var browserApi = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (browserApi && browserApi.runtime && browserApi.runtime.onMessage) {
    browserApi.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.type === 'applyTrack') {
        segments = Array.isArray(msg.segments) ? msg.segments.slice() : [];
        segments.sort(function (a, b) { return a.start - b.start; });
        start();
        // Show the track's ticks straight away (the rAF loop keeps them in sync).
        if (window.SpeedTrackTimeline && !window.__speedTrackRecording) {
          window.SpeedTrackTimeline.renderSegments(segments);
        }
        var video = getVideo();
        sendResponse({ ok: true, segmentCount: segments.length, videoFound: !!video });
        return true;
      }
      if (msg.type === 'stopTrack') {
        stop();
        sendResponse({ ok: true });
        return true;
      }
    });

    // Report this page's video id so the background can badge how many saved
    // tracks are available for it. Read once on load; SPA video changes are
    // intentionally not handled (see the project's deferred-video-change note).
    if (typeof SpeedTrackVideo !== 'undefined') {
      browserApi.runtime.sendMessage({ type: 'videoId', videoId: SpeedTrackVideo.extractVideoId(location) });
    }
  }
})();
