// video-id.js — pure, no DOM. Extracts the YouTube video id from a URL.
//
// Handles the shapes a track might be matched against:
//   watch?v=<id>        (standard watch page; ?v= may sit among other params)
//   /shorts/<id>        (Shorts)
//   /embed/<id>         (embedded player)
//   /live/<id>          (live/premiere permalink)
//   youtu.be/<id>       (short share links)
//
// extractVideoId(urlOrLocation) -> id string, or null if none is present.
// Accepts a string URL or anything with .href (e.g. window.location).

(function (root) {
  'use strict';

  // A YouTube id is 11 chars of [A-Za-z0-9_-]. We don't enforce the length hard
  // (future-proofing), just the character class and a sane minimum.
  var ID_RE = /^[A-Za-z0-9_-]{8,}$/;

  function fromPathSegment(pathname, prefix) {
    var marker = '/' + prefix + '/';
    var i = pathname.indexOf(marker);
    if (i === -1) return null;
    var rest = pathname.slice(i + marker.length);
    var id = rest.split('/')[0];
    return ID_RE.test(id) ? id : null;
  }

  function extractVideoId(urlOrLocation) {
    if (!urlOrLocation) return null;
    var href = typeof urlOrLocation === 'string' ? urlOrLocation : urlOrLocation.href;
    if (!href) return null;

    var url;
    try {
      url = new URL(href);
    } catch (e) {
      return null;
    }

    // youtu.be/<id> — the id is the first path segment.
    if (/(^|\.)youtu\.be$/.test(url.hostname)) {
      var shortId = url.pathname.replace(/^\//, '').split('/')[0];
      return ID_RE.test(shortId) ? shortId : null;
    }

    // watch?v=<id> (also works for /watch and music.youtube.com).
    var v = url.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;

    // Path-based players.
    return fromPathSegment(url.pathname, 'shorts') ||
           fromPathSegment(url.pathname, 'embed') ||
           fromPathSegment(url.pathname, 'live');
  }

  var api = { extractVideoId: extractVideoId };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SpeedTrackVideo = api;
  }
})(typeof self !== 'undefined' ? self : this);
