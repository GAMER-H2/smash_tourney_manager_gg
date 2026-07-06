# Main Tourney Manager (Tauri + Vue)

A desktop TO tool for Smash Ultimate streams:

- **Top-left:** webcam/OBS virtual camera preview + fullscreen
- **Top-right:** on-stream set editor (characters, per-game winners, submit to start.gg)
- **Bottom:** tournament set browser with tabs and bracket-style columns
  - **Left-click:** open quick-report modal
  - **Right-click:** move a set into the on-stream editor

It also writes a **TSH-style scoreboard JSON payload** to disk for stream overlays.

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

## Notes on start.gg reporting

The backend attempts several `reportBracketSet` mutation shapes to maximize compatibility with start.gg schema variations. If reporting fails, the app surfaces the GraphQL error message directly so you can see exactly what the API rejected.

## Overlay JSON output

The app writes a JSON payload containing both:

- a generic `set` block, and
- a `score` block shaped for common TSH-style overlay usage.

Use the file path you configured under **Stream output JSON path**.

## Validation performed

- `npm run build` ✅
- `cargo check --manifest-path src-tauri/Cargo.toml` ✅
