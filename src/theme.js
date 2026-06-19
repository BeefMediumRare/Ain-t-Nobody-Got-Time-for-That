// theme.js — the shared palette for the JS-drawn surfaces: the timeline bands,
// the toolbar badge, and the popup's per-track speed-strip. These can't read CSS
// variables, so the values live here as the single JS source of truth. They
// mirror the :root tokens in popup.css — keep the two in sync.
//
// Loaded as a plain global (window.SpeedTrackTheme) into the popup, the options
// page, the content scripts, and the background — ahead of everything that uses it.

(function (root) {
  'use strict';

  var theme = {
    // Speed ramp by code (1 normal, 2 fast, 3 faster, 4 skip), cool -> hot, so the
    // timeline reads as a velocity scale rather than a set of unrelated colors.
    // Normal is a clear blue (not cyan) so the first two steps don't blur together
    // on the bar — the bands also need to survive bright video behind them.
    speed: { 1: '#3b82f6', 2: '#22c55e', 3: '#f59e0b', 4: '#ef4444' },
    speedDefault: '#69728a',

    // Toolbar badge fills. Deeper than the UI accent so white badge text stays
    // legible on whatever browser chrome sits behind it.
    rec: '#dc2626',          // recording (red)
    activeBadge: '#4f46e5',  // a track is live here (indigo ▶)
    tracksBadge: '#3a4150'   // quiet count of available tracks
  };

  root.SpeedTrackTheme = theme;
  if (typeof module !== 'undefined' && module.exports) module.exports = theme;
})(typeof self !== 'undefined' ? self : this);
