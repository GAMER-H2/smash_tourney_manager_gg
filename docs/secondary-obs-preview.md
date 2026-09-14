# Secondary OBS Preview Without Virtual Camera

This guide configures OBS to send a second, local video output to Main Tourney Manager while OBS continues streaming normally to Twitch. It is intended for tournament computers where the Windows user does not have administrator access and therefore cannot install or use the OBS Virtual Camera driver.

> [!IMPORTANT]
> This is a preview on the **same computer** as OBS and Main Tourney Manager. It is not a second public stream and cannot be watched from another computer on the LAN. All relay ports are intentionally bound to `127.0.0.1` (loopback).

## How it works

```text
OBS Streaming output ───────────────────────────────> Twitch

OBS Recording output -> SRT -> bundled MediaMTX -> WHEP/WebRTC -> app preview
```

OBS treats the local preview feed as a recording, but instead of writing a file it sends an MPEG-TS stream to a URL. Main Tourney Manager starts the bundled MediaMTX process automatically and displays MediaMTX's WebRTC output.

The fixed local endpoints are:

| Purpose | Address |
| --- | --- |
| OBS publishes SRT | `srt://127.0.0.1:8890?streamid=publish:preview` |
| App reads WHEP | `http://127.0.0.1:8889/preview/whep` |
| WebRTC media | `127.0.0.1:8189/UDP` |

## Prerequisites

- OBS Studio with the tournament scene collection already configured.
- Main Tourney Manager installed or running on the **same machine**.
- An H.264 encoder available in OBS, such as x264, NVENC, Quick Sync, or AMF.
- If the Windows account has no administrator rights, use the [official OBS ZIP build](https://obsproject.com/download) in a user-writable directory rather than installing OBS under `Program Files`.

### Portable OBS on a no-admin Windows account

1. Download the official Windows ZIP version of OBS on a machine/account that can access it.
2. Extract it somewhere writable by the tournament user, for example inside that user's Documents folder.
3. Create an empty file named `portable_mode.txt` in the OBS directory, beside the OBS launcher directories.
4. Start OBS from the extracted directory.
5. Build or import the required scene collection while running this portable copy.

Portable mode keeps OBS settings in the extracted OBS directory. Media files referenced by scenes are **not** copied automatically, so keep images, videos, browser-source assets, and other scene dependencies in locations the tournament account can read.

Main Tourney Manager's Windows installer uses a per-user installation, and MediaMTX runs as an application child process rather than a Windows service. Neither should require elevation.

## Configure the normal Twitch stream

Configure **Settings → Stream** and the **Streaming** tab under **Settings → Output** as usual. The preview setup does not replace or redirect the normal Twitch output.

## Configure the secondary output in OBS

The names and available encoder controls vary slightly by OBS version and GPU. The important requirements are MPEG-TS, H.264 with a browser-compatible pixel format, frequent keyframes, and no B-frames.

1. In OBS, open **Settings → Output**.
2. Set **Output Mode** to **Advanced**.
3. Open the **Recording** tab.
4. Set **Type** to **Custom Output (FFmpeg)**.
5. Set **FFmpeg Output Type** to **Output to URL**.
6. Set **File path or URL** to:

   ```text
   srt://127.0.0.1:8890?streamid=publish:preview
   ```

7. Set **Container Format** to `mpegts`.
8. Leave **Muxer Settings** empty unless troubleshooting requires a specific setting.
9. Under video settings:
   - Select an **H.264** video encoder.
   - Use the `yuv420p` pixel format if OBS exposes a pixel-format control.
   - Enable rescaling and start with **1280×720** to reduce preview load.
   - Start with a **2500–4000 Kbps** video bitrate.
   - Use a **one-second keyframe interval**. For a 60 FPS project this is 60 frames; for a 30 FPS project it is 30 frames.
   - Select a low-latency encoder preset where available.
   - Set B-frames to **0**. If the encoder exposes free-form options rather than a B-frame field, add `bf=0` using that encoder's expected option syntax.
10. Disable the custom output's audio encoder for the initial setup. The app only needs video, and removing audio makes the first test simpler.
11. Click **Apply**, then **OK**.

Custom FFmpeg output generally follows OBS's global frame rate under **Settings → Video**, so a project configured for 60 FPS will normally send this preview at 60 FPS as well.

### Encoder notes

OBS exposes controls differently for x264, NVENC, Quick Sync, and AMF. A setting merely appearing in a free-form field does not guarantee that a hardware encoder accepted it. If MediaMTX is running and the app connects but the picture is blank, first confirm from OBS's log or encoder UI that:

- the selected codec is H.264 rather than HEVC/H.265 or AV1;
- the output uses `yuv420p`/4:2:0 rather than a 4:4:4 or 10-bit format;
- B-frames are actually disabled;
- the keyframe interval is short enough.

## Configure Main Tourney Manager

1. Start Main Tourney Manager. The bundled MediaMTX relay starts automatically with the app.
2. Expand the app settings panel.
3. Set **Preview source** to **Local OBS WebRTC feed**.
4. Leave **WHEP preview URL** set to:

   ```text
   http://127.0.0.1:8889/preview/whep
   ```

5. Check the relay indicator. It should be green and report that MediaMTX is running.
6. If it is not running, click **Restart relay**.
7. Click **Save Settings**.

The preview panel may say it is reconnecting until OBS starts publishing. This is expected; it retries automatically.

## Start and stop the preview during a tournament

OBS's two outputs must both be started:

1. Click **Start Streaming** to send the normal program to Twitch.
2. Click **Start Recording** to send the secondary local feed to Main Tourney Manager.

Because the recording output is configured as **Output to URL**, starting recording sends data to MediaMTX instead of creating a normal recording file.

To avoid forgetting the second step, enable OBS's **Automatically record when streaming** option if it is available in your OBS version. With that enabled, **Start Streaming** starts both outputs and **Stop Streaming** stops the secondary output as well.

The app reconnects automatically if recording starts after the app, or if OBS/recording is restarted. The app's **Fullscreen** button works with both Virtual Camera and WebRTC preview modes.

## Quick verification checklist

Before the event, verify the complete path in this order:

- [ ] Main Tourney Manager is open.
- [ ] **Preview source** is **Local OBS WebRTC feed**.
- [ ] The WHEP URL is `http://127.0.0.1:8889/preview/whep`.
- [ ] The relay indicator is green.
- [ ] OBS Recording uses **Custom Output (FFmpeg)** and **Output to URL**.
- [ ] The OBS URL is `srt://127.0.0.1:8890?streamid=publish:preview`.
- [ ] The container is `mpegts` and the codec is H.264.
- [ ] B-frames are disabled and the pixel format is `yuv420p`/4:2:0.
- [ ] **Start Recording** is active in OBS.
- [ ] The app preview shows moving video and works in fullscreen.
- [ ] The normal Twitch stream still starts and stops independently as expected.

## Troubleshooting

### Relay indicator is red or MediaMTX does not start

- Click **Restart relay** in the app.
- Close any second copy of Main Tourney Manager.
- Check whether another application is already using TCP port `8889`.
- In a development checkout, confirm the target-specific MediaMTX binary exists under `src-tauri/binaries` and `src-tauri/mediamtx.yml` is bundled.

The app considers the relay ready when its WHEP listener opens on `127.0.0.1:8889`.

### Relay is green, but the preview keeps reconnecting

A green relay status only means MediaMTX is running; it does not mean OBS is publishing video.

- Confirm **Start Recording** is active, not only **Start Streaming**.
- Recheck the complete SRT URL, including `?streamid=publish:preview`.
- Confirm **FFmpeg Output Type** is **Output to URL** and the container is `mpegts`.
- Stop and restart OBS recording after the app relay is running.
- If necessary, click **Restart relay**, wait for green status, then restart OBS recording.

### WebRTC connects, but the video is black or blank

This usually indicates an incompatible H.264 stream:

1. Set B-frames to `0`.
2. Use H.264, not HEVC/H.265 or AV1.
3. Use `yuv420p`/8-bit 4:2:0 output.
4. Set a one-second keyframe interval.
5. Try 1280×720 at 2500 Kbps.
6. Temporarily switch to the x264 software encoder to determine whether the hardware encoder's options are the cause.
7. Keep audio disabled until video works.

### OBS reports that it cannot open the URL or start recording

- Start Main Tourney Manager first and wait for the relay indicator to turn green.
- Verify that nothing else is bound to SRT port `8890`.
- Check that the URL was entered in the URL field and not in a normal recording file-path field.
- Open **Help → Log Files → View Current Log** in OBS and look for FFmpeg, SRT, muxer, or encoder errors.

### Preview is delayed or uses too much CPU/GPU

- Rescale the secondary output to 1280×720 or lower.
- Lower its bitrate toward 2500 Kbps.
- Use a low-latency encoder preset.
- If practical, lower the OBS project's frame rate from 60 FPS to 30 FPS; Custom FFmpeg recording normally follows the global project frame rate.
- Prefer a hardware H.264 encoder if software x264 is competing with the game capture or normal stream encode.

### Windows Firewall prompt

No inbound firewall rule should be necessary because SRT, WHEP, and WebRTC are all bound to `127.0.0.1`. Do not change the addresses to `0.0.0.0` merely to dismiss a preview issue; that would expose the relay to the local network and is outside this application's intended setup.

## Returning to OBS Virtual Camera

To use the original preview method again:

1. Change **Preview source** in the app to **Camera / OBS Virtual Camera**.
2. Select the OBS Virtual Camera in the preview panel.
3. Click **Save Settings**.
4. Stop OBS recording if it is no longer needed.

The normal Twitch streaming configuration is unaffected by switching preview modes.
