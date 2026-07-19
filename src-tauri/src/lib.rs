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
    set_id: u64,
    winner_id: u64,
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
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TournamentData {
    tournament_id: Option<u64>,
    tournament_name: String,
    slug: String,
    fetched_at: String,
    total_sets: usize,
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
    id: u64,
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
    player1: EntrantSlot,
    player2: EntrantSlot,
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
    source_set_id: Option<u64>,
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

fn default_slot(label: &str) -> EntrantSlot {
    EntrantSlot {
        entrant_id: None,
        name: label.to_string(),
        score: 0,
        source_type: None,
        source_set_id: None,
        source_placement: None,
    }
}

fn parse_slot(slot: Option<&Value>, fallback_name: &str) -> EntrantSlot {
    let Some(slot) = slot else {
        return default_slot(fallback_name);
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
        slot.get("prereqId").and_then(parse_u64)
    } else {
        None
    };

    let source_placement = slot.get("prereqPlacement").and_then(parse_i32);

    EntrantSlot {
        entrant_id,
        name: if name.is_empty() {
            fallback_name.to_string()
        } else {
            name
        },
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

async fn startgg_graphql(api_token: &str, query: &str, variables: Value) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("main_tourney_manager_gg/0.1")
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

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

fn parse_set_nodes(event_name: &str, nodes: &[Value]) -> Vec<TournamentSet> {
    let mut out = Vec::new();
    let event_label = if event_name.trim().is_empty() {
        "Event".to_string()
    } else {
        event_name.to_string()
    };

    for node in nodes {
        let set_id = parse_u64(node.get("id").unwrap_or(&Value::Null));
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

        let phase_group_id = phase_group
            .and_then(|pg| pg.get("id"))
            .and_then(parse_u64);

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

        let player1 = parse_slot(slots.first(), "Player 1");
        let player2 = parse_slot(slots.get(1), "Player 2");

        let state = parse_i32(node.get("state").unwrap_or(&Value::Null)).unwrap_or(0);
        let winner_id = parse_u64(node.get("winnerId").unwrap_or(&Value::Null));
        let round = parse_i32(node.get("round").unwrap_or(&Value::Null)).unwrap_or(0);

        let max_score = player1.score.max(player2.score);
        let best_of = if max_score >= 3 { 5 } else { 3 };

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
    seen_set_ids: &mut HashSet<u64>,
) {
    for set in sets {
        if !seen_set_ids.insert(set.id) {
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

fn build_tournament_data(
    tournament_id: Option<u64>,
    tournament_name: String,
    slug: &str,
    grouped: Vec<GroupedBucket>,
    all_sets: Vec<TournamentSet>,
) -> TournamentData {
    let total_sets = all_sets.len();

    // Count how many phase groups share the same (event, phase) so a
    // single-group phase (or a bracket, which normally has just one group)
    // doesn't get a redundant "Pool N" suffix - only actual multi-pool
    // phases do.
    let mut phase_group_counts: HashMap<(String, String), usize> = HashMap::new();
    for bucket in &grouped {
        if let Some(first) = bucket.sets.first() {
            let phase = first.phase_name.clone().unwrap_or_default();
            *phase_group_counts
                .entry((first.event_name.clone(), phase))
                .or_insert(0) += 1;
        }
    }

    let mut buckets = Vec::new();
    for bucket in grouped {
        let Some(first) = bucket.sets.first() else {
            continue;
        };

        let phase = first.phase_name.clone();
        let base_name = if let Some(phase) = &phase {
            format!("{} - {}", first.event_name, phase)
        } else {
            first.event_name.clone()
        };

        let phase_key = (first.event_name.clone(), phase.clone().unwrap_or_default());
        let group_count = phase_group_counts.get(&phase_key).copied().unwrap_or(1);

        let name = if group_count > 1 {
            let pool_label = first
                .phase_group_identifier
                .clone()
                .unwrap_or_else(|| "?".to_string());
            format!("{base_name} Pool {pool_label}")
        } else {
            base_name
        };

        buckets.push(SetBucket {
            id: normalize_bucket_id(&bucket.key),
            name,
            sets: bucket.sets,
        });
    }

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
        buckets,
    }
}

fn parse_tournament_payload(data: &Value, slug: &str) -> Result<TournamentData, String> {
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
    let mut seen_set_ids: HashSet<u64> = HashSet::new();

    for event in events {
        let event_name = read_text(event.get("name"));
        let nodes = event
            .get("sets")
            .and_then(|s| s.get("nodes"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);

        let sets = parse_set_nodes(&event_name, nodes);
        push_sets_to_buckets(sets, &mut all_sets, &mut grouped, &mut seen_set_ids);
    }

    Ok(build_tournament_data(
        tournament_id,
        tournament_name,
        slug,
        grouped,
        all_sets,
    ))
}

fn parse_event_payload(data: &Value, slug: &str) -> Result<TournamentData, String> {
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

    let direct_nodes = event
        .get("sets")
        .and_then(|s| s.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let mut grouped: Vec<GroupedBucket> = Vec::new();
    let mut all_sets: Vec<TournamentSet> = Vec::new();
    let mut seen_set_ids: HashSet<u64> = HashSet::new();

    let direct_sets = parse_set_nodes(&event_name, direct_nodes);
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

            let phase_sets = parse_set_nodes(&event_name, phase_group_nodes);
            push_sets_to_buckets(phase_sets, &mut all_sets, &mut grouped, &mut seen_set_ids);
        }
    }

    Ok(build_tournament_data(
        tournament_id,
        tournament_name,
        slug,
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
        query TournamentSets($slug: String!, $perPage: Int!) {
          tournament(slug: $slug) {
            id
            name
            events {
              id
              name
              sets(page: 1, perPage: $perPage) {
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
                }
              }
            }
          }
        }
    "#;

    let filtered_query = r#"
        query TournamentSetsFiltered($slug: String!, $perPage: Int!, $states: [Int!]) {
          tournament(slug: $slug) {
            id
            name
            events {
              id
              name
              sets(
                page: 1
                perPage: $perPage
                sortType: CALL_ORDER
                filters: {
                  hideEmpty: false
                  showByes: true
                  state: $states
                }
              ) {
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
                }
              }
            }
          }
        }
    "#;

    let fallback_query = r#"
        query TournamentSetsFallback($slug: String!, $perPage: Int!) {
          tournament(slug: $slug) {
            id
            name
            events {
              id
              name
              sets(page: 1, perPage: $perPage) {
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
                }
              }
            }
          }
        }
    "#;

    let base_variables = json!({
        "slug": slug,
        "perPage": per_page,
    });

    let filtered_variables = json!({
        "slug": slug,
        "perPage": per_page,
        "states": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });

    match startgg_graphql(api_token, primary_query, base_variables.clone()).await {
        Ok(data) => Ok(data),
        Err(primary_error) => {
            match startgg_graphql(api_token, filtered_query, filtered_variables).await {
                Ok(data) => Ok(data),
                Err(filtered_error) => {
                    let fallback = startgg_graphql(api_token, fallback_query, base_variables).await;
                    match fallback {
                    Ok(data) => Ok(data),
                    Err(fallback_error) => Err(format!(
                        "Failed to fetch tournament data. Primary query error: {primary_error}. Filtered query error: {filtered_error}. Fallback query error: {fallback_error}"
                    )),
                }
                }
            }
        }
    }
}

async fn fetch_event_payload(api_token: &str, slug: &str, per_page: u32) -> Result<Value, String> {
    let primary_query = r#"
        query EventSets($slug: String!, $perPage: Int!) {
          event(slug: $slug) {
            id
            name
            tournament {
              id
              name
            }
            sets(page: 1, perPage: $perPage) {
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
              }
            }
            phaseGroups {
              id
              sets(page: 1, perPage: $perPage) {
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
                }
              }
            }
          }
        }
    "#;

    let filtered_query = r#"
        query EventSetsFiltered($slug: String!, $perPage: Int!, $states: [Int!]) {
          event(slug: $slug) {
            id
            name
            tournament {
              id
              name
            }
            sets(
              page: 1
              perPage: $perPage
              sortType: CALL_ORDER
              filters: {
                hideEmpty: false
                showByes: true
                state: $states
              }
            ) {
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
              }
            }
            phaseGroups {
              id
              sets(
                page: 1
                perPage: $perPage
                sortType: CALL_ORDER
                filters: {
                  hideEmpty: false
                  showByes: true
                  state: $states
                }
              ) {
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
                }
              }
            }
          }
        }
    "#;

    let fallback_query = r#"
        query EventSetsFallback($slug: String!, $perPage: Int!) {
          event(slug: $slug) {
            id
            name
            tournament {
              id
              name
            }
            sets(page: 1, perPage: $perPage) {
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
              }
            }
          }
        }
    "#;

    let base_variables = json!({
        "slug": slug,
        "perPage": per_page,
    });

    let filtered_variables = json!({
        "slug": slug,
        "perPage": per_page,
        "states": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    });

    match startgg_graphql(api_token, primary_query, base_variables.clone()).await {
        Ok(data) => Ok(data),
        Err(primary_error) => {
            match startgg_graphql(api_token, filtered_query, filtered_variables).await {
                Ok(data) => Ok(data),
                Err(filtered_error) => {
                    let fallback = startgg_graphql(api_token, fallback_query, base_variables).await;
                    match fallback {
                    Ok(data) => Ok(data),
                    Err(fallback_error) => Err(format!(
                        "Failed to fetch event data. Primary query error: {primary_error}. Filtered query error: {filtered_error}. Fallback query error: {fallback_error}"
                    )),
                }
                }
            }
        }
    }
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
                let parsed_event = parse_event_payload(&event_data, &event_slug)?;

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
                        let parsed_tournament =
                            parse_tournament_payload(&data, &normalized_tournament_slug)?;
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
                    Ok(data) => parse_tournament_payload(&data, &normalized_tournament_slug),
                    Err(tournament_error) => Err(format!(
                        "Failed to fetch using event slug and tournament fallback. Event error: {event_error}. Tournament error: {tournament_error}"
                    )),
                };
            }
        }
    }

    let data =
        fetch_tournament_payload(&request.api_token, &normalized_tournament_slug, per_page).await?;
    parse_tournament_payload(&data, &normalized_tournament_slug)
}

#[tauri::command]
async fn report_set_result(request: ReportSetRequest) -> Result<ReportSetResult, String> {
    if request.api_token.trim().is_empty() {
        return Err("Missing start.gg API token".to_string());
    }

    if request.set_id == 0 {
        return Err("Invalid set ID".to_string());
    }

    if request.winner_id == 0 {
        return Err("Invalid winner ID".to_string());
    }

    let attempts = [
        r#"
            mutation ReportSet($setId: ID!, $winnerId: ID!) {
              reportBracketSet(setId: $setId, winnerId: $winnerId) {
                id
                winnerId
                state
              }
            }
        "#,
        r#"
            mutation ReportSet($setId: ID!, $winnerId: ID!) {
              reportBracketSet(setId: $setId, winnerId: $winnerId)
            }
        "#,
        r#"
            mutation ReportSet($setId: ID!, $winnerId: ID!) {
              reportBracketSet(setId: $setId, winnerId: $winnerId, isDQ: false)
            }
        "#,
    ];

    let variables = json!({
        "setId": request.set_id.to_string(),
        "winnerId": request.winner_id.to_string(),
    });

    let mut failures = Vec::new();

    for mutation in attempts {
        match startgg_graphql(&request.api_token, mutation, variables.clone()).await {
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

    // Character portraits: TSH's CharacterDisplay() (include/assetUtils.js)
    // requires `player.character` to be an object keyed by arbitrary ids,
    // each with a `codename` and an `assets` map of `{ asset: "<path relative
    // to the TSH root>" }`; entries without a codename are skipped entirely.
    // The icon itself has to physically exist under the TSH out/ directory
    // (the layout loads it via a "../../" relative file path), so stage the
    // bundled PNG there the first time each character is used.
    let out_dir = path.parent().filter(|p| !p.as_os_str().is_empty());

    let character_asset = |icon: Option<&str>| -> Option<Value> {
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
    };

    // Mirrors the schema TSH's own StateManager writes to out/program_state.json
    // (score keyed by scoreboard number, team/player nesting, tournamentInfo at
    // the top level, country/state as objects). TSH's layout JS dereferences
    // `player.country.asset` and `player.state.asset` unconditionally, so those
    // must be objects (even empty ones) rather than missing or a bare string,
    // or the layout's Update() throws and the overlay stops rendering entirely.
    let player_payload = |player: &OverlayPlayer| {
        json!({
            "name": player.name,
            "characterName": player.character.clone().unwrap_or_default(),
            "character": character_asset(player.character_icon.as_deref()).unwrap_or(json!({})),
            "country": {},
            "state": {},
            "pronoun": "",
            "twitter": "",
        })
    };

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
                            "1": player_payload(&request.player1),
                        }
                    },
                    "2": {
                        "score": request.player2.score,
                        "player": {
                            "1": player_payload(&request.player2),
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

    let Ok(entries) = fs::create_dir_all(&filtered_dir).and_then(|_| fs::read_dir(source_dir)) else {
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
                            glib::Cast, PermissionRequestExt, UserMediaPermissionRequest, WebViewExt,
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
            report_set_result,
            write_stream_overlay,
            get_platform,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
