# Main Tourney Manager (Tauri + Vue)

A desktop TO tool for Smash Ultimate streams:

- **Top-left:** webcam/OBS virtual camera preview + fullscreen
- **Top-right:** on-stream set editor (characters, per-game winners, DQs, set timer, submit to start.gg)
- **Bottom:** tournament set browser with tabs and bracket-style columns
  - **Left-click:** open quick-report modal
  - **Right-click:** move a set into the on-stream editor

It also writes a **TSH-style scoreboard JSON payload** to disk for stream overlays.

## Reporting features

- **DQs.** Each player has a **DQ** button in the set editor. One DQ advances the
  opponent; DQ-ing both is a double DQ (nobody advances). A DQ replaces the
  per-game result - no game data is sent with it, and start.gg records the
  disqualified entrant's score as `-1`, which the bracket view shows as `DQ`.
- **Editing / resetting results.** start.gg has no "edit a completed set"
  mutation, so a reported set shows **Edit result** (reset on start.gg, keeping
  the current scoreline loaded so it can be corrected and resubmitted) and
  **Reset result** (reset and clear). Both need a second click to confirm.
  Dependent sets are deliberately *not* reset, so a correction can't silently
  wipe results reported further down the bracket.
- **Locally-saved results.** Dismissing the quick-report modal (Close, backdrop
  click or Escape) - or pulling a part-scored set off stream - keeps whatever was
  scored, in `local_results.json` next to the config file. Sets carrying one are
  flagged on the bracket, and reopening one restores it with a reminder that it
  still hasn't been submitted to start.gg. Submitting clears it.
- **Set timers, tied to start.gg's set clock.** **Start set** marks the set in
  progress on start.gg (`markSetInProgress`, the same thing its bracket UI does)
  and starts the clock; submitting the result is what stops both, leaving the
  timer frozen on how long the set took. Like start.gg, the clock counts **up
  from zero** - a set takes as long as it takes, there's no target length.
  Running sets show their clock on the bracket/pool view (and a count in the
  header), so it's obvious at a glance which matches are under way, and the
  stream editor's clock is published to the overlay JSON under a top-level
  `timer` key.

  Handling around that:

  - The clock is anchored to start.gg's own `startedAt`, so a set started on
    another device - or before this app was restarted - shows the real elapsed
    time instead of restarting from zero. A `startedAt` in the future (clock
    skew between your machine and start.gg) is clamped to "just started".
  - **Pause/Resume is local only** - start.gg has no paused state, and the
    alternative would be repeatedly starting and resetting the set out from
    under anyone watching the bracket. The editor says so while paused, and the
    board shows a paused set's clock greyed out rather than as in progress.
  - **Reset** un-starts the set on start.gg as well (a reset is start.gg's only
    way back out of in-progress), so it asks for a confirming click first. A
    purely local timer resets on the first click.
  - Sets start.gg can't start yet - a bracket it hasn't started (synthetic
    `preview_...` ids) or a pool mid-desync - run the timer locally and say so
    rather than failing. If `markSetInProgress` is rejected, the local clock
    keeps running and the error is surfaced as a warning: the set is being
    played either way.
  - A set already completed on start.gg shows its recorded duration
    (`completedAt - startedAt`) as a final time in the editor, with no timer
    controls, and no clock on the board - the score is the useful thing there.

## Stack

- Frontend: Vue 3 + Vite
- Desktop shell/backend: Tauri 2 (Rust)
- API: start.gg GraphQL (`https://api.start.gg/gql/alpha`)

## Requirements

- Node.js + npm
- Rust toolchain
- Tauri system dependencies (per Tauri docs)
- start.gg API token with permissions to read tournament data and report sets

## Run

```bash
npm install
npm run tauri dev
```

## First-time setup in app

1. Enter your **start.gg API token**.
2. Enter **Tournament slug** (example: `tournament/genesis-x/event/ultimate-singles`).
3. Enter **Stream output JSON path** (where your overlay/web views read JSON).
4. Click **Save Settings**.
5. Click **Refresh Tournament**.

## Local OBS preview without Virtual Camera

For the complete setup procedure, no-admin portable OBS instructions, an event-day checklist, and troubleshooting, see [Secondary OBS Preview Without Virtual Camera](docs/secondary-obs-preview.md).

The app bundles [MediaMTX](https://github.com/bluenviron/mediamtx) `v1.21.0` as a managed sidecar. It starts with the app and converts a loopback SRT feed from OBS into browser-compatible WebRTC/WHEP:

```text
OBS normal stream -> Twitch
OBS Custom FFmpeg recording -> SRT -> bundled MediaMTX -> WHEP -> app video panel
```

Only loopback listeners are enabled, so this setup does not need an inbound Windows Firewall rule and cannot be viewed by other LAN computers. The bundled relay listens on:

- OBS publish URL: `srt://127.0.0.1:8890?streamid=publish:preview`
- App WHEP URL: `http://127.0.0.1:8889/preview/whep`
- WebRTC media: `127.0.0.1:8189/UDP`

RTSP, RTMP, HLS, Media-over-QUIC, the MediaMTX API, metrics, recording, and playback services are disabled.

### OBS configuration

Keep `Settings -> Stream` configured for Twitch as normal. Configure the second output under `Settings -> Output`:

1. Set **Output Mode** to **Advanced**.
2. Open **Recording**.
3. Set **Type** to **Custom Output (FFmpeg)**.
4. Set **FFmpeg Output Type** to **Output to URL**.
5. Enter `srt://127.0.0.1:8890?streamid=publish:preview` as the URL.
6. Set **Container Format** to `mpegts`.
7. Select an H.264 encoder and use `yuv420p`.
8. Start with a 1280x720 rescale, 2500-4000 Kbps, and a one-second keyframe interval. Custom FFmpeg output generally follows OBS's global frame rate, so a 60 FPS Twitch project will usually make this output 60 FPS too.
9. Disable B-frames (`bf=0`) and use a low-latency encoder preset. Browser WebRTC cannot display H.264 B-frames.
10. Disable the custom output's audio encoder for the initial video-only preview.

OBS exposes custom encoder controls differently for x264, NVENC, Quick Sync, and AMF. Verify that the selected encoder actually applies zero B-frames. If the WHEP connection succeeds but the picture remains blank, B-frames or an unsupported H.264 pixel format/profile are the first settings to check.

OBS treats this second network output as recording. Start **Recording** in addition to **Streaming**, or enable **Automatically record when streaming** in OBS's general/output settings.

### App configuration

1. Open the app settings.
2. Set **Preview source** to **Local OBS WebRTC feed**.
3. Leave **WHEP preview URL** as `http://127.0.0.1:8889/preview/whep`.
4. Confirm the relay status is green. Use **Restart relay** if it is not.
5. Click **Save Settings**.
6. Start the custom OBS recording output. The preview reconnects automatically if OBS starts later or restarts.

The existing **Fullscreen** button works for both camera and WebRTC sources.

### No-admin Windows deployment

- OBS: use the official ZIP in a user-writable folder with `portable_mode.txt`, not `Program Files`.
- This app: the NSIS bundle is explicitly configured for `currentUser` installation, which does not request machine-wide installation. Build/sign it on a development machine, then run the generated NSIS installer as the tournament Windows user.
- MediaMTX: is included in the app bundle and launched as a child process; it is not installed as a service and does not require elevation.
- Firewall: all listeners are bound to `127.0.0.1`, so no inbound firewall exception is expected. This intentionally supports a preview in the app on the same PC only.
- Keep the OBS portable directory and its scene media in paths writable by the tournament user. OBS notes that referenced scene files do not automatically become portable.

Bundled MediaMTX version, archive checksums, and license are recorded in `src-tauri/MEDIAMTX-VERSION.txt` and `src-tauri/MEDIAMTX-LICENSE.txt`.

### Optional CachyOS test

The repository also includes the x86-64 Linux MediaMTX sidecar. Run `npm run tauri dev`, configure OBS with the same SRT URL and custom FFmpeg output, then select **Local OBS WebRTC feed** in the app. This path does not use the Linux virtual-camera workaround.

## Notes on start.gg reporting

The backend attempts several `reportBracketSet` mutation shapes to maximize compatibility with start.gg schema variations. If reporting fails, the app surfaces the GraphQL error message directly so you can see exactly what the API rejected.

## Overlay JSON output

The app writes a JSON payload containing both:

- a generic `set` block, and
- a `score` block shaped for common TSH-style overlay usage.

Use the file path you configured under **Stream output JSON path**.

## Tests

```bash
npm test                                   # Vitest: lib logic + Vue components + App flows
cargo test --manifest-path src-tauri/Cargo.toml   # start.gg mutation shapes, config, overlay payload
```

The frontend tests mock Tauri's `invoke`, so they exercise the full
fetch -> edit -> report flow without a start.gg token or a running app.

## Validation performed

- `npm run build` ✅
- `npm test` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
- `cargo test --manifest-path src-tauri/Cargo.toml` ✅
