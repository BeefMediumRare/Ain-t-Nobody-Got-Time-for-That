// storage.js — the persistence layer (WebExtensions storage.local).
//
// Wraps browserApi.storage.local in a small promise-based API. In Firefox this is
// browser.storage.local (natively promise-returning); the browserApi shim keeps it
// working under Chrome too. Requires the "storage" permission in the manifest.
//
// Persisted state:
//   tracks       { [videoId]: Track[] }  — saved/imported local tracks, by video id
//   repoTracks   { [sourceId]: { syncedAt, etag, byVideo } } — read-only tracks
//                                           synced from a GitHub source
//   speedLevels  { "1":1, "2":2, ... }   — code->rate prefs (edited in Settings)
//   showSegments boolean                 — draw the speed bands on the progress
//                                           bar during playback (default true)
//   sources      [{ id, type, label }]   — track repositories: "local" plus
//                                           configured GitHub repos
//
// Exposed as the global SpeedTrackStore (popup/background/options pages).

(function (root) {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser :
                   (typeof chrome !== 'undefined' ? chrome : null);

  var SCHEMA_VERSION =
    (typeof SpeedTrack !== 'undefined' && SpeedTrack.SCHEMA_VERSION) || 1;

  var KEYS = {
    schemaVersion: 'speedTrack.schemaVersion',
    tracks: 'speedTrack.tracks',
    repoTracks: 'speedTrack.repoTracks',
    speedLevels: 'speedTrack.speedLevels',
    showSegments: 'speedTrack.showSegments',
    sources: 'speedTrack.sources'
  };

  // A stable internal id for a track. Used for local and synced repo tracks.
  function genId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : ('trk-' + Date.now() + '-' + Math.round(Math.random() * 1e9));
  }

  function defaultSpeedLevels() {
    var src = (typeof SpeedTrack !== 'undefined' && SpeedTrack.SPEED_LEVELS) ||
              { 1: 1, 2: 2, 3: 2.5, 4: 10 };
    var out = {};
    for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) out[String(k)] = src[k];
    return out;
  }

  // The implicit, always-present source. Configured GitHub repos (type:'github')
  // are appended to this array.
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

  // Save a track. Keyed by youtubeVideoId; the stable internal id is the identity,
  // so editing a track updates it in place even when its title changes (and never
  // spawns a copy). When no id matches we fall back to a title match — that's how a
  // fresh recording or an import overwrites an existing same-titled track — and
  // otherwise the track is added with a freshly minted id.
  function saveTrack(track) {
    if (!track || !track.youtubeVideoId) {
      return Promise.reject(new Error('Track is missing youtubeVideoId.'));
    }
    return getAllTracks().then(function (all) {
      var list = all[track.youtubeVideoId] ? all[track.youtubeVideoId].slice() : [];
      var idx = track.id ? list.findIndex(function (t) { return t.id === track.id; }) : -1;
      if (idx < 0) idx = list.findIndex(function (t) { return t.title === track.title; });
      if (idx >= 0) {
        track.id = list[idx].id || track.id || genId();
        list[idx] = track;
      } else {
        track.id = track.id || genId();
        list.push(track);
      }
      all[track.youtubeVideoId] = list;
      return set(KEYS.tracks, all).then(function () { return track; });
    });
  }

  function deleteTrack(videoId, id) {
    return getAllTracks().then(function (all) {
      var list = all[videoId];
      if (!list) return;
      var next = list.filter(function (t) { return t.id !== id; });
      if (next.length) all[videoId] = next; else delete all[videoId];
      return set(KEYS.tracks, all);
    });
  }

  // ---- Repo tracks (read-only, synced from GitHub sources) ------------------
  //
  // Shape: { [sourceId]: { syncedAt, etag, byVideo: { [videoId]: Track[] } } }.
  // The etag drives conditional refresh; tracks are replaced wholesale on a 200
  // and left untouched on a 304 (see tracks.js).

  function getAllRepoTracks() {
    return get(KEYS.repoTracks).then(function (v) { return v || {}; });
  }

  function getRepoTracksMeta(sourceId) {
    return getAllRepoTracks().then(function (all) {
      var e = all[sourceId];
      return e ? { syncedAt: e.syncedAt, etag: e.etag } : null;
    });
  }

  function getRepoTracksForVideo(videoId) {
    if (!videoId) return Promise.resolve([]);
    return getAllRepoTracks().then(function (all) {
      var out = [];
      Object.keys(all).forEach(function (sid) {
        var byVideo = all[sid] && all[sid].byVideo;
        var list = byVideo && byVideo[videoId];
        if (list) out = out.concat(list);
      });
      return out;
    });
  }

  function setRepoTracks(sourceId, byVideo, meta) {
    return getAllRepoTracks().then(function (all) {
      var prior = all[sourceId];
      all[sourceId] = {
        syncedAt: (meta && meta.syncedAt != null) ? meta.syncedAt : Date.now(),
        etag: (meta && meta.etag != null) ? meta.etag : (prior && prior.etag) || null,
        byVideo: byVideo || {}
      };
      return set(KEYS.repoTracks, all);
    });
  }

  // Update only the sync metadata (after a 304 refresh), keeping stored tracks.
  function touchRepoTracks(sourceId, meta) {
    return getAllRepoTracks().then(function (all) {
      if (!all[sourceId]) return;
      if (meta && meta.syncedAt != null) all[sourceId].syncedAt = meta.syncedAt;
      if (meta && meta.etag != null) all[sourceId].etag = meta.etag;
      return set(KEYS.repoTracks, all);
    });
  }

  function deleteRepoTracks(sourceId) {
    return getAllRepoTracks().then(function (all) {
      if (!all[sourceId]) return;
      delete all[sourceId];
      return set(KEYS.repoTracks, all);
    });
  }

  function countRepoTracks(sourceId) {
    return getAllRepoTracks().then(function (all) {
      var e = all[sourceId];
      if (!e || !e.byVideo) return 0;
      var n = 0;
      Object.keys(e.byVideo).forEach(function (v) { n += e.byVideo[v].length; });
      return n;
    });
  }

  // ---- Speed preferences ----------------------------------------------------

  function getSpeedLevels() {
    return get(KEYS.speedLevels).then(function (v) { return v || defaultSpeedLevels(); });
  }

  function setSpeedLevels(map) {
    return set(KEYS.speedLevels, map);
  }

  // Whether playback draws the colored speed bands on the progress bar. Defaults
  // on; only an explicit false hides them.
  function getShowSegments() {
    return get(KEYS.showSegments).then(function (v) { return v !== false; });
  }

  function setShowSegments(on) {
    return set(KEYS.showSegments, !!on);
  }

  // ---- Sources / repositories -----------------------------------------------

  function getSources() {
    return get(KEYS.sources).then(function (v) {
      return (Array.isArray(v) && v.length) ? v : defaultSources();
    });
  }

  // Add a configured GitHub source. Persists the full array (with "local"
  // pinned at the front) and returns the stored source, id assigned.
  function addSource(source) {
    return getSources().then(function (sources) {
      var arr = sources.slice();
      if (!arr.some(function (s) { return s.id === 'local'; })) arr.unshift(defaultSources()[0]);
      var stored = {};
      for (var k in source) if (Object.prototype.hasOwnProperty.call(source, k)) stored[k] = source[k];
      stored.id = genId();
      stored.type = 'github';
      arr.push(stored);
      return set(KEYS.sources, arr).then(function () { return stored; });
    });
  }

  // Delete a source and its synced tracks. "local" cannot be removed.
  function deleteSource(id) {
    if (id === 'local') return Promise.reject(new Error('The local source cannot be removed.'));
    return getSources().then(function (sources) {
      var arr = sources.filter(function (s) { return s.id !== id; });
      return set(KEYS.sources, arr);
    }).then(function () { return deleteRepoTracks(id); });
  }

  // Assign ids to any pre-existing local tracks that predate the id field.
  function backfillTrackIds() {
    return getAllTracks().then(function (all) {
      var changed = false;
      Object.keys(all).forEach(function (vid) {
        all[vid].forEach(function (t) { if (!t.id) { t.id = genId(); changed = true; } });
      });
      return changed ? set(KEYS.tracks, all) : undefined;
    });
  }

  // Stamp the schema version once so future migrations have a baseline, and
  // backfill track ids for tracks saved before that field existed.
  function ensureSeeded() {
    return backfillTrackIds().then(function () {
      return get(KEYS.schemaVersion).then(function (v) {
        if (v) return;
        return set(KEYS.schemaVersion, SCHEMA_VERSION);
      });
    });
  }

  root.SpeedTrackStore = {
    KEYS: KEYS,
    getAllTracks: getAllTracks,
    getTracksForVideo: getTracksForVideo,
    saveTrack: saveTrack,
    deleteTrack: deleteTrack,
    getAllRepoTracks: getAllRepoTracks,
    getRepoTracksMeta: getRepoTracksMeta,
    getRepoTracksForVideo: getRepoTracksForVideo,
    setRepoTracks: setRepoTracks,
    touchRepoTracks: touchRepoTracks,
    deleteRepoTracks: deleteRepoTracks,
    countRepoTracks: countRepoTracks,
    getSpeedLevels: getSpeedLevels,
    setSpeedLevels: setSpeedLevels,
    getShowSegments: getShowSegments,
    setShowSegments: setShowSegments,
    getSources: getSources,
    addSource: addSource,
    deleteSource: deleteSource,
    ensureSeeded: ensureSeeded
  };
})(typeof self !== 'undefined' ? self : this);
