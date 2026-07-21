use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const START_GG_GQL_URL: &str = "https://api.start.gg/gql/alpha";

// Bundled at compile time so the character icons this app already ships in
// its own UI (public/character-icons) can also be staged next to
// program_state.json for TSH's layouts to render on stream - those layouts
// load images by relative path from disk and can't reach into this app's
// own webview assets.
static CHARACTER_ICONS: include_dir::Dir =
    include_dir::include_dir!("$CARGO_MANIFEST_DIR/../public/character-icons");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    api_token: String,
    tournament_slug: String,
    stream_output_path: String,
    preferred_camera_id: Option<String>,
    per_page: u32,
    auto_write_overlay: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_token: String::new(),
            tournament_slug: String::new(),
            stream_output_path: String::new(),
            preferred_camera_id: None,
            per_page: 128,
            auto_write_overlay: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchTournamentRequest {
    api_token: String,
    tournament_slug: String,
    per_page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportSetRequest {
    api_token: String,
    set_id: String,
    winner_id: u64,
    game_data: Option<Vec<GameDataInput>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameDataInput {
    game_num: u32,
    winner_id: Option<u64>,
    selections: Vec<GameSelectionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameSelectionInput {
    entrant_id: u64,
    character_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchCharactersRequest {
    api_token: String,
    videogame_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FetchAvatarsRequest {
    api_token: String,
    player1_entrant_id: Option<u64>,
    player2_entrant_id: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntrantAvatars {
    player1_avatar: Option<String>,
    player2_avatar: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameCharacter {
    id: u64,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportSetResult {
    success: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteOverlayRequest {
    output_path: String,
    tournament_name: String,
    round_text: String,
    event_name: String,
    best_of: u32,
    player1: OverlayPlayer,
    player2: OverlayPlayer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverlayPlayer {
    name: String,
    character: Option<String>,
    character_icon: Option<String>,
    score: u32,
    avatar_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentData {
    tournament_id: Option<u64>,
    tournament_name: String,
    slug: String,
    fetched_at: String,
    total_sets: usize,
    videogame_id: Option<u64>,
    buckets: Vec<SetBucket>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBucket {
    id: String,
    name: String,
    sets: Vec<TournamentSet>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentSet {
    id: String,
    identifier: Option<String>,
    round_text: String,
    round: i32,
    event_name: String,
    phase_name: Option<String>,
    phase_group_id: Option<u64>,
    phase_group_identifier: Option<String>,
    state: i32,
    winner_id: Option<u64>,
    best_of: u32,
    // The most-picked character per player across this set's reported games
    // (start.gg's per-game character selections), for the compact bracket
    // view's single per-player icon.
    player1_character: Option<String>,
    player2_character: Option<String>,
    // Per-game breakdown of the same data, ordered by game number, so a set
    // editor pulling in an in-progress/already-reported set can show each
    // played game's actual character instead of a lossy set-wide guess.
    games: Vec<GameCharacterPick>,
    player1: EntrantSlot,
    player2: EntrantSlot,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GameCharacterPick {
    game_num: u32,
    // The entrant who actually won this specific game, per start.gg - used
    // to place reported wins in the game they really happened in, rather
    // than assuming a set's wins happened in a simple front-loaded order
    // (which breaks for a set where the winners alternated instead of one
    // player sweeping first).
    winner_entrant_id: Option<u64>,
    player1_character: Option<String>,
    player2_character: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntrantSlot {
    entrant_id: Option<u64>,
    name: String,
    score: i32,
    /// Where this slot's competitor comes from: "set", "seed", "bye", etc.
    source_type: Option<String>,
    /// The originating set ID when `source_type` is "set".
    source_set_id: Option<String>,
    /// 1 = winner of the source set advances here, 2 = loser advances here.
    source_placement: Option<i32>,
}

fn config_file_path() -> Result<PathBuf, String> {
    let mut base =
        dirs::config_dir().ok_or_else(|| "Unable to resolve config directory".to_string())?;
    base.push("main_tourney_manager_gg");
    fs::create_dir_all(&base).map_err(|e| format!("Failed to create config directory: {e}"))?;
    base.push("config.json");
    Ok(base)
}

fn parse_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<u64>().ok()))
}

// Set ids are usually plain numbers, but start.gg gives sets in a "preview"
// bracket (seeded but not yet started by the TO) synthetic string ids like
// "preview_3393165_1_0" instead - parsing those as u64 fails and silently
// drops every set in the bracket, so set ids are kept as opaque strings
// rather than numbers.
fn parse_id_string(value: &Value) -> Option<String> {
    if let Some(s) = value.as_str() {
        return (!s.is_empty()).then(|| s.to_string());
    }
    value.as_u64().map(|n| n.to_string())
}

fn parse_i32(value: &Value) -> Option<i32> {
    value
        .as_i64()
        .and_then(|v| i32::try_from(v).ok())
        .or_else(|| value.as_str().and_then(|s| s.parse::<i32>().ok()))
}

fn read_text(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn default_slot() -> EntrantSlot {
    EntrantSlot {
        entrant_id: None,
        name: String::new(),
        score: 0,
        source_type: None,
        source_set_id: None,
        source_placement: None,
    }
}

// Leaves `name` empty when there's no real entrant rather than defaulting
// to "Player 1"/"Player 2" - those defaults were indistinguishable from a
// real name once they reached the frontend, which masked its own "TBD" /
// "Winner of Match N" placeholder logic for undetermined slots.
fn parse_slot(slot: Option<&Value>) -> EntrantSlot {
    let Some(slot) = slot else {
        return default_slot();
    };

    let entrant = slot.get("entrant").unwrap_or(&Value::Null);
    let entrant_id = parse_u64(entrant.get("id").unwrap_or(&Value::Null));
    let name = read_text(entrant.get("name"));

    let score = slot
        .get("standing")
        .and_then(|standing| standing.get("stats"))
        .and_then(|stats| stats.get("score"))
        .and_then(|score| score.get("value"))
        .and_then(parse_i32)
        .unwrap_or(0);

    let source_type = slot
        .get("prereqType")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|v| !v.is_empty());

    let source_set_id = if source_type.as_deref() == Some("set") {
        slot.get("prereqId").and_then(parse_id_string)
    } else {
        None
    };

    let source_placement = slot.get("prereqPlacement").and_then(parse_i32);

    EntrantSlot {
        entrant_id,
        name,
        score,
        source_type,
        source_set_id,
        source_placement,
    }
}

fn normalize_bucket_id(name: &str) -> String {
    let lowered = name.to_ascii_lowercase();
    let mut out = String::with_capacity(lowered.len());

    for c in lowered.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if c == ' ' || c == '-' || c == '_' {
            out.push('-');
        }
    }

    let collapsed = out
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    if collapsed.is_empty() {
        "bucket".to_string()
    } else {
        collapsed
    }
}

fn sanitize_startgg_slug(raw: &str) -> String {
    let mut value = raw.trim();

    for prefix in [
        "https://www.start.gg/",
        "http://www.start.gg/",
        "https://start.gg/",
        "http://start.gg/",
        "www.start.gg/",
        "start.gg/",
    ] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest;
            break;
        }
    }

    value.trim_matches('/').to_string()
}

fn ensure_tournament_prefix(slug: &str) -> String {
    if slug.to_ascii_lowercase().starts_with("tournament/") {
        slug.to_string()
    } else {
        format!("tournament/{slug}")
    }
}

fn normalize_tournament_slug(raw: &str) -> String {
    let sanitized = sanitize_startgg_slug(raw);
    if sanitized.is_empty() {
        return sanitized;
    }

    let canonical = ensure_tournament_prefix(&sanitized);
    let parts = canonical
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.len() >= 2 && parts[0].eq_ignore_ascii_case("tournament") {
        format!("tournament/{}", parts[1])
    } else {
        canonical
    }
}

fn normalize_event_slug(raw: &str) -> Option<String> {
    let sanitized = sanitize_startgg_slug(raw);
    if sanitized.is_empty() {
        return None;
    }

    let canonical = ensure_tournament_prefix(&sanitized);
    let parts = canonical
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.len() < 4 || !parts[0].eq_ignore_ascii_case("tournament") {
        return None;
    }

    let tournament_key = parts[1];

    for idx in 2..(parts.len() - 1) {
        if parts[idx].eq_ignore_ascii_case("event") {
            return Some(format!(
                "tournament/{}/event/{}",
                tournament_key,
                parts[idx + 1]
            ));
        }
    }

    None
}

// Built once and reused for every request. Pagination and the
// character-list fetch can now issue many requests per tournament load, and
// a fresh reqwest::Client pays a full new TCP+TLS handshake on its first
// request - reusing one client lets reqwest pool and keep-alive connections
// to start.gg instead of renegotiating TLS on every single call.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("main_tourney_manager_gg/0.1")
            .build()
            .expect("Failed to build HTTP client")
    })
}

async fn startgg_graphql(api_token: &str, query: &str, variables: Value) -> Result<Value, String> {
    let client = http_client();

    let response = client
        .post(START_GG_GQL_URL)
        .bearer_auth(api_token)
        .json(&json!({
            "query": query,
            "variables": variables,
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to call start.gg API: {e}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read start.gg response: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "start.gg returned HTTP {}: {}",
            status.as_u16(),
            text
        ));
    }

    let payload: Value =
        serde_json::from_str(&text).map_err(|e| format!("Invalid JSON from start.gg: {e}"))?;

    if let Some(errors) = payload.get("errors").and_then(|v| v.as_array()) {
        if !errors.is_empty() {
            let joined = errors
                .iter()
                .map(|err| {
                    err.get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Unknown GraphQL error")
                        .to_string()
                })
                .collect::<Vec<_>>()
                .join(" | ");
            return Err(format!("start.gg GraphQL error: {joined}"));
        }
    }

    payload
        .get("data")
        .cloned()
        .ok_or_else(|| "start.gg response did not include a data field".to_string())
}

const MIN_SETS_PAGE_SIZE: u32 = 8;

// start.gg caps each request at 1000 returned objects; adding per-set
// `games.selections` pushed some tournaments' single "fetch everything at
// once" request over that ceiling. Parses start.gg's
// "A maximum of 1000 objects may be returned by each request. (actual: N)"
// error and picks a smaller page size that should comfortably clear it.
fn shrink_per_page_from_complexity_error(error: &str, current_per_page: u32) -> Option<u32> {
    if !error.contains("complexity is too high") {
        return None;
    }

    let actual: f64 = error
        .rsplit("actual:")
        .next()?
        .trim()
        .trim_end_matches(['.', ')'])
        .trim()
        .parse()
        .ok()?;

    if actual <= 1000.0 {
        return None;
    }

    // Leave 20% headroom under the cap instead of retrying right at the edge.
    let scale = (1000.0 / actual) * 0.8;
    let shrunk = ((current_per_page as f64) * scale).floor() as u32;

    if shrunk >= current_per_page {
        return None;
    }

    Some(shrunk.max(MIN_SETS_PAGE_SIZE))
}

/// Describes where a paginated `sets` connection lives in a response, since
/// it's nested differently depending on the query: directly on a single
/// object (e.g. `/event` + `/sets`), or repeated once per entry of an
/// array whose length isn't known until the response comes back (e.g.
/// `/tournament/events` + `/sets`, one `sets` connection per event).
enum SetsLocation<'a> {
    Single {
        object_pointer: &'a str,
        sets_relative: &'a str,
    },
    PerArrayEntry {
        array_pointer: &'a str,
        sets_relative: &'a str,
    },
}

// Resolves each location to the concrete pointer(s) of its `sets` object in
// this particular page's response (array locations may resolve to zero or
// several, depending on how many entries came back).
fn resolve_sets_pointers(data: &Value, locations: &[SetsLocation<'_>]) -> Vec<String> {
    let mut out = Vec::new();
    for location in locations {
        match location {
            SetsLocation::Single {
                object_pointer,
                sets_relative,
            } => out.push(format!("{object_pointer}{sets_relative}")),
            SetsLocation::PerArrayEntry {
                array_pointer,
                sets_relative,
            } => {
                if let Some(len) = data
                    .pointer(array_pointer)
                    .and_then(Value::as_array)
                    .map(Vec::len)
                {
                    for i in 0..len {
                        out.push(format!("{array_pointer}/{i}{sets_relative}"));
                    }
                }
            }
        }
    }
    out
}

fn has_any_sets(data: &Value, locations: &[SetsLocation<'_>]) -> bool {
    resolve_sets_pointers(data, locations)
        .iter()
        .any(|pointer| {
            data.pointer(&format!("{pointer}/nodes"))
                .and_then(Value::as_array)
                .map(|nodes| !nodes.is_empty())
                .unwrap_or(false)
        })
}

// Tries each (query, variables) pair in order, moving to the next not just
// on an outright error but also when a query succeeds with zero sets -
// start.gg's default (unfiltered) query can legitimately come back empty
// for a bracket where nothing has been reported yet (e.g. a freshly seeded
// event), while an explicit `filters: { state: [...] }` variant that asks
// for "not started" sets too still finds them. If every tier comes back
// empty rather than erroring, that's trusted as the real answer (the event
// genuinely has no sets yet) rather than treated as a failure.
async fn fetch_best_sets_payload(
    api_token: &str,
    attempts: Vec<(&str, Value)>,
    per_page: u32,
    locations: &[SetsLocation<'_>],
) -> Result<Value, String> {
    let mut empty_result: Option<Value> = None;
    let mut errors = Vec::new();

    for (query, variables) in attempts {
        match fetch_paginated(api_token, query, variables, per_page, locations).await {
            Ok(data) => {
                if has_any_sets(&data, locations) {
                    return Ok(data);
                }
                empty_result.get_or_insert(data);
            }
            Err(e) => errors.push(e),
        }
    }

    empty_result.ok_or_else(|| errors.join(" | "))
}

// Runs `query` with `page`/`perPage` (plus whatever else is already in
// `variables`) repeatedly, merging every `sets` connection's `nodes` array
// across pages, until every connection has exhausted its own
// `pageInfo.totalPages`. On a "query complexity too high" error, shrinks
// perPage and restarts from page 1 - partial progress can't be kept once the
// page size changes, since page boundaries shift.
fn merge_sets_pointers(target: &mut Value, source: &Value, pointers: &[String]) {
    for pointer in pointers {
        let Some(source_nodes) = source
            .pointer(&format!("{pointer}/nodes"))
            .and_then(Value::as_array)
            .cloned()
        else {
            continue;
        };
        if let Some(target_nodes) = target
            .pointer_mut(&format!("{pointer}/nodes"))
            .and_then(Value::as_array_mut)
        {
            target_nodes.extend(source_nodes);
        }
    }
}

async fn fetch_paginated(
    api_token: &str,
    query: &str,
    mut variables: Value,
    initial_per_page: u32,
    locations: &[SetsLocation<'_>],
) -> Result<Value, String> {
    let mut per_page = initial_per_page.max(MIN_SETS_PAGE_SIZE);

    'restart: loop {
        variables["perPage"] = json!(per_page);
        let mut page = 1u32;
        let mut merged: Option<Value> = None;

        loop {
            variables["page"] = json!(page);

            let data = match startgg_graphql(api_token, query, variables.clone()).await {
                Ok(data) => data,
                Err(e) => {
                    if let Some(shrunk) = shrink_per_page_from_complexity_error(&e, per_page) {
                        per_page = shrunk;
                        continue 'restart;
                    }
                    return Err(e);
                }
            };

            let sets_pointers = resolve_sets_pointers(&data, locations);

            let mut any_nodes = false;
            let mut max_total_pages = 1u32;
            for pointer in &sets_pointers {
                if let Some(total) = data
                    .pointer(&format!("{pointer}/pageInfo/totalPages"))
                    .and_then(Value::as_u64)
                {
                    max_total_pages = max_total_pages.max(total as u32);
                }
                if let Some(nodes) = data
                    .pointer(&format!("{pointer}/nodes"))
                    .and_then(Value::as_array)
                {
                    any_nodes = any_nodes || !nodes.is_empty();
                }
            }

            merged = Some(match merged.take() {
                None => data,
                Some(mut target) => {
                    merge_sets_pointers(&mut target, &data, &sets_pointers);
                    target
                }
            });

            if page >= max_total_pages || !any_nodes {
                return Ok(merged.unwrap());
            }
            page += 1;
        }
    }
}

// For each entrant that made at least one character selection in this set's
// games, find their most-picked character name (ties broken by whichever was
// seen first).
// Reads `selectionValue` (the raw stored character id) rather than the
// `character { name }` resolver field - that resolver has been observed
// coming back empty for some tournaments even when the selection itself is
// populated, while `selectionValue` is the primitive the value is actually
// stored as and matches what reportBracketSet's own `characterId` input
// expects. IDs get resolved to names by the caller via the videogame's
// character list.
struct SetGameData {
    order: u32,
    winner_entrant_id: Option<u64>,
    character_picks: HashMap<u64, u64>,
}

struct SetCharacterData {
    // entrant_id -> most-picked character id across the whole set, for the
    // bracket view's single per-player icon.
    mode_by_entrant: HashMap<u64, u64>,
    // One entry per reported game, ordered by game number - for prefilling a
    // set editor's per-game winner/character pickers with what's actually
    // already been reported.
    per_game: Vec<SetGameData>,
}

fn parse_set_character_data(node: &Value) -> SetCharacterData {
    let mut counts: HashMap<u64, HashMap<u64, u32>> = HashMap::new();
    let mut per_game = Vec::new();

    let games = node.get("games").and_then(Value::as_array);
    let Some(games) = games else {
        return SetCharacterData {
            mode_by_entrant: HashMap::new(),
            per_game: Vec::new(),
        };
    };

    for (index, game) in games.iter().enumerate() {
        let order = game
            .get("orderNum")
            .and_then(parse_u64)
            .map(|n| n as u32)
            .unwrap_or((index + 1) as u32);

        let winner_entrant_id = game.get("winnerId").and_then(parse_u64);

        let selections = game
            .get("selections")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        let mut character_picks = HashMap::new();

        for selection in selections {
            let Some(entrant_id) = selection
                .get("entrant")
                .and_then(|e| e.get("id"))
                .and_then(parse_u64)
            else {
                continue;
            };

            let Some(character_id) = selection.get("selectionValue").and_then(parse_u64) else {
                continue;
            };

            character_picks.insert(entrant_id, character_id);
            *counts
                .entry(entrant_id)
                .or_default()
                .entry(character_id)
                .or_insert(0) += 1;
        }

        per_game.push(SetGameData {
            order,
            winner_entrant_id,
            character_picks,
        });
    }

    per_game.sort_by_key(|game| game.order);

    let mode_by_entrant = counts
        .into_iter()
        .filter_map(|(entrant_id, picks)| {
            picks
                .into_iter()
                .max_by_key(|(_, count)| *count)
                .map(|(character_id, _)| (entrant_id, character_id))
        })
        .collect();

    SetCharacterData {
        mode_by_entrant,
        per_game,
    }
}

fn parse_set_nodes(
    event_name: &str,
    nodes: &[Value],
    character_names: &HashMap<u64, String>,
) -> Vec<TournamentSet> {
    let mut out = Vec::new();
    let event_label = if event_name.trim().is_empty() {
        "Event".to_string()
    } else {
        event_name.to_string()
    };

    for node in nodes {
        let set_id = parse_id_string(node.get("id").unwrap_or(&Value::Null));
        let Some(set_id) = set_id else {
            continue;
        };

        let identifier = node
            .get("identifier")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|v| !v.is_empty());

        let round_text = {
            let full_round_text = read_text(node.get("fullRoundText"));
            if full_round_text.is_empty() {
                format!("Set {set_id}")
            } else {
                full_round_text
            }
        };

        let phase_group = node.get("phaseGroup");

        let phase_name = phase_group
            .and_then(|pg| pg.get("phase"))
            .and_then(|phase| phase.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|v| !v.is_empty());

        let phase_group_id = phase_group.and_then(|pg| pg.get("id")).and_then(parse_u64);

        let phase_group_identifier = phase_group
            .and_then(|pg| pg.get("displayIdentifier"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|v| !v.is_empty());

        let slots = node
            .get("slots")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let player1 = parse_slot(slots.first());
        let player2 = parse_slot(slots.get(1));

        let character_data = parse_set_character_data(node);
        let resolve_id = |character_id: Option<&u64>| {
            character_id.and_then(|id| character_names.get(id)).cloned()
        };
        let resolve_character = |entrant_id: Option<u64>| {
            resolve_id(entrant_id.and_then(|id| character_data.mode_by_entrant.get(&id)))
        };
        let player1_character = resolve_character(player1.entrant_id);
        let player2_character = resolve_character(player2.entrant_id);

        let games: Vec<GameCharacterPick> = character_data
            .per_game
            .iter()
            .map(|game| GameCharacterPick {
                game_num: game.order,
                winner_entrant_id: game.winner_entrant_id,
                player1_character: resolve_id(
                    player1
                        .entrant_id
                        .and_then(|id| game.character_picks.get(&id)),
                ),
                player2_character: resolve_id(
                    player2
                        .entrant_id
                        .and_then(|id| game.character_picks.get(&id)),
                ),
            })
            .collect();

        let state = parse_i32(node.get("state").unwrap_or(&Value::Null)).unwrap_or(0);
        let winner_id = parse_u64(node.get("winnerId").unwrap_or(&Value::Null));
        let round = parse_i32(node.get("round").unwrap_or(&Value::Null)).unwrap_or(0);

        // Once a set has a real reported score, that's the best evidence of
        // its actual best-of. Before that, default by context instead of
        // always guessing 3: round-robin pools are conventionally best of
        // 3, elimination bracket sets best of 5.
        let max_score = player1.score.max(player2.score);
        let phase_name_lower = phase_name.as_deref().unwrap_or_default().to_ascii_lowercase();
        let looks_like_pool_set =
            round == 0 || phase_name_lower.contains("pool") || phase_name_lower.contains("group");
        let best_of = if max_score >= 3 {
            5
        } else if looks_like_pool_set {
            3
        } else {
            5
        };

        out.push(TournamentSet {
            id: set_id,
            identifier,
            round_text,
            round,
            event_name: event_label.clone(),
            phase_name,
            phase_group_id,
            phase_group_identifier,
            state,
            winner_id,
            best_of,
            player1_character,
            player2_character,
            games,
            player1,
            player2,
        });
    }

    out
}

/// One tab's worth of sets. Grouped by phase group (i.e. one bucket per
/// pool) rather than by phase, so a "Pools" phase with several pools becomes
/// several tabs instead of one tab with everything mixed together.
struct GroupedBucket {
    key: String,
    sets: Vec<TournamentSet>,
}

fn group_key(set: &TournamentSet) -> String {
    if let Some(group_id) = set.phase_group_id {
        format!("pg:{group_id}")
    } else if let Some(phase) = &set.phase_name {
        format!("ep:{}::{}", set.event_name, phase)
    } else {
        format!("e:{}", set.event_name)
    }
}

fn push_sets_to_buckets(
    sets: Vec<TournamentSet>,
    all_sets: &mut Vec<TournamentSet>,
    grouped: &mut Vec<GroupedBucket>,
    seen_set_ids: &mut HashSet<String>,
) {
    for set in sets {
        if !seen_set_ids.insert(set.id.clone()) {
            continue;
        }

        all_sets.push(set.clone());

        let key = group_key(&set);
        match grouped.iter_mut().find(|bucket| bucket.key == key) {
            Some(bucket) => bucket.sets.push(set),
            None => grouped.push(GroupedBucket {
                key,
                sets: vec![set],
            }),
        }
    }
}

// The `videogame` field is documented as a single object, but has been
// observed wrapped in an array by some API responses - handle both shapes.
fn parse_videogame_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(id) = value.get("id").and_then(parse_u64) {
        return Some(id);
    }
    value.as_array()?.first()?.get("id").and_then(parse_u64)
}

// Peeks the videogame id straight out of a raw fetch response, before full
// parsing, so the character list can be fetched and threaded into
// parse_tournament_payload/parse_event_payload up front.
fn peek_tournament_videogame_id(data: &Value) -> Option<u64> {
    let events = data
        .pointer("/tournament/events")
        .and_then(Value::as_array)?;
    events
        .iter()
        .find_map(|event| parse_videogame_id(event.get("videogame")))
}

fn peek_event_videogame_id(data: &Value) -> Option<u64> {
    parse_videogame_id(data.pointer("/event/videogame"))
}

fn build_tournament_data(
    tournament_id: Option<u64>,
    tournament_name: String,
    slug: &str,
    videogame_id: Option<u64>,
    grouped: Vec<GroupedBucket>,
    all_sets: Vec<TournamentSet>,
) -> TournamentData {
    let total_sets = all_sets.len();

    // A bucket is a round-robin pool if none of its sets carry a bracket
    // round (round 0 everywhere); anything else - a single/double
    // elimination bracket, grand final, etc. - sorts ahead of every pool
    // within the same event, with pools after it in pool-number order.
    // Sorted by event first so a multi-event tournament keeps each event's
    // bracket+pools together rather than interleaving them.
    struct BucketSortKey {
        event_name: String,
        is_pool: bool,
        pool_number: Option<u64>,
        label: String,
    }

    let mut buckets_with_keys: Vec<(SetBucket, BucketSortKey)> = Vec::new();
    for bucket in grouped {
        let Some(first) = bucket.sets.first() else {
            continue;
        };

        // Two independent signals, since neither is guaranteed alone: sets
        // in a round-robin pool don't carry a bracket round, and start.gg's
        // own phase naming convention for these is "Pools"/"Pool"/"Groups".
        let phase_name_lower = first
            .phase_name
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_pool = bucket.sets.iter().all(|set| set.round == 0)
            || phase_name_lower.contains("pool")
            || phase_name_lower.contains("group");
        let pool_label = first
            .phase_group_identifier
            .clone()
            .unwrap_or_else(|| "?".to_string());

        let name = if is_pool {
            format!("{} - Pool {pool_label}", first.event_name)
        } else if let Some(phase) = &first.phase_name {
            format!("{} - {phase}", first.event_name)
        } else {
            first.event_name.clone()
        };

        let sort_key = BucketSortKey {
            event_name: first.event_name.clone(),
            is_pool,
            pool_number: pool_label.parse::<u64>().ok(),
            label: pool_label,
        };

        buckets_with_keys.push((
            SetBucket {
                id: normalize_bucket_id(&bucket.key),
                name,
                sets: bucket.sets,
            },
            sort_key,
        ));
    }

    buckets_with_keys.sort_by(|(_, a), (_, b)| {
        a.event_name
            .cmp(&b.event_name)
            .then_with(|| a.is_pool.cmp(&b.is_pool))
            .then_with(|| match (a.pool_number, b.pool_number) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.label.cmp(&b.label),
            })
    });

    let buckets: Vec<SetBucket> = buckets_with_keys
        .into_iter()
        .map(|(bucket, _)| bucket)
        .collect();

    TournamentData {
        tournament_id,
        tournament_name: if tournament_name.is_empty() {
            slug.to_string()
        } else {
            tournament_name
        },
        slug: slug.to_string(),
        fetched_at: Utc::now().to_rfc3339(),
        total_sets,
        videogame_id,
        buckets,
    }
}

fn parse_tournament_payload(
    data: &Value,
    slug: &str,
    character_names: &HashMap<u64, String>,
) -> Result<TournamentData, String> {
    let tournament = data
        .get("tournament")
        .ok_or_else(|| "start.gg response did not include tournament".to_string())?;

    if tournament.is_null() {
        return Err(format!("Tournament not found for slug '{slug}'"));
    }

    let tournament_id = parse_u64(tournament.get("id").unwrap_or(&Value::Null));
    let tournament_name = read_text(tournament.get("name"));

    let events = tournament
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "start.gg response missing events array".to_string())?;

    let mut grouped: Vec<GroupedBucket> = Vec::new();
    let mut all_sets: Vec<TournamentSet> = Vec::new();
    let mut seen_set_ids: HashSet<String> = HashSet::new();
    let mut videogame_id: Option<u64> = None;

    for event in events {
        let event_name = read_text(event.get("name"));
        let nodes = event
            .get("sets")
            .and_then(|s| s.get("nodes"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        if videogame_id.is_none() {
            videogame_id = parse_videogame_id(event.get("videogame"));
        }

        let sets = parse_set_nodes(&event_name, nodes, character_names);
        push_sets_to_buckets(sets, &mut all_sets, &mut grouped, &mut seen_set_ids);
    }

    Ok(build_tournament_data(
        tournament_id,
        tournament_name,
        slug,
        videogame_id,
        grouped,
        all_sets,
    ))
}

fn parse_event_payload(
    data: &Value,
    slug: &str,
    character_names: &HashMap<u64, String>,
) -> Result<TournamentData, String> {
    let event = data
        .get("event")
        .ok_or_else(|| "start.gg response did not include event".to_string())?;

    if event.is_null() {
        return Err(format!("Event not found for slug '{slug}'"));
    }

    let event_name = read_text(event.get("name"));

    let tournament = event.get("tournament").unwrap_or(&Value::Null);
    let tournament_id = parse_u64(tournament.get("id").unwrap_or(&Value::Null));
    let tournament_name = read_text(tournament.get("name"));
    let videogame_id = parse_videogame_id(event.get("videogame"));

    let direct_nodes = event
        .get("sets")
        .and_then(|s| s.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let mut grouped: Vec<GroupedBucket> = Vec::new();
    let mut all_sets: Vec<TournamentSet> = Vec::new();
    let mut seen_set_ids: HashSet<String> = HashSet::new();

    let direct_sets = parse_set_nodes(&event_name, direct_nodes, character_names);
    push_sets_to_buckets(direct_sets, &mut all_sets, &mut grouped, &mut seen_set_ids);

    if all_sets.is_empty() {
        let phase_groups = event
            .get("phaseGroups")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        for phase_group in phase_groups {
            let phase_group_nodes = phase_group
                .get("sets")
                .and_then(|s| s.get("nodes"))
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]);

            let phase_sets = parse_set_nodes(&event_name, phase_group_nodes, character_names);
            push_sets_to_buckets(phase_sets, &mut all_sets, &mut grouped, &mut seen_set_ids);
        }
    }

    Ok(build_tournament_data(
        tournament_id,
        tournament_name,
        slug,
        videogame_id,
        grouped,
        all_sets,
    ))
}

async fn fetch_tournament_payload(
    api_token: &str,
    slug: &str,
    per_page: u32,
) -> Result<Value, String> {
    let primary_query = r#"
        query TournamentSets($slug: String!, $perPage: Int!, $page: Int!) {
          tournament(slug: $slug) {
            id
            name
            events {
              id
              name
              videogame {
                id
              }
              sets(page: $page, perPage: $perPage) {
                pageInfo {
                  totalPages
                }
                nodes {
                  id
                  identifier
                  fullRoundText
                  state
                  winnerId
                  round
                  phaseGroup {
                    id
                    displayIdentifier
                    phase {
                      id
                      name
                    }
                  }
                  slots {
                    slotIndex
                    prereqType
                    prereqId
                    prereqPlacement
                    entrant {
                      id
                      name
                    }
                    standing {
                      stats {
                        score {
                          value
                        }
                      }
                    }
                  }
                  games {
                    orderNum
                    winnerId
                    selections {
                      entrant {
                        id
                      }
                      selectionValue
                    }
                  }
                }
              }
            }
          }
        }
    "#;

    let filtered_query = r#"
        query TournamentSetsFiltered($slug: String!, $perPage: Int!, $page: Int!, $states: [Int!]) {
          tournament(slug: $slug) {
            id
            name
            events {
              id
              name
              videogame {
                id
              }
              sets(
                page: $page
                perPage: $perPage
                sortType: CALL_ORDER
                filters: {
                  hideEmpty: false
                  showByes: true
                  state: $states
                }
              ) {
                pageInfo {
                  totalPages
                }
                nodes {
                  id
                  identifier
                  fullRoundText
                  state
                  winnerId
                  round
                  phaseGroup {
                    id
                    displayIdentifier
                    phase {
                      id
                      name
                    }
                  }
                  slots {
                    slotIndex
                    prereqType
                    prereqId
                    prereqPlacement
                    entrant {
                      id
                      name
                    }
                    standing {
                      stats {
                        score {
                          value
                        }
                      }
                    }
                  }
                  games {
                    orderNum
                    winnerId
                    selections {
                      entrant {
                        id
                      }
                      selectionValue
                    }
                  }
                }
              }
            }
          }
        }
    "#;

    let fallback_query = r#"
        query TournamentSetsFallback($slug: String!, $perPage: Int!, $page: Int!) {
          tournament(slug: $slug) {
            id
            name
            events {
              id
              name
              videogame {
                id
              }
              sets(page: $page, perPage: $perPage) {
                pageInfo {
                  totalPages
                }
                nodes {
                  id
                  identifier
                  fullRoundText
                  state
                  winnerId
                  round
                  slots {
                    slotIndex
                    prereqType
                    prereqId
                    prereqPlacement
                    entrant {
                      id
                      name
                    }
                    standing {
                      stats {
                        score {
                          value
                        }
                      }
                    }
                  }
                  games {
                    orderNum
                    winnerId
                    selections {
                      entrant {
                        id
                      }
                      selectionValue
                    }
                  }
                }
              }
            }
          }
        }
    "#;

    let base_variables = json!({ "slug": slug });

    let filtered_variables = json!({
        "slug": slug,
        "states": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });

    let locations = [SetsLocation::PerArrayEntry {
        array_pointer: "/tournament/events",
        sets_relative: "/sets",
    }];

    let attempts = vec![
        (primary_query, base_variables.clone()),
        (filtered_query, filtered_variables),
        (fallback_query, base_variables),
    ];

    fetch_best_sets_payload(api_token, attempts, per_page, &locations)
        .await
        .map_err(|e| format!("Failed to fetch tournament data. {e}"))
}

async fn fetch_event_payload(api_token: &str, slug: &str, per_page: u32) -> Result<Value, String> {
    let primary_query = r#"
        query EventSets($slug: String!, $perPage: Int!, $page: Int!) {
          event(slug: $slug) {
            id
            name
            tournament {
              id
              name
            }
            videogame {
              id
            }
            sets(page: $page, perPage: $perPage) {
              pageInfo {
                totalPages
              }
              nodes {
                id
                identifier
                fullRoundText
                state
                winnerId
                round
                phaseGroup {
                  id
                  displayIdentifier
                  phase {
                    id
                    name
                  }
                }
                slots {
                  slotIndex
                  prereqType
                  prereqId
                  prereqPlacement
                  entrant {
                    id
                    name
                  }
                  standing {
                    stats {
                      score {
                        value
                      }
                    }
                  }
                }
                games {
                  orderNum
                  winnerId
                  selections {
                    entrant {
                      id
                    }
                    selectionValue
                  }
                }
              }
            }
          }
        }
    "#;

    let filtered_query = r#"
        query EventSetsFiltered($slug: String!, $perPage: Int!, $page: Int!, $states: [Int!]) {
          event(slug: $slug) {
            id
            name
            tournament {
              id
              name
            }
            videogame {
              id
            }
            sets(
              page: $page
              perPage: $perPage
              sortType: CALL_ORDER
              filters: {
                hideEmpty: false
                showByes: true
                state: $states
              }
            ) {
              pageInfo {
                totalPages
              }
              nodes {
                id
                identifier
                fullRoundText
                state
                winnerId
                round
                phaseGroup {
                  id
                  displayIdentifier
                  phase {
                    id
                    name
                  }
                }
                slots {
                  slotIndex
                  prereqType
                  prereqId
                  prereqPlacement
                  entrant {
                    id
                    name
                  }
                  standing {
                    stats {
                      score {
                        value
                      }
                    }
                  }
                }
                games {
                  orderNum
                  winnerId
                  selections {
                    entrant {
                      id
                    }
                    selectionValue
                  }
                }
              }
            }
          }
        }
    "#;

    let fallback_query = r#"
        query EventSetsFallback($slug: String!, $perPage: Int!, $page: Int!) {
          event(slug: $slug) {
            id
            name
            tournament {
              id
              name
            }
            videogame {
              id
            }
            sets(page: $page, perPage: $perPage) {
              pageInfo {
                totalPages
              }
              nodes {
                id
                identifier
                fullRoundText
                state
                winnerId
                round
                slots {
                  slotIndex
                  prereqType
                  prereqId
                  prereqPlacement
                  entrant {
                    id
                    name
                  }
                  standing {
                    stats {
                      score {
                        value
                      }
                    }
                  }
                }
                games {
                  orderNum
                  winnerId
                  selections {
                    entrant {
                      id
                    }
                    selectionValue
                  }
                }
              }
            }
          }
        }
    "#;

    let base_variables = json!({ "slug": slug });

    let filtered_variables = json!({
        "slug": slug,
        "states": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });

    let locations = [SetsLocation::Single {
        object_pointer: "/event",
        sets_relative: "/sets",
    }];

    let attempts = vec![
        (primary_query, base_variables.clone()),
        (filtered_query, filtered_variables),
        (fallback_query, base_variables),
    ];

    let mut data = fetch_best_sets_payload(api_token, attempts, per_page, &locations)
        .await
        .map_err(|e| format!("Failed to fetch event data. {e}"))?;

    // Most events expose sets directly. Phase-group-level sets are only a
    // fallback for the (rarer) events that don't, and can mean fetching many
    // separate paginated connections (one per pool) - so only pay for that
    // extra round-trip when the direct sets connection actually came back
    // empty, instead of fetching it unconditionally on every request.
    let has_direct_sets = data
        .pointer("/event/sets/nodes")
        .and_then(Value::as_array)
        .map(|nodes| !nodes.is_empty())
        .unwrap_or(false);

    if !has_direct_sets {
        if let Ok(phase_groups) = fetch_event_phase_group_sets(api_token, slug, per_page).await {
            if let Some(event) = data.get_mut("event").and_then(Value::as_object_mut) {
                event.insert("phaseGroups".to_string(), phase_groups);
            }
        }
    }

    Ok(data)
}

// Fetches every phase group's own `sets` connection for an event, each
// paginated independently. Kept separate from the main event query (rather
// than requested alongside it every time) since it's only needed as a
// fallback and can otherwise multiply request count by the number of pools.
async fn fetch_event_phase_group_sets(
    api_token: &str,
    slug: &str,
    per_page: u32,
) -> Result<Value, String> {
    let query = r#"
        query EventPhaseGroupSets($slug: String!, $perPage: Int!, $page: Int!) {
          event(slug: $slug) {
            phaseGroups {
              id
              sets(page: $page, perPage: $perPage) {
                pageInfo {
                  totalPages
                }
                nodes {
                  id
                  identifier
                  fullRoundText
                  state
                  winnerId
                  round
                  phaseGroup {
                    id
                    displayIdentifier
                    phase {
                      id
                      name
                    }
                  }
                  slots {
                    slotIndex
                    prereqType
                    prereqId
                    prereqPlacement
                    entrant {
                      id
                      name
                    }
                    standing {
                      stats {
                        score {
                          value
                        }
                      }
                    }
                  }
                  games {
                    orderNum
                    winnerId
                    selections {
                      entrant {
                        id
                      }
                      selectionValue
                    }
                  }
                }
              }
            }
          }
        }
    "#;

    let locations = [SetsLocation::PerArrayEntry {
        array_pointer: "/event/phaseGroups",
        sets_relative: "/sets",
    }];

    let data = fetch_paginated(
        api_token,
        query,
        json!({ "slug": slug }),
        per_page,
        &locations,
    )
    .await?;

    Ok(data
        .pointer("/event/phaseGroups")
        .cloned()
        .unwrap_or_else(|| json!([])))
}

#[tauri::command]
fn load_app_config() -> Result<AppConfig, String> {
    let path = config_file_path()?;

    if !path.exists() {
        return Ok(AppConfig::default());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed reading config file '{}': {e}", path.display()))?;

    serde_json::from_str::<AppConfig>(&raw)
        .map_err(|e| format!("Config file is invalid JSON '{}': {e}", path.display()))
}

#[tauri::command]
fn save_app_config(config: AppConfig) -> Result<(), String> {
    let path = config_file_path()?;

    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;

    fs::write(&path, json).map_err(|e| format!("Failed writing config '{}': {e}", path.display()))
}

#[tauri::command]
async fn fetch_tournament_state(request: FetchTournamentRequest) -> Result<TournamentData, String> {
    if request.api_token.trim().is_empty() {
        return Err("Missing start.gg API token".to_string());
    }

    if request.tournament_slug.trim().is_empty() {
        return Err("Missing tournament slug".to_string());
    }

    let per_page = request.per_page.unwrap_or(128).clamp(10, 500);
    let normalized_tournament_slug = normalize_tournament_slug(&request.tournament_slug);
    let normalized_event_slug = normalize_event_slug(&request.tournament_slug);

    if let Some(event_slug) = normalized_event_slug {
        match fetch_event_payload(&request.api_token, &event_slug, per_page).await {
            Ok(event_data) => {
                let event_characters =
                    character_name_map(&request.api_token, peek_event_videogame_id(&event_data))
                        .await;
                let parsed_event =
                    parse_event_payload(&event_data, &event_slug, &event_characters)?;

                if parsed_event.total_sets > 0 {
                    return Ok(parsed_event);
                }

                let tournament_data = fetch_tournament_payload(
                    &request.api_token,
                    &normalized_tournament_slug,
                    per_page,
                )
                .await;

                return match tournament_data {
                    Ok(data) => {
                        let tournament_characters = character_name_map(
                            &request.api_token,
                            peek_tournament_videogame_id(&data),
                        )
                        .await;
                        let parsed_tournament = parse_tournament_payload(
                            &data,
                            &normalized_tournament_slug,
                            &tournament_characters,
                        )?;
                        if parsed_tournament.total_sets > 0 {
                            Ok(parsed_tournament)
                        } else {
                            Ok(parsed_event)
                        }
                    }
                    Err(_) => Ok(parsed_event),
                };
            }
            Err(event_error) => {
                let tournament_data = fetch_tournament_payload(
                    &request.api_token,
                    &normalized_tournament_slug,
                    per_page,
                )
                .await;

                return match tournament_data {
                    Ok(data) => {
                        let tournament_characters = character_name_map(
                            &request.api_token,
                            peek_tournament_videogame_id(&data),
                        )
                        .await;
                        parse_tournament_payload(&data, &normalized_tournament_slug, &tournament_characters)
                    }
                    Err(tournament_error) => Err(format!(
                        "Failed to fetch using event slug and tournament fallback. Event error: {event_error}. Tournament error: {tournament_error}"
                    )),
                };
            }
        }
    }

    let data =
        fetch_tournament_payload(&request.api_token, &normalized_tournament_slug, per_page).await?;
    let tournament_characters =
        character_name_map(&request.api_token, peek_tournament_videogame_id(&data)).await;
    parse_tournament_payload(&data, &normalized_tournament_slug, &tournament_characters)
}

// Non-fatal: if the character list can't be fetched (or the tournament's
// videogame is unknown), sets just come back without character data instead
// of failing the whole tournament load.
// A videogame's character roster is effectively static for the lifetime of
// the app, so cache it in memory instead of re-fetching on every "Refresh
// Tournament" click.
fn character_cache() -> &'static std::sync::Mutex<HashMap<u64, HashMap<u64, String>>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<u64, HashMap<u64, String>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

async fn character_name_map(api_token: &str, videogame_id: Option<u64>) -> HashMap<u64, String> {
    let Some(videogame_id) = videogame_id else {
        return HashMap::new();
    };

    if let Some(cached) = character_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&videogame_id)
    {
        return cached.clone();
    }

    let map: HashMap<u64, String> = fetch_videogame_characters(api_token, videogame_id)
        .await
        .map(|characters| characters.into_iter().map(|c| (c.id, c.name)).collect())
        .unwrap_or_default();

    if !map.is_empty() {
        character_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(videogame_id, map.clone());
    }

    map
}

async fn fetch_videogame_characters(
    api_token: &str,
    videogame_id: u64,
) -> Result<Vec<GameCharacter>, String> {
    let query = r#"
        query VideogameCharacters($id: ID!) {
          videogame(id: $id) {
            characters {
              id
              name
            }
          }
        }
    "#;

    let data = startgg_graphql(api_token, query, json!({ "id": videogame_id.to_string() })).await?;

    let characters = data
        .get("videogame")
        .and_then(|v| v.get("characters"))
        .and_then(Value::as_array)
        .ok_or_else(|| "start.gg response did not include characters".to_string())?;

    Ok(characters
        .iter()
        .filter_map(|c| {
            let id = parse_u64(c.get("id")?)?;
            let name = c.get("name")?.as_str()?.to_string();
            Some(GameCharacter { id, name })
        })
        .collect())
}

#[tauri::command]
async fn fetch_game_characters(
    request: FetchCharactersRequest,
) -> Result<Vec<GameCharacter>, String> {
    if request.api_token.trim().is_empty() {
        return Err("Missing start.gg API token".to_string());
    }

    fetch_videogame_characters(&request.api_token, request.videogame_id).await
}

fn best_image_url(images: Option<&Vec<Value>>) -> Option<String> {
    let images = images?;
    let chosen = images
        .iter()
        .find(|img| img.get("type").and_then(Value::as_str) == Some("profile"))
        .or_else(|| images.first())?;
    chosen
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
}

// Picks the participant's profile picture: prefer one explicitly typed
// "profile", otherwise fall back to whatever image is available.
fn best_participant_image_url(entrant: &Value) -> Option<String> {
    let participants = entrant.get("participants").and_then(Value::as_array)?;
    for participant in participants {
        // The account's actual profile picture lives on the underlying
        // User (the same one shown across start.gg's own site); a
        // participant's own `images` is a separate, rarely-populated field
        // (e.g. tournament-specific uploads), so try the user's image first.
        let user_images = participant
            .pointer("/player/user/images")
            .and_then(Value::as_array);
        if let Some(url) = best_image_url(user_images) {
            return Some(url);
        }

        let participant_images = participant.get("images").and_then(Value::as_array);
        if let Some(url) = best_image_url(participant_images) {
            return Some(url);
        }
    }
    None
}

// Fetches every requested entrant's profile picture URL in a single
// request, using one aliased `entrant(id: ...)` field per id so this stays
// one round-trip regardless of how many entrants are asked for.
async fn fetch_entrant_avatar_urls(api_token: &str, entrant_ids: &[u64]) -> HashMap<u64, String> {
    if entrant_ids.is_empty() {
        return HashMap::new();
    }

    let fields: String = entrant_ids
        .iter()
        .enumerate()
        .map(|(i, id)| {
            format!(
                "e{i}: entrant(id: {id}) {{ id participants {{ images {{ type url }} player {{ user {{ images {{ type url }} }} }} }} }}"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let query = format!("query EntrantAvatars {{ {fields} }}");

    let Ok(data) = startgg_graphql(api_token, &query, json!({})).await else {
        return HashMap::new();
    };

    let Some(fields) = data.as_object() else {
        return HashMap::new();
    };

    fields
        .values()
        .filter_map(|entrant| {
            let id = parse_u64(entrant.get("id")?)?;
            let url = best_participant_image_url(entrant)?;
            Some((id, url))
        })
        .collect()
}

#[tauri::command]
async fn fetch_entrant_avatars(request: FetchAvatarsRequest) -> Result<EntrantAvatars, String> {
    if request.api_token.trim().is_empty() {
        return Err("Missing start.gg API token".to_string());
    }

    let entrant_ids: Vec<u64> = [request.player1_entrant_id, request.player2_entrant_id]
        .into_iter()
        .flatten()
        .collect();

    let urls = fetch_entrant_avatar_urls(&request.api_token, &entrant_ids).await;

    Ok(EntrantAvatars {
        player1_avatar: request
            .player1_entrant_id
            .and_then(|id| urls.get(&id).cloned()),
        player2_avatar: request
            .player2_entrant_id
            .and_then(|id| urls.get(&id).cloned()),
    })
}

#[tauri::command]
async fn report_set_result(request: ReportSetRequest) -> Result<ReportSetResult, String> {
    if request.api_token.trim().is_empty() {
        return Err("Missing start.gg API token".to_string());
    }

    if request.set_id.trim().is_empty() {
        return Err("Invalid set ID".to_string());
    }

    if request.winner_id == 0 {
        return Err("Invalid winner ID".to_string());
    }

    let base_variables = json!({
        "setId": request.set_id.to_string(),
        "winnerId": request.winner_id.to_string(),
    });

    let mut attempts: Vec<(&str, Value)> = Vec::new();

    // Per-game data (winner, character selections) is optional and comes
    // from a set editor's game rows, so only attempt it when there's
    // something to report; if the API rejects gameData outright, we still
    // fall back to the plain winner-only mutations below.
    if let Some(games) = request.game_data.as_ref().filter(|g| !g.is_empty()) {
        let game_data_value: Vec<Value> = games
            .iter()
            .map(|game| {
                let selections: Vec<Value> = game
                    .selections
                    .iter()
                    .map(|s| {
                        json!({
                            "entrantId": s.entrant_id.to_string(),
                            "characterId": s.character_id,
                        })
                    })
                    .collect();

                json!({
                    "gameNum": game.game_num,
                    "winnerId": game.winner_id.map(|w| w.to_string()),
                    "selections": selections,
                })
            })
            .collect();

        let mut variables_with_game_data = base_variables.clone();
        variables_with_game_data["gameData"] = json!(game_data_value);

        attempts.push((
            r#"
                mutation ReportSet($setId: ID!, $winnerId: ID!, $gameData: [BracketSetGameDataInput]) {
                  reportBracketSet(setId: $setId, winnerId: $winnerId, gameData: $gameData) {
                    id
                    winnerId
                    state
                  }
                }
            "#,
            variables_with_game_data,
        ));
    }

    attempts.push((
        r#"
            mutation ReportSet($setId: ID!, $winnerId: ID!) {
              reportBracketSet(setId: $setId, winnerId: $winnerId) {
                id
                winnerId
                state
              }
            }
        "#,
        base_variables.clone(),
    ));
    attempts.push((
        r#"
            mutation ReportSet($setId: ID!, $winnerId: ID!) {
              reportBracketSet(setId: $setId, winnerId: $winnerId)
            }
        "#,
        base_variables.clone(),
    ));
    attempts.push((
        r#"
            mutation ReportSet($setId: ID!, $winnerId: ID!) {
              reportBracketSet(setId: $setId, winnerId: $winnerId, isDQ: false)
            }
        "#,
        base_variables,
    ));

    let mut failures = Vec::new();

    for (mutation, variables) in attempts {
        match startgg_graphql(&request.api_token, mutation, variables).await {
            Ok(_) => {
                return Ok(ReportSetResult {
                    success: true,
                    message: format!(
                        "Set {} reported successfully with winner {}",
                        request.set_id, request.winner_id
                    ),
                })
            }
            Err(e) => failures.push(e),
        }
    }

    Err(format!(
        "Failed to report set after {} attempts: {}",
        failures.len(),
        failures.join(" | ")
    ))
}

// Character portraits: TSH's CharacterDisplay() (include/assetUtils.js)
// requires `player.character` to be an object keyed by arbitrary ids, each
// with a `codename` and an `assets` map of `{ asset: "<path relative to the
// TSH root>" }`; entries without a codename are skipped entirely. The icon
// itself has to physically exist under the TSH out/ directory (the layout
// loads it via a "../../" relative file path), so stage the bundled PNG
// there the first time each character is used.
fn character_asset(out_dir: Option<&Path>, icon: Option<&str>) -> Option<Value> {
    let slug = icon?;
    let out_dir = out_dir?;
    let file_name = format!("{slug}.png");
    let source = CHARACTER_ICONS.get_file(&file_name)?;

    let icons_dir = out_dir.join("character-icons");
    let dest = icons_dir.join(&file_name);
    if !dest.exists() {
        fs::create_dir_all(&icons_dir).ok()?;
        fs::write(&dest, source.contents()).ok()?;
    }

    Some(json!({
        "0": {
            "codename": slug,
            "assets": {
                "portrait": {
                    "asset": format!("out/character-icons/{file_name}"),
                }
            }
        }
    }))
}

// Mirrors the schema TSH's own StateManager writes to out/program_state.json
// (score keyed by scoreboard number, team/player nesting, tournamentInfo at
// the top level, country/state as objects). TSH's layout JS dereferences
// `player.country.asset` and `player.state.asset` unconditionally, so those
// must be objects (even empty ones) rather than missing or a bare string,
// or the layout's Update() throws and the overlay stops rendering entirely.
//
// Only `online_avatar` (a direct start.gg URL) is populated, not the
// local-file `avatar` field - layouts that render both would otherwise show
// the same profile picture twice. (A locally staged copy under a fixed
// filename was tried and reverted - it could serve a stale cached image for
// the previous set instead of the current one.)
fn player_payload(player: &OverlayPlayer, out_dir: Option<&Path>) -> Value {
    json!({
        "name": player.name,
        "characterName": player.character.clone().unwrap_or_default(),
        "character": character_asset(out_dir, player.character_icon.as_deref()).unwrap_or(json!({})),
        "country": {},
        "state": {},
        "pronoun": "",
        "twitter": "",
        "avatar": "",
        "online_avatar": player.avatar_url.clone().unwrap_or_default(),
    })
}

#[tauri::command]
fn write_stream_overlay(request: WriteOverlayRequest) -> Result<(), String> {
    let output = request.output_path.trim();
    if output.is_empty() {
        return Err("Overlay output path is empty".to_string());
    }

    let path = Path::new(output);

    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory '{}': {e}", parent.display()))?;
        }
    }

    let out_dir = path.parent().filter(|p| !p.as_os_str().is_empty());

    let payload = json!({
        "timestamp": Utc::now().timestamp_millis() as f64 / 1000.0,
        "tournamentInfo": {
            "tournamentName": request.tournament_name,
        },
        "score": {
            "1": {
                "best_of": request.best_of,
                "match": request.round_text,
                "phase": request.event_name,
                "team": {
                    "1": {
                        "score": request.player1.score,
                        "player": {
                            "1": player_payload(&request.player1, out_dir),
                        }
                    },
                    "2": {
                        "score": request.player2.score,
                        "player": {
                            "1": player_payload(&request.player2, out_dir),
                        }
                    }
                }
            }
        }
    });

    let serialized = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to serialize overlay JSON: {e}"))?;

    fs::write(path, serialized)
        .map_err(|e| format!("Failed to write overlay file '{}': {e}", path.display()))
}

#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

// gst-plugin-pipewire hides *every* plain V4L2 device (gstv4l2deviceprovider),
// including ones PipeWire itself never exposes (e.g. v4l2loopback virtual
// cameras), as soon as it sees any PipeWire node backed by a real /dev/video*
// device. On top of that, WebKitGTK's getUserMedia negotiates a DMABuf
// (zero-copy) format through pipewiresrc that can fail caps fixation for some
// webcams, leaving the video track blank. Excluding the plugin from
// GStreamer's scan restores every plain V4L2 camera and a working (if
// non-zero-copy) capture pipeline. Must run before GStreamer's registry is
// first scanned, i.e. before any webview/WebKitWebProcess is created.
#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn disable_gstreamer_pipewire_plugin() {
    use std::{fs, os::unix::fs::symlink, path::Path};

    let Some(source_dir) = ["/usr/lib/gstreamer-1.0", "/usr/lib64/gstreamer-1.0"]
        .into_iter()
        .map(Path::new)
        .find(|dir| dir.join("libgstpipewire.so").exists())
    else {
        return;
    };

    // Reused across runs (not per-PID): GStreamer skips rescanning a registry
    // whose backing plugin files haven't changed, which keeps startup fast.
    // A fresh path every launch would force a full rescan on every start and
    // race with the webview's near-immediate camera enumeration on mount.
    let Ok(mut filtered_dir) = config_file_path() else {
        return;
    };
    filtered_dir.pop();
    filtered_dir.push("gst-plugins");

    let Ok(entries) = fs::create_dir_all(&filtered_dir).and_then(|_| fs::read_dir(source_dir))
    else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("so")
            || path.file_name().and_then(|n| n.to_str()) == Some("libgstpipewire.so")
        {
            continue;
        }
        let _ = symlink(&path, filtered_dir.join(entry.file_name()));
    }

    std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &filtered_dir);
    std::env::set_var("GST_REGISTRY", filtered_dir.join("registry.bin"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    disable_gstreamer_pipewire_plugin();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // WebKitGTK (Tauri's Linux webview) denies getUserMedia by default
            // unless the host app answers its "permission-request" signal itself;
            // wry doesn't do this for us on Linux like it does on Windows/Android.
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            {
                use tauri::Manager;

                if let Some(main_webview) = _app.get_webview_window("main") {
                    main_webview.with_webview(|webview| {
                        use webkit2gtk::{
                            glib::Cast, PermissionRequestExt, UserMediaPermissionRequest,
                            WebViewExt,
                        };

                        webview.inner().connect_permission_request(|_, request| {
                            match request.downcast_ref::<UserMediaPermissionRequest>() {
                                Some(request) => {
                                    request.allow();
                                    true
                                }
                                None => false,
                            }
                        });
                    })?;
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_app_config,
            save_app_config,
            fetch_tournament_state,
            fetch_game_characters,
            fetch_entrant_avatars,
            report_set_result,
            write_stream_overlay,
            get_platform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
