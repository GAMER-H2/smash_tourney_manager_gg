# Capture card preview with the layout composited on top

This is the **fallback** preview path, for machines where the per-user OBS
Virtual Camera registration doesn't work. See
[OBS Virtual Camera on a no-admin Windows 11 account](no-admin-obs-virtual-camera.md)
for the primary path; try that first, because it shows the real program feed.

## What this is, and what it isn't

The capture card is already a plain UVC device, so the app can open it with no
admin rights, no relay, no encoder, and no configuration in OBS at all. That
gives the lowest latency and the best picture available — it's the same signal
OBS itself is capturing, taken before OBS touches it.

On top of that video the app renders **the same layout HTML your OBS browser
source uses**, scaled from the 1920×1080 canvas to whatever size the panel is.
The layout polls `program_state.json` exactly as it does in OBS, so scores,
names, characters and the set timer update live.

Be clear about the limits, because they matter on event day:

- **This is a reconstruction, not the program feed.** It is "game + overlay",
  composited by the app. Scene switches, transitions, replays, intermission
  and commentator scenes, stingers, and any source that isn't the game capture
  will not appear.
- **It does not prove what Twitch is seeing.** It proves the game feed is live
  and the overlay data is correct. Those are the two things that actually go
  wrong mid-bracket, which is why it's a useful fallback — but it is not a
  confidence monitor for the broadcast.
- **Audio is not included.** The preview is video only, as it always has been.

If you need to see true program output, use an OBS fullscreen projector on a
second display.

## Setup

1. Make sure the capture card is plugged in and **not** exclusively held by
   another application. OBS and this app can normally share a UVC device on
   Windows; if the preview is black while OBS is fine, that's the thing to
   suspect.

2. In app settings, set **Preview source**. Leave it on **Auto (prefer OBS
   Virtual Camera)** — auto uses the virtual camera when one is present and
   drops to this mode when there isn't one, so the same configuration works
   whether or not the registration took on a given machine. Pin it to
   **Capture card + overlay** only if you want to force this mode.

3. Set **Overlay layout URL or file** to the same thing the OBS browser source
   points at. Both forms work:

   - a local file path or `file://` URL, e.g.
     `C:\Users\tourney\Documents\overlay\index.html`
   - an `http://` / `https://` URL, if you serve the layout instead

   A local path can't be framed directly — the app's webview would block a
   `file://` iframe — so the app re-serves the layout's folder through Tauri's
   asset protocol. It grants **only that folder** (recursively, so the
   layout's CSS, JS, images and `program_state.json` all resolve).

4. Set **Stream output JSON path** so `program_state.json` lands where the
   layout expects to find it — usually beside the layout's `index.html`. This
   is the same requirement OBS has; nothing changes here.

5. Click **Save Settings**.

6. Pick the capture card in the preview panel's dropdown if auto-selection
   chose the wrong device.

Use **Reload overlay** in the panel header after editing the layout — it
re-frames the layout without restarting the app.

## Verification before event day

- [ ] **Preview source** is **Auto** (or pinned deliberately).
- [ ] The panel header reads "Capture card + overlay".
- [ ] The video shows the game, live, with no visible delay against the setup.
- [ ] The overlay is drawn on top and is positioned as it is on stream.
- [ ] Changing a score in the set editor updates the overlay in the preview.
- [ ] **Fullscreen** shows the video and the overlay together.
- [ ] OBS still captures the card normally at the same time.

## Troubleshooting

**"Could not load overlay layout".**
The path doesn't point at a file. It must be the layout's `index.html` itself,
not the folder containing it.

**The overlay renders but every field is blank or stale.**
The layout can't reach `program_state.json`. Check **Stream output JSON path**
points where the layout looks for it, and that **Auto-write overlay** is on (or
that you've written it once by hand).

**The overlay is there but misaligned.**
The stage is pinned to 16:9 and the layout is scaled from a 1920×1080 canvas.
A layout authored for a different canvas size will not line up; match OBS's
canvas in the layout.

**The video is black but the overlay shows.**
The capture card isn't producing frames for this app. Check the device
dropdown, then whether another application has the card open exclusively.

**Nothing at all, and the panel says no virtual camera was found.**
That message is auto mode telling you it fell back — which is correct — and
that no layout URL is configured yet. Set one in step 3.
