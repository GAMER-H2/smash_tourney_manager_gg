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

export async function fetchGameCharacters(request) {
  return invoke("fetch_game_characters", { request });
}

export async function fetchEntrantAvatars(request) {
  return invoke("fetch_entrant_avatars", { request });
}

export async function writeStreamOverlay(request) {
  return invoke("write_stream_overlay", { request });
}

export async function getPlatform() {
  return invoke("get_platform");
}
