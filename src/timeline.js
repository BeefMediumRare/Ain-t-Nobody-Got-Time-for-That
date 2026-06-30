// timeline.js — speed-segment overlay on YouTube's progress bar (content script).
//
// Each speed change opens a segment that runs until the next change (the last one
// runs to the end of the video). We draw a colored band over the bar for each
// segment, colored by its speed, so the whole timeline reads as bands of speed.
// Two callers:
//   - author.js (recording): render(cues) on every cue change, clear() at the end.
//     Colored by cue code. Pins the controls visible so the bands don't auto-hide.
//   - content.js (playback): renderSegments(segments) when a track is applied, then
//     refreshSegments(segments) from its rAF loop to redraw if YouTube re-renders
//     the bar. Colored by rate. Controls are NOT pinned — the bands ride the bar's
//     normal show/hide.
//
// Positions are percentage-based against video.duration, so bands survive a resize.

(function () {
  'use strict';

  var OVERLAY_ID = 'speed-track-tick-overlay';
  var PIN_STYLE_ID = 'speed-track-pin-style';
  var PIN_CLASS = 'speed-track-pin';

  var INDICATOR_ID = 'speed-track-mode-indicator';
  var INDICATOR_STYLE_ID = 'speed-track-mode-indicator-style';

  // Speed code that means "skip", mirrored from content.js / parser.js (4 = skip).
  var SKIP_CODE = 4;

  // code -> band color (1 normal, 2 fast, 3 faster, 4 skip), from the shared speed
  // ramp so the bands, the toolbar badge, and the popup's strip stay in step. The
  // ramp runs cool -> hot, so the timeline reads as a velocity scale at a glance.
  function codeColor(code) {
    var t = (typeof SpeedTrackTheme !== 'undefined') ? SpeedTrackTheme : null;
    if (t && t.speed[code]) return t.speed[code];
    return (t && t.speedDefault) || '#69728a';
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

  // Draw a normalized list of speed-change points [{ t, color, title }] as bands.
  // Each point opens a band that runs to the next point (the last runs to the end
  // of the video), colored by that point's speed. Idempotent: clears + redraws.
  function paint(items) {
    var overlay = ensureOverlay();
    if (!overlay) return;
    overlay.textContent = '';

    if (!items || !items.length) return;

    var video = document.querySelector('video');
    var duration = video && video.duration;
    if (!duration) return; // NaN/0 right after load — nothing sensible to position yet

    // Defensive: spans assume ascending order. Callers already sort, but a stray
    // order would draw overlapping/negative-width bands.
    var points = items.slice().sort(function (a, b) { return a.t - b.t; });

    for (var i = 0; i < points.length; i++) {
      var startT = Math.max(0, Math.min(duration, points[i].t));
      var endT = (i + 1 < points.length) ? points[i + 1].t : duration;
      endT = Math.max(0, Math.min(duration, endT));
      if (endT <= startT) continue;

      var leftPct = (startT / duration) * 100;
      var widthPct = ((endT - startT) / duration) * 100;

      // Sit a little above the thin progress bar (a touch thicker than the bar) so
      // the bands read as a speed legend without hiding YouTube's played-fill. A
      // thin dark ring outlines each band: it separates adjacent speeds and keeps
      // the colors legible when bright video (e.g. grass) shows through behind them.
      var band = document.createElement('div');
      band.style.cssText =
        'position:absolute;bottom:calc(50% + 3px);height:6px;border-radius:1px;' +
        'pointer-events:none;box-shadow:0 0 0 1px rgba(0,0,0,0.5);' +
        'left:' + leftPct + '%;width:' + widthPct + '%;background:' + points[i].color + ';';
      if (points[i].title) band.title = points[i].title;
      overlay.appendChild(band);
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

  // Playback: segments are { start, rate, code }, colored by code so a customized
  // rate still gets its mode's color. Falls back to reverse-mapping the rate for
  // older segments that carry no code.
  function renderSegments(segments) {
    paint((segments || []).map(function (seg) {
      var color = (seg.code != null) ? codeColor(seg.code) : rateColor(seg.rate);
      return { t: seg.start, color: color, title: seg.rate + 'x' };
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

  // Keep YouTube's bottom controls (and thus the progress bar + bands) from
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

  // ---- Current-mode indicator -----------------------------------------------
  //
  // A small pill in the player's top-right corner showing the cue mode in effect
  // right now: a dot in the speed-ramp color plus its rate ("1.5x", "Skip"). It
  // stays put through playback (it doesn't fade with YouTube's chrome) so the
  // current speed is always one glance away. Driven by content.js's rAF loop:
  // setMode(code, rate) every frame (a cheap no-op unless the mode actually
  // changed), hideMode() when nothing is driving playback.

  function ensureIndicatorStyle() {
    if (document.getElementById(INDICATOR_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = INDICATOR_STYLE_ID;
    style.textContent = [
      '#' + INDICATOR_ID + '{',
        'position:absolute;top:12px;right:12px;z-index:60;',
        'display:flex;align-items:center;gap:7px;box-sizing:border-box;',
        'padding:5px 11px 5px 9px;border-radius:999px;',
        'font-family:"Roboto","YouTube Noto",Arial,sans-serif;',
        'font-size:12px;font-weight:500;line-height:1;color:#fff;',
        'background:rgba(15,17,21,0.4);',
        'backdrop-filter:blur(8px) saturate(140%);',
        '-webkit-backdrop-filter:blur(8px) saturate(140%);',
        'border:1px solid rgba(255,255,255,0.14);',
        'box-shadow:0 2px 10px rgba(0,0,0,0.35);',
        'pointer-events:none;user-select:none;',
        // Stay put: !important defeats YouTube's .ytp-autohide opacity fade, which
        // otherwise dims the player's overlays when the controls hide while idle.
        'opacity:1 !important;',
      '}',
      // Bigger margin in fullscreen so it doesn't hug the very edge of the screen.
      '.ytp-fullscreen #' + INDICATOR_ID + '{top:24px;right:24px;font-size:14px;}',
      '#' + INDICATOR_ID + ' .stk-mode-dot{',
        'width:9px;height:9px;border-radius:50%;flex:0 0 auto;',
        'background:var(--stk-mode,#3b82f6);',
        'box-shadow:0 0 0 1px rgba(0,0,0,0.5),0 0 7px var(--stk-mode,#3b82f6);',
        'transition:background .2s ease,box-shadow .2s ease;',
      '}',
      '#' + INDICATOR_ID + '.stk-pop .stk-mode-dot{animation:stk-mode-pop .35s ease;}',
      '#' + INDICATOR_ID + ' .stk-mode-label{font-variant-numeric:tabular-nums;letter-spacing:.02em;}',
      '@keyframes stk-mode-pop{0%{transform:scale(1);}40%{transform:scale(1.5);}100%{transform:scale(1);}}',
      '@media (prefers-reduced-motion:reduce){#' + INDICATOR_ID + '.stk-pop .stk-mode-dot{animation:none;}}'
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  // The pill, lazily (re)created inside the player. Returns null if the player
  // isn't in the DOM yet. Re-attaches if YouTube re-rendered the player subtree.
  function ensureIndicator() {
    var player = document.querySelector('.html5-video-player');
    if (!player) return null;
    var el = document.getElementById(INDICATOR_ID);
    if (el && el.isConnected && el.parentNode === player) return el;
    ensureIndicatorStyle();
    el = document.createElement('div');
    el.id = INDICATOR_ID;
    var dot = document.createElement('span');
    dot.className = 'stk-mode-dot';
    var label = document.createElement('span');
    label.className = 'stk-mode-label';
    el.appendChild(dot);
    el.appendChild(label);
    player.appendChild(el);
    return el;
  }

  var lastMode = null; // key of the displayed mode, to skip redundant per-frame work

  function setMode(code, rate) {
    var isSkip = (code != null) ? code === SKIP_CODE : rate >= 10;
    var color = (code != null) ? codeColor(code) : rateColor(rate);
    var text = isSkip ? 'Skip' : (rate + 'x');
    var key = text + '|' + color;
    var el = ensureIndicator();
    if (!el) { lastMode = null; return; }
    if (key === lastMode && el.querySelector('.stk-mode-label').textContent === text) return;
    lastMode = key;
    var dot = el.querySelector('.stk-mode-dot');
    dot.style.setProperty('--stk-mode', color);
    el.querySelector('.stk-mode-label').textContent = text;
    // Restart the pop: pull the class, force a reflow, re-add — so the dot ticks
    // every time the mode changes, not just the first.
    el.classList.remove('stk-pop');
    void el.offsetWidth;
    el.classList.add('stk-pop');
  }

  function hideMode() {
    var el = document.getElementById(INDICATOR_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    lastMode = null;
  }

  window.SpeedTrackTimeline = {
    render: render,
    renderSegments: renderSegments,
    refreshSegments: refreshSegments,
    clear: clear,
    pin: pin,
    unpin: unpin,
    setMode: setMode,
    hideMode: hideMode
  };
})();
