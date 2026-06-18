// storage.js — the persistence layer (WebExtensions storage.local).
//
// Wraps browserApi.storage.local in a small promise-based API. In Firefox this is
// browser.storage.local (natively promise-returning); the browserApi shim keeps it
// working under Chrome too. Requires the "storage" permission in the manifest.
//
// Persisted state:
//   tracks       { [videoId]: Track[] }  — saved/imported tracks, matched by video id
//   speedLevels  { "1":1, "2":2, ... }   — code->rate prefs (no settings UI yet)
//   sources      [{ id, type, label }]   — track repositories; only "local" today,
//                                           shaped so a GitHub source slots in later
//
// Exposed as the global SpeedTrackStore (popup/background pages).

(function (root) {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser :
                   (typeof chrome !== 'undefined' ? chrome : null);

  var SCHEMA_VERSION =
    (typeof SpeedTrack !== 'undefined' && SpeedTrack.SCHEMA_VERSION) || 1;

  var KEYS = {
    schemaVersion: 'speedTrack.schemaVersion',
    tracks: 'speedTrack.tracks',
    speedLevels: 'speedTrack.speedLevels',
    sources: 'speedTrack.sources'
  };

  function defaultSpeedLevels() {
    var src = (typeof SpeedTrack !== 'undefined' && SpeedTrack.SPEED_LEVELS) ||
              { 1: 1, 2: 2, 3: 2.5, 4: 10 };
    var out = {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[String(k)] = src[k];
    return out;
  }

  // The implicit, always-present source. GitHub entries (type:'github', owner,
  // repo, branch) will be appended here once that feature lands.
  function defaultSources() {
    return [{ id: 'local', type: 'local', label: 'This device' }];
  }

  // local.get/set are promise-based in our Firefox target; wrap defensively so a
  // callback-style implementation (older Chrome) still resolves.
  function get(key) {
    return new Promise(function (resolve, reject) {
      try {
        var ret = browserApi.storage.local.get(key);
        if (ret && typeof ret.then === 'function') {
          ret.then(function (obj) { resolve(obj ? obj[key] : undefined); }, reject);
        } else {
          browserApi.storage.local.get(key, function (obj) { resolve(obj ? obj[key] : undefined); });
        }
      } catch (e) { reject(e); }
    });
  }

  function set(key, value) {
    var payload = {};
    payload[key] = value;
    return new Promise(function (resolve, reject) {
      try {
        var ret = browserApi.storage.local.set(payload);
        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
        else browserApi.storage.local.set(payload, function () { resolve(); });
      } catch (e) { reject(e); }
    });
  }

  // ---- Tracks ---------------------------------------------------------------

  function getAllTracks() {
    return get(KEYS.tracks).then(function (v) { return v || {}; });
  }

  function getTracksForVideo(videoId) {
    if (!videoId) return Promise.resolve([]);
    return getAllTracks().then(function (all) { return all[videoId] || []; });
  }

  // Save a track. Keyed by youtubeVideoId; identity within a video is the title,
  // so re-saving the same title replaces rather than duplicates.
  function saveTrack(track) {
    if (!track || !track.youtubeVideoId) {
      return Promise.reject(new Error('Track is missing youtubeVideoId.'));
    }
    return getAllTracks().then(function (all) {
      var list = all[track.youtubeVideoId] ? all[track.youtubeVideoId].slice() : [];
      var idx = list.findIndex(function (t) { return t.title === track.title; });
      if (idx >= 0) list[idx] = track; else list.push(track);
      all[track.youtubeVideoId] = list;
      return set(KEYS.tracks, all).then(function () { return track; });
    });
  }

  function deleteTrack(videoId, title) {
    return getAllTracks().then(function (all) {
      var list = all[videoId];
      if (!list) return;
      var next = list.filter(function (t) { return t.title !== title; });
      if (next.length) all[videoId] = next; else delete all[videoId];
      return set(KEYS.tracks, all);
    });
  }

  // ---- Speed preferences ----------------------------------------------------

  function getSpeedLevels() {
    return get(KEYS.speedLevels).then(function (v) { return v || defaultSpeedLevels(); });
  }

  function setSpeedLevels(map) {
    return set(KEYS.speedLevels, map);
  }

  // ---- Sources / repositories -----------------------------------------------

  function getSources() {
    return get(KEYS.sources).then(function (v) {
      return (Array.isArray(v) && v.length) ? v : defaultSources();
    });
  }

  // Stamp the schema version once so future migrations have a baseline.
  function ensureSeeded() {
    return get(KEYS.schemaVersion).then(function (v) {
      if (v) return;
      return set(KEYS.schemaVersion, SCHEMA_VERSION);
    });
  }

  root.SpeedTrackStore = {
    KEYS: KEYS,
    getAllTracks: getAllTracks,
    getTracksForVideo: getTracksForVideo,
    saveTrack: saveTrack,
    deleteTrack: deleteTrack,
    getSpeedLevels: getSpeedLevels,
    setSpeedLevels: setSpeedLevels,
    getSources: getSources,
    ensureSeeded: ensureSeeded
  };
})(typeof self !== 'undefined' ? self : this);
