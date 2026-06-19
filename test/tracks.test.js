// Minimal test runner — `node test/tracks.test.js`. Exits non-zero on failure.
// Covers the pure helpers only (URL parsing, the track-file filter, grouping);
// the network/sync methods are verified manually.
const { parseRepoUrl, treeApiUrl, rawUrl, isTrackFile, filterTreeForTracks, groupByVideo,
  videoIdFromPath, buildIndex } = require('../src/tracks.js');

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label +
    (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
}

// ---- parseRepoUrl ---------------------------------------------------------

eq('parse tree + nested path',
  parseRepoUrl('https://github.com/owner/repo/tree/main/a/b/c'),
  { owner: 'owner', repo: 'repo', branch: 'main', path: 'a/b/c' });

eq('parse tree trailing slash',
  parseRepoUrl('https://github.com/owner/repo/tree/main/tracks/'),
  { owner: 'owner', repo: 'repo', branch: 'main', path: 'tracks' });

eq('parse bare repo',
  parseRepoUrl('https://github.com/owner/repo'),
  { owner: 'owner', repo: 'repo', branch: null, path: null });

eq('parse strips .git',
  parseRepoUrl('https://github.com/owner/repo.git'),
  { owner: 'owner', repo: 'repo', branch: null, path: null });

eq('parse tree root (no path)',
  parseRepoUrl('https://github.com/owner/repo/tree/main'),
  { owner: 'owner', repo: 'repo', branch: 'main', path: null });

eq('parse url-encoded path segment',
  parseRepoUrl('https://github.com/owner/repo/tree/main/My%20Tracks'),
  { owner: 'owner', repo: 'repo', branch: 'main', path: 'My Tracks' });

eq('parse missing scheme tolerated',
  parseRepoUrl('github.com/owner/repo/tree/main/tracks'),
  { owner: 'owner', repo: 'repo', branch: 'main', path: 'tracks' });

eq('parse www host',
  parseRepoUrl('https://www.github.com/owner/repo'),
  { owner: 'owner', repo: 'repo', branch: null, path: null });

eq('parse non-github host -> null', parseRepoUrl('https://gitlab.com/owner/repo'), null);
eq('parse too few segments -> null', parseRepoUrl('https://github.com/owner'), null);
eq('parse blob form -> null', parseRepoUrl('https://github.com/owner/repo/blob/main/x.json'), null);
eq('parse tree without branch -> null', parseRepoUrl('https://github.com/owner/repo/tree'), null);
eq('parse garbage -> null', parseRepoUrl('not a url at all'), null);
eq('parse empty -> null', parseRepoUrl(''), null);
eq('parse null -> null', parseRepoUrl(null), null);

// ---- treeApiUrl / rawUrl --------------------------------------------------

eq('treeApiUrl',
  treeApiUrl({ owner: 'o', repo: 'r', branch: 'main' }),
  'https://api.github.com/repos/o/r/git/trees/main?recursive=1');

eq('rawUrl',
  rawUrl({ owner: 'o', repo: 'r', branch: 'main' }, 'tracks/Chan/VID12345_x.json'),
  'https://raw.githubusercontent.com/o/r/main/tracks/Chan/VID12345_x.json');

eq('rawUrl encodes spaces',
  rawUrl({ owner: 'o', repo: 'r', branch: 'main' }, 'My Tracks/VID12345_x.json'),
  'https://raw.githubusercontent.com/o/r/main/My%20Tracks/VID12345_x.json');

// ---- isTrackFile ----------------------------------------------------------

eq('track file directly under base',
  isTrackFile('tracks/VID12345_focus.json', 'tracks', 0), true);

eq('channel-deep excluded at depth 0',
  isTrackFile('tracks/Chan/VID12345_focus.json', 'tracks', 0), false);

eq('channel-deep included at depth 1',
  isTrackFile('tracks/Chan/VID12345_focus.json', 'tracks', 1), true);

eq('sub-sub excluded at depth 1',
  isTrackFile('tracks/Chan/Sub/VID12345_focus.json', 'tracks', 1), false);

eq('unlimited depth (-1) includes deep file',
  isTrackFile('tracks/a/b/c/VID12345_focus.json', 'tracks', -1), true);

eq('no maxDepth means unlimited',
  isTrackFile('tracks/a/b/VID12345_focus.json', 'tracks', null), true);

eq('non-json excluded',
  isTrackFile('tracks/VID12345_focus.txt', 'tracks', 0), false);

eq('non-track-shaped basename excluded (README)',
  isTrackFile('tracks/README.json', 'tracks', 0), false);

eq('non-track-shaped basename excluded (index)',
  isTrackFile('tracks/index.json', 'tracks', 0), false);

eq('short id excluded',
  isTrackFile('tracks/short_x.json', 'tracks', 0), false);

eq('outside base excluded',
  isTrackFile('other/VID12345_x.json', 'tracks', null), false);

eq('prefix not substring (tracksXYZ)',
  isTrackFile('tracksXYZ/VID12345_x.json', 'tracks', null), false);

eq('base at a specific channel excludes others',
  isTrackFile('tracks/Other/VID12345_x.json', 'tracks/Chan', null), false);

eq('base at a specific channel includes its files',
  isTrackFile('tracks/Chan/VID12345_x.json', 'tracks/Chan', 0), true);

eq('empty base scans from root',
  isTrackFile('VID12345_x.json', '', 0), true);

eq('uppercase extension accepted',
  isTrackFile('tracks/VID12345_x.JSON', 'tracks', 0), true);

// ---- filterTreeForTracks --------------------------------------------------

const tree = [
  { type: 'blob', path: 'tracks/VID12345_a.json' },
  { type: 'tree', path: 'tracks/Chan' },
  { type: 'blob', path: 'tracks/Chan/VID67890_b.json' },
  { type: 'blob', path: 'tracks/README.json' },
  { type: 'blob', path: 'other/VID00000_c.json' }
];
eq('filter depth 1 keeps matching blobs only',
  filterTreeForTracks(tree, 'tracks', 1),
  ['tracks/VID12345_a.json', 'tracks/Chan/VID67890_b.json']);
eq('filter depth 0 keeps only top-level',
  filterTreeForTracks(tree, 'tracks', 0),
  ['tracks/VID12345_a.json']);

// ---- groupByVideo ---------------------------------------------------------

eq('groupByVideo groups by youtubeVideoId',
  groupByVideo([
    { youtubeVideoId: 'a', title: '1' },
    { youtubeVideoId: 'b', title: '2' },
    { youtubeVideoId: 'a', title: '3' }
  ]),
  { a: [{ youtubeVideoId: 'a', title: '1' }, { youtubeVideoId: 'a', title: '3' }],
    b: [{ youtubeVideoId: 'b', title: '2' }] });

eq('groupByVideo skips id-less', groupByVideo([{ title: 'x' }]), {});

// ---- videoIdFromPath ------------------------------------------------------

eq('videoIdFromPath nested', videoIdFromPath('tracks/Chan/VID12345_focus.json'), 'VID12345');
eq('videoIdFromPath root', videoIdFromPath('0aQaNG9Ao7Y_focus-on-throws.json'), '0aQaNG9Ao7Y');
eq('videoIdFromPath no underscore -> null', videoIdFromPath('tracks/README.json'), null);
eq('videoIdFromPath empty -> null', videoIdFromPath(''), null);

// ---- buildIndex -----------------------------------------------------------

eq('buildIndex groups by filename id',
  buildIndex(['tracks/AAAAAAAA_a.json', 'tracks/Chan/AAAAAAAA_b.json', 'tracks/BBBBBBBB_c.json']),
  { AAAAAAAA: ['tracks/AAAAAAAA_a.json', 'tracks/Chan/AAAAAAAA_b.json'],
    BBBBBBBB: ['tracks/BBBBBBBB_c.json'] });
eq('buildIndex empty', buildIndex([]), {});

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
