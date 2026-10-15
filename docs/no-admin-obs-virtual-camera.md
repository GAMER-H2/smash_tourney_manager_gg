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

<<<<<<< Updated upstream
They don't have to. When a key already exists under `HKCU\Software\Classes`,
`HKCR` resolves to the per-user copy and the write lands there instead. So
pre-creating the filter's two keys under `HKCU` and *then* running `regsvr32`
produces a per-user registration from an installer that was never written for
one. `scripts\register-obs-virtualcam-peruser.ps1` does exactly that.
=======
They don't have to. A COM in-process server is nothing but a handful of
registry values, and `HKCU\Software\Classes` is a hive this account owns. Five
values written there give the filter a per-user registration that every
DirectShow client resolves normally:

```
HKCU\Software\Classes\CLSID\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}
    (default)                        = OBS Virtual Camera
  \InprocServer32
    (default)                        = <path to obs-virtualcam-module64.dll>
    ThreadingModel                   = Both
HKCU\Software\Classes\CLSID\{860BB310-5D01-11d0-BD3B-00A0C911CE86}\Instance\{A3FCE0F5-…}
    CLSID                            = {A3FCE0F5-3493-419F-958A-ABA1250EC20B}
    FriendlyName                     = OBS Virtual Camera
```

`{860BB310-…}` is the DirectShow video capture category; an `Instance` subkey
under it is what makes the filter enumerate as a *camera* rather than just
exist as a COM class. `scripts\register-obs-virtualcam-peruser.ps1` writes
exactly these, for both the 64-bit hive and its `Wow6432Node` fork.

### Why the script does not use regsvr32

An earlier version of this script pre-created the two keys under `HKCU` and
then ran `regsvr32`, on the theory that `HKCR` resolves to the per-user copy
of a key that already exists there. That theory is right about `HKCR`, and it
still cannot work for this DLL.

`DllRegisterServer` in `obs-virtualcam-module64.dll` comes from Microsoft's
`strmbase`, and its first act is to **delete** `HKCR\CLSID\{filter}` before
recreating it. The delete takes the pre-created `HKCU` key with it, so the
recreate no longer has a per-user key to resolve to, falls through to `HKLM`,
and is denied. `DllRegisterServer` returns `E_FAIL` (`0x80004005`) and
`regsvr32` exits **5** — the failure this document used to produce:

```
regsvr32 failed with exit code 5. The DLL path or the OBS build may not
support DllInstall.
```

Nothing about the DLL path or `DllInstall` was wrong; there is simply no
argument to `regsvr32` that produces a per-user registration here. Writing the
values ourselves skips the problem entirely, and the result is identical —
verified against a live OBS 32.0.1 on a University of Kent managed machine.

### Where the module file lives

The script copies `obs-virtualcam-module64.dll`, its 32-bit sibling and
`placeholder.png` to `%LOCALAPPDATA%\MainTourneyManager\virtualcam` and
registers *that* copy. On a managed account the OBS folder is often on a
roaming network home drive (`Z:\…`), and a mapped drive letter is not
guaranteed to resolve in every process that loads the filter. A local copy
removes that variable. Pass `-InPlace` to register the DLLs where they sit if
OBS is already on a local disk.

A consequence: re-running the script needs whatever is holding the filter to
let go of it first. OBS loads the module itself while the virtual camera is
running, so stop the virtual camera before re-registering after an OBS update.
>>>>>>> Stashed changes

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
<<<<<<< Updated upstream
   search the usual portable locations.

   It should print the path it registered. If it reports that the write went to
   `HKLM` and was dropped, this machine can't use this path — go to the
   capture-card fallback.
=======
   find a running OBS or search the usual portable locations — pass it
   explicitly if more than one OBS folder exists on the machine, so there is no
   doubt which one was registered.

   It prints the module path it registered, and only reports success after
   asking COM to actually build the filter out of the registration. If that
   last step fails, this machine can't use this path — go to the capture-card
   fallback.

   **Do this before starting OBS.** OBS decides whether to enable *Start
   Virtual Camera* when it launches, so a registration made while OBS is
   already running won't be picked up until it restarts.
>>>>>>> Stashed changes

3. **Start the virtual camera in OBS.** Controls dock → **Start Virtual
   Camera**. Check the gear icon beside it: output type should be **Program**
   unless you deliberately want a specific scene or source.

<<<<<<< Updated upstream
4. **Start Main Tourney Manager** and pick the OBS Virtual Camera in the preview
   panel's dropdown. If it isn't listed, click **Refresh**. If it's still not
   listed, the app was probably running before step 2 or 3 — restart it.

5. **Save Settings**, so the device is remembered for next time.
=======
4. **Check it**, before involving the app at all:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\scripts\test-obs-virtualcam.ps1
   ```

   It confirms the registration, enumerates the DirectShow capture category the
   same way the app's webview does, and lists the formats the camera is
   offering. A healthy result looks like:

   ```
   [ ok ] 64-bit module registered: C:\Users\…\MainTourneyManager\virtualcam\obs-virtualcam-module64.dll
   [ ok ] OBS Virtual Camera is enumerated as a capture device.
   [ ok ] OBS is publishing - 3 format(s) offered:
       1280x720 @ 30fps  NV12
       1280x720 @ 30fps  I420
       1280x720 @ 30fps  YUY2
   ```

   Formats only appear while OBS is publishing, so "offers no video formats"
   means step 3 didn't happen or didn't take.

5. **Start Main Tourney Manager** and pick the OBS Virtual Camera in the preview
   panel's dropdown. If it isn't listed, click **Refresh**. If it's still not
   listed, the app was probably running before step 2 or 3 — restart it.

6. **Save Settings**, so the device is remembered for next time.
>>>>>>> Stashed changes

## Verification before event day

- [ ] OBS is running from the portable folder (Help → About shows portable mode).
- [ ] **Start Virtual Camera** is active and reads "Stop Virtual Camera".
<<<<<<< Updated upstream
=======
- [ ] `scripts\test-obs-virtualcam.ps1` passes all three checks and lists
      formats at the resolution OBS is set to output.
>>>>>>> Stashed changes
- [ ] The app's dropdown lists "OBS Virtual Camera".
- [ ] The preview shows moving video that matches the OBS program view,
      including the overlay.
- [ ] Scene switches in OBS are reflected in the preview.
- [ ] **Fullscreen** works.
- [ ] The Twitch stream starts and stops independently of the virtual camera.

Check the last one specifically: the virtual camera is a third output alongside
streaming and recording, and stopping the stream does not stop it.

## Troubleshooting

<<<<<<< Updated upstream
=======
**Anything at all.** Run `scripts\test-obs-virtualcam.ps1` first — it separates
"not registered" from "registered but OBS isn't publishing" from "registered
and publishing, so the problem is the app", which is most of the diagnosis.

>>>>>>> Stashed changes
**The dropdown is empty, or lists only the real webcam.**
Confirm the script printed a registered path, that OBS has the virtual camera
*started*, and that the app was started after both. Registration is read at
enumeration time, so the order matters on the first run.

<<<<<<< Updated upstream
**The device is listed but the preview is black.**
The virtual camera is running but OBS is outputting a blank or hidden scene.
Check the virtual camera's output selector in OBS, and that the scene isn't a
source that's currently hidden.
=======
**`regsvr32 failed with exit code 5`.**
That is the old script. The current one does not run `regsvr32` at all — see
[Why the script does not use regsvr32](#why-the-script-does-not-use-regsvr32).
Pull the current `scripts\register-obs-virtualcam-peruser.ps1` and re-run it.

**"Could not update … it is in use" when re-registering.**
OBS keeps the module loaded while the virtual camera is running, and so does
any app with the preview open. Stop the virtual camera in OBS, close Main
Tourney Manager and any browser that opened the camera, then re-run.

**`reg query` / `regedit` says registry editing is disabled.**
Some managed builds set that policy. It only blocks `reg.exe` and `regedit` —
both scripts here use PowerShell's registry provider, which is unaffected. Use
`Get-ItemProperty 'HKCU:\Software\Classes\CLSID\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}\InprocServer32'`
if you want to look at the keys by hand.

**The device is listed but the preview is black.**
`test-obs-virtualcam.ps1` reporting formats means the pipeline is fine, so the
blank picture is OBS's program output. Check the virtual camera's output
selector in OBS and that the scene's sources aren't hidden — and note that with
no capture card or webcam attached, OBS's own camera sources fail to start and
the program output genuinely is black. The virtual camera is faithfully
delivering that.
>>>>>>> Stashed changes

**"Could not access webcam" / permission errors.**
Windows Settings → Privacy & security → Camera, and make sure camera access is
allowed for desktop apps. This is a per-user setting and needs no admin.

**OBS was updated or moved.**
Re-run the registration script; it points at a specific DLL path.

## Removing it

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register-obs-virtualcam-peruser.ps1 -Unregister
```

<<<<<<< Updated upstream
This deletes only the two `HKCU\Software\Classes` keys the script created.
Nothing was written outside the user account and nothing was installed as a
service, so there is nothing else to clean up.
=======
This deletes the `HKCU\Software\Classes` keys the script created — both the
64-bit and the `Wow6432Node` set — and the module copy under
`%LOCALAPPDATA%\MainTourneyManager\virtualcam`. Nothing was written outside the
user account and nothing was installed as a service, so there is nothing else
to clean up.

Stop the virtual camera in OBS first. If the module is still loaded the keys
are removed anyway and the script warns that the copied files have to be
deleted by hand.
>>>>>>> Stashed changes
