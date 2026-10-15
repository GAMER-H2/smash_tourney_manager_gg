# Main Tourney Manager (Tauri + Vue)

A desktop TO tool for Smash Ultimate streams:

- **Top-left:** webcam / capture-card / OBS virtual camera preview + fullscreen
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

## Video preview

The preview panel has two modes, and **Auto** picks between them so the same
configuration works on every machine:

1. **OBS Virtual Camera** — the real program feed, including transitions and
   every scene. Preferred whenever a virtual camera is enumerated.
2. **Capture card + overlay** — the capture card's UVC feed with the stream
   layout composited over it. Used automatically when there is no virtual
   camera.

OBS registers its virtual camera machine-wide, which needs administrator
rights, so a locked-down tournament account running portable OBS normally has
no virtual camera at all. `scripts/register-obs-virtualcam-peruser.ps1`
<<<<<<< Updated upstream
registers the filter for the current user instead, and the app launches its
=======
registers the filter for the current user instead — writing the COM keys under
`HKCU` directly, because `regsvr32` cannot be coaxed into a per-user
registration for this DLL — and `scripts/test-obs-virtualcam.ps1` checks the
result without needing the app built. The app launches its
>>>>>>> Stashed changes
webview with `--disable-features=MediaFoundationVideoCapture` so camera
enumeration happens in-process under that user's registry hive rather than in
the Windows Camera Frame Server service, which can only see machine-wide
registrations. See
[OBS Virtual Camera on a no-admin Windows 11 account](docs/no-admin-obs-virtual-camera.md).

If that doesn't work on a given machine, the fallback needs no OBS
configuration at all — point the app at the same layout `index.html` the OBS
browser source uses and it composites it over the capture card feed. It is a
reconstruction rather than true program out, so it won't show scene switches;
see [Capture card preview](docs/capture-card-preview.md) for what it does and
doesn't prove.

A previous build bundled MediaMTX and read a second loopback OBS output over
SRT/WHEP as a way around the same admin restriction. It was removed: the
OBS-side setup was too involved for event day, and the picture was too soft and
too delayed for commentary.

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
