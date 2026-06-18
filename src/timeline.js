// timeline.js — tick overlay on YouTube's progress bar (content script).
//
// Draws a colored tick on the scrubber for each speed change, positioned by
// timestamp and colored by speed. Two callers:
//   - author.js (recording): render(cues) on every cue change, clear() at the end.
//     Colored by cue code. Pins the controls visible so ticks don't auto-hide.
//   - content.js (playback): renderSegments(segments) when a track is applied, then
//     refreshSegments(segments) from its rAF loop to redraw if YouTube re-renders
//     the bar. Colored by rate. Controls are NOT pinned — ticks ride the bar's
//     normal show/hide.
//
// Positions are percentage-based against video.duration, so ticks survive a resize.

(function () {
  'use strict';

  var OVERLAY_ID = 'speed-track-tick-overlay';
  var PIN_STYLE_ID = 'speed-track-pin-style';
  var PIN_CLASS = 'speed-track-pin';

  // code -> tick color (1 normal, 2 fast, 3 faster, 4 skip). Kept eyeball-simple.
  function codeColor(code) {
    switch (code) {
      case 1: return '#2e7d32'; // green
      case 2: return '#1565c0'; // blue
      case 3: return '#ef6c00'; // orange
      case 4: return '#c62828'; // red
      default: return '#9e9e9e';
    }
  }

  function levels() {
    return (typeof SpeedTrack !== 'undefined') ? SpeedTrack.SPEED_LEVELS : null;
  }

  // Playback gives us a rate, not a code. Reverse-map through SPEED_LEVELS (rates
  // are distinct) so the same colors mean the same speeds as while recording.
  function rateColor(rate) {
    var map = levels();
    if (map) for (var k in map) if (map[k] === rate) return codeColor(Number(k));
    return '#9e9e9e';
  }

  // The overlay container, lazily (re)created inside the progress bar. Returns null
  // if the progress bar isn't in the DOM yet.
  function ensureOverlay() {
    var existing = document.getElementById(OVERLAY_ID);
    if (existing && existing.isConnected) return existing;

    // Prefer the container: same horizontal extent as the bar, but it won't clip
    // ticks that protrude above/below the thin bar.
    var bar = document.querySelector('.ytp-progress-bar-container') ||
              document.querySelector('.ytp-progress-bar');
    if (!bar) return null;

    var overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:1000;';
    bar.appendChild(overlay);
    return overlay;
  }

  // Draw a normalized tick list [{ t, color, title }]. Idempotent: clears + redraws.
  function paint(items) {
    var overlay = ensureOverlay();
    if (!overlay) return;
    overlay.textContent = '';

    if (!items || !items.length) return;

    var video = document.querySelector('video');
    var duration = video && video.duration;
    if (!duration) return; // NaN/0 right after load — nothing sensible to position yet

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var pct = Math.max(0, Math.min(100, (item.t / duration) * 100));

      // Protrude above/below the thin progress bar so ticks are easy to see and
      // their colors are distinguishable; a dark outline keeps them visible against
      // both the red played-fill and the gray track.
      var tick = document.createElement('div');
      tick.style.cssText =
        'position:absolute;top:-7px;height:18px;width:3px;margin-left:-1.5px;border-radius:1px;' +
        'pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,0.5);' +
        'left:' + pct + '%;background:' + item.color + ';';
      if (item.title) tick.title = item.title;
      overlay.appendChild(tick);
    }
  }

  // Recording: cues are { t, code }, colored by code.
  function render(cues) {
    var map = levels();
    paint((cues || []).map(function (cue) {
      return {
        t: cue.t,
        color: codeColor(cue.code),
        title: (map && map[cue.code] != null) ? map[cue.code] + 'x' : ''
      };
    }));
  }

  // Playback: segments are { start, rate }, colored by rate.
  function renderSegments(segments) {
    paint((segments || []).map(function (seg) {
      return { t: seg.start, color: rateColor(seg.rate), title: seg.rate + 'x' };
    }));
  }

  // Cheap to call every frame: only redraws if our overlay vanished (YouTube
  // re-rendered the bar) or hasn't been drawn yet (e.g. duration wasn't ready).
  function refreshSegments(segments) {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.isConnected && overlay.firstChild) return;
    renderSegments(segments);
  }

  // Remove the overlay entirely so nothing lingers after the session.
  function clear() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  // Keep YouTube's bottom controls (and thus the progress bar + ticks) from
  // auto-hiding while idle: !important overrides the .ytp-autohide opacity fade,
  // scoped to a class we add to the player only during the session.
  function pin() {
    if (!document.getElementById(PIN_STYLE_ID)) {
      var style = document.createElement('style');
      style.id = PIN_STYLE_ID;
      style.textContent =
        '.html5-video-player.' + PIN_CLASS + ' .ytp-chrome-bottom{opacity:1 !important;}' +
        '.html5-video-player.' + PIN_CLASS + ' .ytp-gradient-bottom{opacity:1 !important;}';
      (document.head || document.documentElement).appendChild(style);
    }
    var player = document.querySelector('.html5-video-player');
    if (player) player.classList.add(PIN_CLASS);
  }

  function unpin() {
    var player = document.querySelector('.html5-video-player');
    if (player) player.classList.remove(PIN_CLASS);
  }

  window.SpeedTrackTimeline = {
    render: render,
    renderSegments: renderSegments,
    refreshSegments: refreshSegments,
    clear: clear,
    pin: pin,
    unpin: unpin
  };
})();
