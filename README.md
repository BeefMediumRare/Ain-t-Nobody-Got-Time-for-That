# Ain't Nobody Got Time for That

> **Note:** This whole project is purely vibe-coded. Every line was produced by prompting an AI assistant in conversation, not written by hand. Keep that in mind before relying on it.

A Firefox extension that controls YouTube playback speed from a list of timestamps. Watch most of a video sped up and have it drop back to normal speed automatically for the parts you want to see at full detail, without holding a key down or adjusting the speed by hand.

## Load it (temporary)

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** and pick `manifest.json` in this folder
3. Open a YouTube video and click the toolbar icon
4. Record a track (see below) or import one, then pick it from the list and hit **Apply**, and press play

The add-on unloads when Firefox closes, so reload it the same way next session. Saved tracks live in the extension's `storage.local`, so they persist across reloads and reappear automatically for the video they were recorded on.

The toolbar icon shows a **blue badge** with the number of tracks available for the current video — your own plus any synced from repositories (red while recording). **Stop & reset to 1×** in the popup drops the active track and returns the video to normal speed.

## Record a track (authoring mode)

Rather than typing timestamps by hand, record them while watching:

1. Press **`Alt+Shift+R`** (or use the toolbar icon and **Start recording**) to begin. The icon shows a red badge. The chord keeps this always-on shortcut from firing while you type.
2. Press a digit **`1`–`4`** to set a speed: `1`=normal, `2`=fast, `3`=faster, `4`=skip. The first press sets the baseline at `0:00` wherever you are; every press after that uses the current playback time, so you can jump around freely. The badge count goes up each time.
3. Press **`Alt+Shift+R`** again (or the icon and **End recording**) to stop.
4. Open the toolbar icon, give the recording a **title** (and optional description), and **Save**. It's now stored for this video — pick it from the list and hit **Apply** to check it. Next time you open this video it's there automatically.

Each entry is a **cue** (a timestamp plus a speed). To fix a cue, press a digit again near it: a press within **±2s** of the nearest existing cue updates that cue's speed instead of adding a duplicate (`MERGE_WINDOW_SEC` in `src/author.js`). Because of this, two distinct cues have to be more than ~4s apart (twice the window). Lower it if you need tighter segments.

**Deleting a cue:** a cue that matches the speed of the cue right before it does nothing, so it isn't created when adding or is removed when editing. To delete a cue, set it to the same speed as the segment before it. Normal playback keys (space, `k`, `j`, `l`, arrows) keep working throughout.

**Editing a saved track:** hit **Edit** on a track to reopen it as a recording, seeded with its cues. Adjust whatever you want (or nothing — you might only be changing the title or description), then end the session to bring back the save dialog. Keep the title to overwrite the track, or change it to save a separate one. Tracks from a repository are read-only, so only local ones can be edited or deleted.

## Track format

A track is a JSON document linked to a YouTube video by id. A video can have several tracks; they're matched by `youtubeVideoId`. Each cue's `speed` is a **code** (`"1"`–`"4"`), not a fixed rate — the code→rate mapping is a per-user preference, so a shared track plays at whatever speeds the viewer has configured.

```json
{
  "schemaVersion": 1,
  "youtubeVideoId": "dQw4w9WgXcQ",
  "title": "Skip the intro",
  "description": "Optional notes.",
  "cues": [
    { "timestamp": "0:00", "speed": "2" },
    { "timestamp": "1:23", "speed": "1" },
    { "timestamp": "1:31", "speed": "2" },
    { "timestamp": "3:05", "speed": "4" }
  ]
}
```

- Codes: `1`=normal (1x), `2`=fast (2x), `3`=faster (2.5x), `4`=skip (10x). The mapping is `SPEED_LEVELS` in `src/parser.js`, persisted (and overridable later) via `src/storage.js`; slower codes `-1..-4` would go here too.
- Timestamps: `h:mm:ss`, `mm:ss`, or raw seconds (`90.5`).
- A speed applies from its timestamp until the next cue. Before the first cue the rate is left untouched (add a `0:00` cue for a baseline from the start).

**Where tracks come from:** they're recorded or imported (the **Import track (JSON)** panel takes a document in the shape above) and saved to the extension's `storage.local`, or synced read-only from a GitHub repository (see below). **Download** a track to get a `<videoId>_<title>.json` file you can commit to a shared repository — the filename is prefixed with the video id so a repo can be scanned for matching tracks.

## Track repositories (GitHub)

You can point the extension at one or more **public GitHub repository folders** and have the tracks they contain show up — read-only — alongside your own. Open **Manage repositories…** from the popup (the options page) and paste a folder URL like:

```
https://github.com/owner/repo/tree/main/tracks
```

- On **Add**, Firefox asks for permission to reach GitHub (only when you add your first repo), then the folder is **synced**: its track files are fetched and stored locally, tagged with the repository. Opening a video afterwards reads from storage — no network call — so repo tracks work offline and are counted in the badge.
- Repo tracks are **read-only**: you can **Apply** and **Download** them, but not edit or delete them, and you can't save a local track over a repo track's title (change the title to keep your own copy).
- **Subfolder scanning** is off by default, so only the folder you point at is read. Turn it on to scan every subfolder, however deep. For a repo split one-folder-per-channel, either point the URL straight at a channel folder (scanning off), or point at the parent and turn scanning on. Layout is otherwise up to you — files are matched by the `<videoId>_…json` filename and validated content.
- **Refresh** re-syncs a repo (in the options page per-repo, or **Refresh repositories** in the popup for all of them). Listing uses one GitHub API request per repo via the Git Trees API, with an `ETag` so an unchanged repo costs nothing; the track files themselves come from the `raw.githubusercontent.com` CDN, which isn't rate-limited. Unauthenticated GitHub allows 60 API requests/hour, so manual refresh stays well clear.
- **Delete** removes the repo and all the tracks it synced (it tells you how many first). To change a repo's URL or depth, delete it and add it again.

How tracks are organized in the repo is your call. A reasonable convention is one subfolder per YouTube channel:

```
tracks/
  SomeChannel/
    dQw4w9WgXcQ_skip-the-intro.json
```

## Tip

If you also run the **videospeed** extension, disable it on YouTube while testing. Both write `playbackRate` and will fight each other.

## Tests

```
node test/parser.test.js
node test/video-id.test.js
node test/tracks.test.js
```

## Contributing

Pull requests are welcome — anyone can open one. Merging is up to the maintainers.

## License

[MIT](LICENSE). Do what you like with it.
