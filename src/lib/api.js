import { invoke } from "@tauri-apps/api/core";

export async function loadConfig() {
  return invoke("load_app_config");
}

export async function saveConfig(config) {
  return invoke("save_app_config", { config });
}

export async function fetchTournamentState(request) {
  return invoke("fetch_tournament_state", { request });
}

export async function reportSetResult(request) {
  return invoke("report_set_result", { request });
}

export async function writeStreamOverlay(request) {
  return invoke("write_stream_overlay", { request });
}

export async function listCaptureTargets() {
  return invoke("list_capture_targets");
}

export async function startWindowCapture(targetId, targetKind) {
  return invoke("start_window_capture", { targetId, targetKind });
}

export async function stopWindowCapture() {
  return invoke("stop_window_capture");
}
