// tracks.js — track sources: the local device plus read-only GitHub repos.
//
// A "source" is either the implicit local device or a public GitHub repository
// folder. Repo tracks are *synced* into storage.local (tagged with the repo's
// source id) on add and on manual refresh, then read back like local tracks —
// so opening a video never hits the network. GitHub is contacted only here.
//
// Listing strategy (one rate-limited request per repo, regardless of depth):
//   GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1   -> the whole tree
//   raw.githubusercontent.com/...                              -> file content (CDN, free)
// Conditional refresh stores the tree's ETag and sends If-None-Match; a 304 is
// free and means "no new tracks".
//
// The pure helpers (parseRepoUrl, isTrackFile, ...) are unit-tested; the network
// methods are exercised manually. Exposed as the global SpeedTrackSources.

(function (root) {
  'use strict';

  var browserApi = (typeof browser !== 'undefined') ? browser :
                   (typeof chrome !== 'undefined' ? chrome : null);

  // Resolved from SpeedTrack when present (browser), else the same literal.
  var TRACK_EXT = (typeof SpeedTrack !== 'undefined' && SpeedTrack.TRACK_EXT) || '.json';

  var API_BASE = 'https://api.github.com';
  var RAW_BASE = 'https://raw.githubusercontent.com';

  var MAX_FILES = 500;            // per repo, per sync — guard against abuse
  var MAX_FILE_BYTES = 256 * 1024;
  var FETCH_CONCURRENCY = 4;

  // ---- Pure helpers (tested) ------------------------------------------------

  // Parse a GitHub repo-folder URL into { owner, repo, branch, path }. branch and
  // path are null when the URL doesn't carry them (a bare repo URL). Returns null
  // for anything that isn't a github.com repo URL. A missing scheme is tolerated.
  function parseRepoUrl(url) {
    if (url == null) return null;
    var str = String(url).trim();
    if (!str) return null;

    var u = null;
    try { u = new URL(str); }
    catch (e) {
      try { u = new URL('https://' + str); }
      catch (e2) { return null; }
    }

    var host = u.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') return null;

    var segs = u.pathname.split('/').filter(function (s) { return s.length > 0; });
    if (segs.length < 2) return null;

    var owner = decodeURIComponent(segs[0]);
    var repo = decodeURIComponent(segs[1]).replace(/\.git$/, '');
    if (!owner || !repo) return null;

    if (segs.length === 2) return { owner: owner, repo: repo, branch: null, path: null };

    // Only the /tree/<branch>/<path...> form carries a folder. (Slashed branch
    // names are ambiguous in this form and treated as branch = segs[3].)
    if (segs[2] !== 'tree') return null;
    var branch = segs[3] ? decodeURIComponent(segs[3]) : null;
    if (!branch) return null;

    var pathSegs = segs.slice(4).map(function (s) { return decodeURIComponent(s); });
    return { owner: owner, repo: repo, branch: branch, path: pathSegs.length ? pathSegs.join('/') : null };
  }

  function treeApiUrl(parsed) {
    return API_BASE + '/repos/' + parsed.owner + '/' + parsed.repo +
      '/git/trees/' + encodeURIComponent(parsed.branch) + '?recursive=1';
  }

  function rawUrl(parsed, filePath) {
    var encoded = String(filePath).split('/').map(encodeURIComponent).join('/');
    return RAW_BASE + '/' + parsed.owner + '/' + parsed.repo + '/' +
      encodeURIComponent(parsed.branch) + '/' + encoded;
  }

  // Does this tree path look like a track file within the configured folder?
  //   - under basePath (prefix match on a folder boundary, so 'tracks' != 'tracksX')
  //   - within maxDepth folders below basePath (0 = directly in it; <0/null = any)
  //   - basename is "<id>_<...><ext>", id being 8+ id-chars (matches video-id.js)
  // Content is still validated separately; this is just a cheap pre-filter.
  function isTrackFile(path, basePath, maxDepth) {
    if (!path) return false;
    var base = basePath ? String(basePath).replace(/^\/+|\/+$/g, '') : '';
    var prefix = base ? base + '/' : '';
    if (prefix && path.indexOf(prefix) !== 0) return false;

    var rel = path.slice(prefix.length);
    if (!rel) return false;

    if (maxDepth != null && maxDepth >= 0) {
      var depth = rel.split('/').length - 1;
      if (depth > maxDepth) return false;
    }

    var name = rel.split('/').pop();
    return /^[A-Za-z0-9_-]{8,}_.+/.test(name) &&
      name.slice(-TRACK_EXT.length).toLowerCase() === TRACK_EXT;
  }

  // From a git-tree listing, the blob paths that look like track files.
  function filterTreeForTracks(treeEntries, basePath, maxDepth) {
    var out = [];
    var entries = treeEntries || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || e.type !== 'blob' || !e.path) continue;
      if (isTrackFile(e.path, basePath, maxDepth)) out.push(e.path);
    }
    return out;
  }

  // Group validated tracks into { [videoId]: Track[] }.
  function groupByVideo(tracks) {
    var out = {};
    var list = tracks || [];
    for (var i = 0; i < list.length; i++) {
      var vid = list[i] && list[i].youtubeVideoId;
      if (!vid) continue;
      (out[vid] = out[vid] || []).push(list[i]);
    }
    return out;
  }

  // ---- Internal (browser) helpers -------------------------------------------

  function genId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : ('rt-' + Date.now() + '-' + Math.round(Math.random() * 1e9));
  }

  function formatReset(resetSeconds) {
    try { return new Date(Number(resetSeconds) * 1000).toLocaleTimeString(); }
    catch (e) { return ''; }
  }

  // Fetch the recursive git tree, using the stored ETag for a free 304 when
  // nothing changed. Resolves { unchanged } or { tree, truncated, etag }.
  function getTree(source) {
    var parsed = { owner: source.owner, repo: source.repo, branch: source.branch };
    return SpeedTrackStore.getRepoTracksMeta(source.id).then(function (meta) {
      var headers = { 'Accept': 'application/vnd.github+json' };
      if (meta && meta.etag) headers['If-None-Match'] = meta.etag;
      return fetch(treeApiUrl(parsed), { cache: 'no-cache', headers: headers });
    }).then(function (res) {
      if (res.status === 304) return { unchanged: true };
      if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
        var reset = formatReset(res.headers.get('x-ratelimit-reset'));
        var err = new Error('GitHub rate limit reached' + (reset ? ' (resets ' + reset + ')' : '') + '.');
        err.code = 'RATE_LIMITED';
        throw err;
      }
      if (res.status === 404) {
        throw new Error('Repository or branch not found. Only public repos are supported — ' +
          'check the URL and make sure the repository isn’t private.');
      }
      if (!res.ok) throw new Error('GitHub listing failed (' + res.status + ').');
      var etag = res.headers.get('etag');
      return res.json().then(function (json) {
        return { unchanged: false, tree: json.tree || [], truncated: !!json.truncated, etag: etag };
      });
    });
  }

  function fetchText(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('fetch failed (' + res.status + ')');
      var len = res.headers.get('content-length');
      if (len && Number(len) > MAX_FILE_BYTES) throw new Error('file too large');
      return res.text();
    }).then(function (text) {
      if (text.length > MAX_FILE_BYTES) throw new Error('file too large');
      return text;
    });
  }

  // Fetch many files with a bounded pool. A failed file resolves to text:null.
  function fetchAll(items) {
    var results = new Array(items.length);
    var next = 0;
    function worker() {
      if (next >= items.length) return Promise.resolve();
      var i = next++;
      return fetchText(items[i].url).then(function (text) {
        results[i] = { path: items[i].path, text: text };
      }, function () {
        results[i] = { path: items[i].path, text: null };
      }).then(worker);
    }
    var workers = [];
    var n = Math.min(FETCH_CONCURRENCY, items.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  function countByVideo(byVideo) {
    var n = 0;
    Object.keys(byVideo || {}).forEach(function (v) { n += byVideo[v].length; });
    return n;
  }

  // Sync one GitHub source into storage. Replaces its stored tracks on a 200;
  // a 304 leaves them untouched. Resolves { unchanged, count, notices }.
  function syncSource(source) {
    var parsed = { owner: source.owner, repo: source.repo, branch: source.branch };
    var notices = [];
    return Promise.all([getTree(source), SpeedTrackStore.getAllRepoTracks()]).then(function (arr) {
      var tree = arr[0];
      var priorEntry = arr[1][source.id];

      if (tree.unchanged) {
        return SpeedTrackStore.touchRepoTracks(source.id, { syncedAt: Date.now() }).then(function () {
          return { unchanged: true, count: priorEntry ? countByVideo(priorEntry.byVideo) : 0, notices: notices };
        });
      }

      if (tree.truncated) {
        notices.push('Repository tree was too large to list fully; some tracks may be missing.');
      }

      var paths = filterTreeForTracks(tree.tree, source.path, source.maxDepth);
      if (paths.length > MAX_FILES) {
        notices.push('Found ' + paths.length + ' track files; synced only the first ' + MAX_FILES + '.');
        paths = paths.slice(0, MAX_FILES);
      }

      // Keep a stable track id for the same file across re-syncs.
      var priorIdByPath = {};
      if (priorEntry && priorEntry.byVideo) {
        Object.keys(priorEntry.byVideo).forEach(function (vid) {
          priorEntry.byVideo[vid].forEach(function (t) { if (t.sourcePath) priorIdByPath[t.sourcePath] = t.id; });
        });
      }

      var items = paths.map(function (p) { return { path: p, url: rawUrl(parsed, p) }; });
      return fetchAll(items).then(function (results) {
        var tracks = [];
        results.forEach(function (r) {
          if (!r || r.text == null) return;
          var v = SpeedTrack.validateTrack(r.text);
          if (v.errors.length || !v.track) return;
          var t = v.track;
          t.id = priorIdByPath[r.path] || genId();
          t.sourceId = source.id;
          t.sourcePath = r.path;
          tracks.push(t);
        });
        var byVideo = groupByVideo(tracks);
        return SpeedTrackStore.setRepoTracks(source.id, byVideo, { syncedAt: Date.now(), etag: tree.etag })
          .then(function () { return { unchanged: false, count: tracks.length, notices: notices }; });
      });
    });
  }

  // Resolve a repo's default branch when the URL didn't pin one.
  function resolveBranch(parsed) {
    if (parsed.branch) return Promise.resolve(parsed.branch);
    return fetch(API_BASE + '/repos/' + parsed.owner + '/' + parsed.repo, {
      cache: 'no-cache', headers: { 'Accept': 'application/vnd.github+json' }
    }).then(function (res) {
      if (res.status === 404) {
        throw new Error('Repository not found. Only public repos are supported — ' +
          'check the URL and make sure the repository isn’t private.');
      }
      if (!res.ok) throw new Error('Could not read the repository (' + res.status + ').');
      return res.json();
    }).then(function (j) {
      if (!j.default_branch) throw new Error('Repository has no default branch.');
      return j.default_branch;
    });
  }

  // Add a GitHub source and sync it once. Rolls the source back if the first
  // sync fails, so a broken repo isn't left half-configured.
  function addAndSync(opts) {
    var parsed = opts.parsed;
    return resolveBranch(parsed).then(function (branch) {
      var source = {
        type: 'github',
        label: opts.label || (parsed.owner + '/' + parsed.repo),
        url: opts.url || '',
        owner: parsed.owner,
        repo: parsed.repo,
        branch: branch,
        path: parsed.path || null,
        maxDepth: (opts.maxDepth == null ? 0 : opts.maxDepth)
      };
      return SpeedTrackStore.addSource(source).then(function (stored) {
        return syncSource(stored).then(function (result) {
          return { source: stored, count: result.count, notices: result.notices };
        }, function (err) {
          return SpeedTrackStore.deleteSource(stored.id).then(function () { throw err; }, function () { throw err; });
        });
      });
    });
  }

  function findSource(id) {
    return SpeedTrackStore.getSources().then(function (sources) {
      for (var i = 0; i < sources.length; i++) if (sources[i].id === id) return sources[i];
      return null;
    });
  }

  function refreshSource(id) {
    return findSource(id).then(function (s) {
      if (!s || s.type !== 'github') return null;
      return syncSource(s);
    });
  }

  // Refresh all GitHub sources sequentially (gentle on the rate limit). Resolves
  // an array of { source, result } / { source, error } — never rejects per-source.
  function refreshAll() {
    return SpeedTrackStore.getSources().then(function (sources) {
      var gh = sources.filter(function (s) { return s.type === 'github'; });
      return gh.reduce(function (p, s) {
        return p.then(function (acc) {
          return syncSource(s).then(
            function (r) { acc.push({ source: s, result: r }); return acc; },
            function (err) { acc.push({ source: s, error: err }); return acc; }
          );
        });
      }, Promise.resolve([]));
    });
  }

  // Tracks for a video across all sources (storage only, no network). Local
  // tracks are writable; repo tracks are read-only and carry their source label.
  // On a title clash for the same video, the local copy wins.
  function listTracksForVideo(videoId) {
    if (!videoId) return Promise.resolve({ entries: [], notices: [] });
    return Promise.all([
      SpeedTrackStore.getTracksForVideo(videoId),
      SpeedTrackStore.getRepoTracksForVideo(videoId),
      SpeedTrackStore.getSources()
    ]).then(function (arr) {
      var local = arr[0], repo = arr[1], sources = arr[2];
      var labelById = {};
      sources.forEach(function (s) { labelById[s.id] = s.label; });

      var entries = [];
      var localTitles = {};
      local.forEach(function (t) {
        localTitles[t.title] = true;
        entries.push({ track: t, writable: true, sourceId: 'local', sourceLabel: 'This device' });
      });
      repo.forEach(function (t) {
        if (localTitles[t.title]) return;
        entries.push({ track: t, writable: false, sourceId: t.sourceId, sourceLabel: labelById[t.sourceId] || 'Repository' });
      });
      return { entries: entries, notices: [] };
    });
  }

  var api = {
    parseRepoUrl: parseRepoUrl,
    treeApiUrl: treeApiUrl,
    rawUrl: rawUrl,
    isTrackFile: isTrackFile,
    filterTreeForTracks: filterTreeForTracks,
    groupByVideo: groupByVideo,
    syncSource: syncSource,
    resolveBranch: resolveBranch,
    addAndSync: addAndSync,
    refreshSource: refreshSource,
    refreshAll: refreshAll,
    listTracksForVideo: listTracksForVideo
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.SpeedTrackSources = api;
  }
})(typeof self !== 'undefined' ? self : this);
