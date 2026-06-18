// Minimal test runner — `node test/video-id.test.js`. Exits non-zero on failure.
const { extractVideoId } = require('../src/video-id.js');

let failed = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label +
    (ok ? '' : '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)));
}

// standard watch page (id among other params)
eq('watch', extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('watch with params', extractVideoId('https://www.youtube.com/watch?list=PL&v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
eq('music subdomain', extractVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

// path-based players
eq('shorts', extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
eq('embed', extractVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1'), 'dQw4w9WgXcQ');
eq('live', extractVideoId('https://www.youtube.com/live/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

// short share links
eq('youtu.be', extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');

// location-like object (has .href)
eq('location object', extractVideoId({ href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }), 'dQw4w9WgXcQ');

// no id present
eq('home page -> null', extractVideoId('https://www.youtube.com/'), null);
eq('feed page -> null', extractVideoId('https://www.youtube.com/feed/subscriptions'), null);
eq('empty -> null', extractVideoId(''), null);
eq('garbage -> null', extractVideoId('not a url'), null);
eq('null -> null', extractVideoId(null), null);

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);
