# OBS Virtual Camera on a no-admin Windows 11 account

This is the **primary** preview path for Main Tourney Manager: portable OBS
publishes its program feed as a normal camera device, and the app's preview
panel opens it like any other webcam. Latency is a frame or two, quality is
whatever the OBS canvas is, and commentators can cast off it.

The obstacle is that OBS's installer registers the virtual camera machine-wide
and that needs administrator rights. This document works around that. If it
turns out not to work on a given machine, use the capture-card preview mode as
the fallback — see [Capture card preview](capture-card-preview.md).

## Why it normally needs admin, and why it doesn't have to

OBS Virtual Camera is **not** a kernel driver. It is a DirectShow filter living
in `obs-virtualcam-module64.dll`, registered as a COM server. OBS's
`virtualcam-install.bat` runs `regsvr32`, whose writes go to
`HKEY_CLASSES_ROOT` — a merged view of `HKLM\Software\Classes` and
`HKCU\Software\Classes`. Writes to `HKCR` land in `HKLM` by default, which is
the part that requires elevation.

They don't have to. When a key already exists under `HKCU\Software\Classes`,
`HKCR` resolves to the per-user copy and the write lands there instead. So
pre-creating the filter's two keys under `HKCU` and *then* running `regsvr32`
produces a per-user registration from an installer that was never written for
one. `scripts\register-obs-virtualcam-peruser.ps1` does exactly that.

### The second half of the problem

Registering the filter is necessary but not sufficient. Modern Chromium — and
so WebView2, which is the webview Main Tourney Manager runs on Windows —
enumerates cameras through the **Windows Camera Frame Server**. That frame
server is a system service running as `LOCAL SERVICE`, so it reads `HKLM` and
has no visibility into the tournament account's `HKCU`. A per-user filter is
invisible to it, and the camera dropdown would stay empty even after a
successful registration.

Main Tourney Manager therefore launches its webview with
`--disable-features=MediaFoundationVideoCapture`, which puts camera enumeration
back on the in-process DirectShow path, running as the logged-in user and
reading that user's hive. This is set automatically in
`prefer_directshow_camera_enumeration()` (`src-tauri/src/lib.rs`); there is
nothing to configure.

A consequence worth knowing: other applications on that machine — Discord,
Zoom, a browser — will **not** see the per-user virtual camera, because they
still go through the frame server. This registration is for this app.

## Setup

Do all of this while logged in as the tournament Windows account. None of it
needs elevation.

1. **Install portable OBS.** Download the official OBS **ZIP** build (not the
   installer) and extract it somewhere the account can write, e.g.
   `%USERPROFILE%\Documents\obs-studio`. Create an empty file named
   `portable_mode.txt` in that folder, beside `bin\` and `obs-plugins\`.
   Launch OBS from there and set up the scene collection.

2. **Run the registration script**, pointing it at that OBS folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\register-obs-virtualcam-peruser.ps1 -ObsDirectory "$HOME\Documents\obs-studio"
   ```

   `-ExecutionPolicy Bypass` on a single invocation is a per-process setting and
   does not change any machine policy. Omit `-ObsDirectory` to let the script
   search the usual portable locations.

   It should print the path it registered. If it reports that the write went to
   `HKLM` and was dropped, this machine can't use this path — go to the
   capture-card fallback.

3. **Start the virtual camera in OBS.** Controls dock → **Start Virtual
   Camera**. Check the gear icon beside it: output type should be **Program**
   unless you deliberately want a specific scene or source.

4. **Start Main Tourney Manager** and pick the OBS Virtual Camera in the preview
   panel's dropdown. If it isn't listed, click **Refresh**. If it's still not
   listed, the app was probably running before step 2 or 3 — restart it.

5. **Save Settings**, so the device is remembered for next time.

## Verification before event day

- [ ] OBS is running from the portable folder (Help → About shows portable mode).
- [ ] **Start Virtual Camera** is active and reads "Stop Virtual Camera".
- [ ] The app's dropdown lists "OBS Virtual Camera".
- [ ] The preview shows moving video that matches the OBS program view,
      including the overlay.
- [ ] Scene switches in OBS are reflected in the preview.
- [ ] **Fullscreen** works.
- [ ] The Twitch stream starts and stops independently of the virtual camera.

Check the last one specifically: the virtual camera is a third output alongside
streaming and recording, and stopping the stream does not stop it.

## Troubleshooting

**The dropdown is empty, or lists only the real webcam.**
Confirm the script printed a registered path, that OBS has the virtual camera
*started*, and that the app was started after both. Registration is read at
enumeration time, so the order matters on the first run.

**The device is listed but the preview is black.**
The virtual camera is running but OBS is outputting a blank or hidden scene.
Check the virtual camera's output selector in OBS, and that the scene isn't a
source that's currently hidden.

**"Could not access webcam" / permission errors.**
Windows Settings → Privacy & security → Camera, and make sure camera access is
allowed for desktop apps. This is a per-user setting and needs no admin.

**OBS was updated or moved.**
Re-run the registration script; it points at a specific DLL path.

## Removing it

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-obs-virtualcam-peruser.ps1 -Unregister
```

This deletes only the two `HKCU\Software\Classes` keys the script created.
Nothing was written outside the user account and nothing was installed as a
service, so there is nothing else to clean up.
