use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::error::AppError;
use crate::Result;

pub const MAX_COMMITS: usize = 10;
const TRACKED_FIELDS: &[&str] = &[
    "title",
    "username",
    "password",
    "notes",
    "urls",
    "totpSecrets",
    "customFields",
    "tags",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CustomField {
    pub id: i64,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct EntrySnapshot {
    pub title: String,
    pub username: String,
    pub password: String,
    pub notes: String,
    pub urls: Vec<String>,
    #[serde(rename = "totpSecrets")]
    pub totp_secrets: Vec<String>,
    #[serde(rename = "customFields")]
    pub custom_fields: Vec<CustomField>,
    pub tags: Vec<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryDelta {
    pub set: BTreeMap<String, Value>,
    pub unset: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryCommit {
    pub hash: String,
    pub parent: Option<String>,
    pub timestamp: String,
    pub changed: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<HistoryDelta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryObject {
    pub head: String,
    #[serde(rename = "head_snapshot")]
    pub head_snapshot: EntrySnapshot,
    pub commits: Vec<HistoryCommit>,
}

pub fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn content_hash(snapshot: &EntrySnapshot) -> Result<String> {
    let mut value = serde_json::to_value(snapshot).map_err(|_| AppError::HistoryCorrupted)?;
    if let Value::Object(map) = &mut value {
        map.remove("timestamp");
    }

    let canonical = canonicalize_json(&value);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    let hex = format!("{:x}", digest);

    Ok(hex[..12].to_string())
}

pub fn build_initial_history(mut snapshot: EntrySnapshot) -> Result<HistoryObject> {
    if snapshot.timestamp.is_empty() {
        snapshot.timestamp = now_timestamp();
    }

    let hash = content_hash(&snapshot)?;
    let commit = HistoryCommit {
        hash: hash.clone(),
        parent: None,
        timestamp: snapshot.timestamp.clone(),
        changed: changed_fields(&EntrySnapshot::default(), &snapshot),
        delta: None,
    };

    Ok(HistoryObject {
        head: hash,
        head_snapshot: snapshot,
        commits: vec![commit],
    })
}

pub fn append_snapshot(
    history: &mut HistoryObject,
    mut new_snapshot: EntrySnapshot,
) -> Result<bool> {
    if new_snapshot.timestamp.is_empty() {
        new_snapshot.timestamp = now_timestamp();
    }

    let new_hash = content_hash(&new_snapshot)?;
    if new_hash == history.head {
        return Ok(false);
    }

    let old_head_snapshot = history.head_snapshot.clone();
    let old_head_hash = history.head.clone();

    if let Some(old_head) = history.commits.first_mut() {
        old_head.delta = Some(full_delta_from_snapshot(&old_head_snapshot)?);
    }

    let commit = HistoryCommit {
        hash: new_hash.clone(),
        parent: Some(old_head_hash),
        timestamp: new_snapshot.timestamp.clone(),
        changed: changed_fields(&old_head_snapshot, &new_snapshot),
        delta: None,
    };

    history.commits.insert(0, commit);
    history.head = new_hash;
    history.head_snapshot = new_snapshot;

    enforce_commit_limit(history)?;

    Ok(true)
}

pub fn restore_to_commit(history: &mut HistoryObject, commit_hash: &str) -> Result<bool> {
    if history.head == commit_hash {
        return Ok(false);
    }

    let target = reconstruct_snapshot_at_commit(history, commit_hash)?;
    let mut restored = target;
    restored.timestamp = now_timestamp();

    append_snapshot(history, restored)
}

pub fn reconstruct_snapshot_at_commit(
    history: &HistoryObject,
    commit_hash: &str,
) -> Result<EntrySnapshot> {
    let mut current =
        serde_json::to_value(&history.head_snapshot).map_err(|_| AppError::HistoryCorrupted)?;
    let head_hash = &history.head;

    if head_hash == commit_hash {
        return serde_json::from_value(current).map_err(|_| AppError::HistoryCorrupted);
    }

    for commit in history.commits.iter().skip(1) {
        let delta = commit.delta.as_ref().ok_or(AppError::HistoryCorrupted)?;
        apply_delta_to_snapshot(&mut current, delta)?;

        if commit.hash == commit_hash {
            return serde_json::from_value(current).map_err(|_| AppError::HistoryCorrupted);
        }
    }

    Err(AppError::CommitNotFound)
}

fn enforce_commit_limit(history: &mut HistoryObject) -> Result<()> {
    while history.commits.len() > MAX_COMMITS {
        history.commits.pop();
    }

    if history.commits.len() > 1 {
        let oldest_hash = history
            .commits
            .last()
            .map(|c| c.hash.clone())
            .ok_or(AppError::HistoryCorrupted)?;

        let oldest_snapshot = reconstruct_snapshot_at_commit(history, &oldest_hash)?;
        if let Some(oldest_commit) = history.commits.last_mut() {
            oldest_commit.delta = Some(full_delta_from_snapshot(&oldest_snapshot)?);
        }
    }

    Ok(())
}

fn full_delta_from_snapshot(snapshot: &EntrySnapshot) -> Result<HistoryDelta> {
    let value = serde_json::to_value(snapshot).map_err(|_| AppError::HistoryCorrupted)?;
    let map = value.as_object().ok_or(AppError::HistoryCorrupted)?;

    let mut set = BTreeMap::new();
    let mut unset = Vec::new();

    for (k, v) in map {
        if is_empty_value(v) {
            unset.push(k.clone());
        } else {
            set.insert(k.clone(), v.clone());
        }
    }

    Ok(HistoryDelta { set, unset })
}

fn apply_delta_to_snapshot(snapshot: &mut Value, delta: &HistoryDelta) -> Result<()> {
    let map = snapshot.as_object_mut().ok_or(AppError::HistoryCorrupted)?;

    for (k, v) in &delta.set {
        map.insert(k.clone(), v.clone());
    }

    for k in &delta.unset {
        map.insert(k.clone(), default_value_for_field(k));
    }

    Ok(())
}

pub fn parse_history(bytes: &[u8]) -> Result<HistoryObject> {
    serde_json::from_slice(bytes).map_err(|_| AppError::HistoryCorrupted)
}

pub fn serialize_history(history: &HistoryObject) -> Result<Vec<u8>> {
    serde_json::to_vec(history).map_err(|_| AppError::HistoryCorrupted)
}

pub fn parse_snapshot(bytes: &[u8]) -> Result<EntrySnapshot> {
    let mut snapshot: EntrySnapshot =
        serde_json::from_slice(bytes).map_err(|_| AppError::HistoryCorrupted)?;

    if snapshot.timestamp.is_empty() {
        snapshot.timestamp = now_timestamp();
    }

    Ok(snapshot)
}

fn changed_fields(before: &EntrySnapshot, after: &EntrySnapshot) -> Vec<String> {
    let before_v = serde_json::to_value(before).unwrap_or(Value::Object(Map::new()));
    let after_v = serde_json::to_value(after).unwrap_or(Value::Object(Map::new()));

    let before_map = before_v.as_object().cloned().unwrap_or_default();
    let after_map = after_v.as_object().cloned().unwrap_or_default();

    TRACKED_FIELDS
        .iter()
        .filter_map(|field| {
            let a = before_map.get(*field).cloned().unwrap_or(Value::Null);
            let b = after_map.get(*field).cloned().unwrap_or(Value::Null);
            if normalize_for_compare(field, &a) != normalize_for_compare(field, &b) {
                Some((*field).to_string())
            } else {
                None
            }
        })
        .collect()
}

fn normalize_for_compare(field: &str, value: &Value) -> Value {
    match (field, value) {
        ("tags", Value::Array(items)) => {
            let set: BTreeSet<String> = items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_ascii_lowercase())
                .collect();
            Value::Array(set.into_iter().map(Value::String).collect())
        }
        ("urls", Value::Array(items)) => {
            let set: BTreeSet<String> = items
                .iter()
                .filter_map(|v| v.as_str())
                .map(normalize_url)
                .collect();
            Value::Array(set.into_iter().map(Value::String).collect())
        }
        ("totpSecrets", Value::Array(items)) => {
            let set: BTreeSet<String> = items
                .iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect();
            Value::Array(set.into_iter().map(Value::String).collect())
        }
        _ => value.clone(),
    }
}

fn normalize_url(url: &str) -> String {
    let lower = url.trim().to_ascii_lowercase();
    if lower.ends_with('/') {
        lower.trim_end_matches('/').to_string()
    } else {
        lower
    }
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(arr) => arr.is_empty(),
        Value::Object(obj) => obj.is_empty(),
        _ => false,
    }
}

fn default_value_for_field(field: &str) -> Value {
    match field {
        "urls" | "totpSecrets" | "customFields" | "tags" => Value::Array(Vec::new()),
        _ => Value::String(String::new()),
    }
}

fn canonicalize_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        // Delegate string serialization to serde_json so all characters
        // (backslashes, newlines, control chars, etc.) are properly escaped.
        Value::String(s) => {
            serde_json::to_string(s.as_str()).unwrap_or_else(|_| "\"\"".to_string())
        }
        Value::Array(arr) => {
            let parts: Vec<String> = arr.iter().map(canonicalize_json).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| {
                    let k_json = serde_json::to_string(k.as_str())
                        .unwrap_or_else(|_| "\"\"".to_string());
                    format!("{}:{}", k_json, canonicalize_json(&map[k]))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        append_snapshot, build_initial_history, content_hash, reconstruct_snapshot_at_commit,
        restore_to_commit, EntrySnapshot, MAX_COMMITS,
    };

    fn snapshot(password: &str) -> EntrySnapshot {
        EntrySnapshot {
            title: "mail".to_string(),
            username: "alice".to_string(),
            password: password.to_string(),
            notes: String::new(),
            urls: vec!["https://example.com/".to_string()],
            totp_secrets: vec![],
            custom_fields: vec![],
            tags: vec!["Work".to_string()],
            timestamp: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn dedup_by_content_hash_ignoring_timestamp() {
        let mut history = build_initial_history(snapshot("p1")).expect("history");

        let mut next = snapshot("p1");
        next.timestamp = "2026-01-01T10:00:00Z".to_string();

        let changed = append_snapshot(&mut history, next).expect("append");
        assert!(!changed);
        assert_eq!(history.commits.len(), 1);
    }

    #[test]
    fn reconstruct_and_restore_work() {
        let mut history = build_initial_history(snapshot("p1")).expect("history");
        let c1 = history.head.clone();

        let mut s2 = snapshot("p2");
        s2.timestamp = "2026-01-02T00:00:00Z".to_string();
        append_snapshot(&mut history, s2).expect("append");

        let restored = reconstruct_snapshot_at_commit(&history, &c1).expect("reconstruct");
        assert_eq!(restored.password, "p1");

        let changed = restore_to_commit(&mut history, &c1).expect("restore");
        assert!(changed);
        assert_eq!(history.head_snapshot.password, "p1");
    }

    #[test]
    fn commit_overflow_keeps_len_10() {
        let mut history = build_initial_history(snapshot("p0")).expect("history");

        for idx in 1..15 {
            let mut s = snapshot(&format!("p{idx}"));
            s.timestamp = format!("2026-01-{:02}T00:00:00Z", idx + 1);
            append_snapshot(&mut history, s).expect("append");
        }

        assert_eq!(history.commits.len(), MAX_COMMITS);
        assert!(history.commits.last().expect("oldest").delta.is_some());
    }

    #[test]
    fn hash_ignores_timestamp() {
        let mut a = snapshot("x");
        let mut b = snapshot("x");
        a.timestamp = "2026-01-01T00:00:00Z".to_string();
        b.timestamp = "2026-02-01T00:00:00Z".to_string();

        let ha = content_hash(&a).expect("hash");
        let hb = content_hash(&b).expect("hash");

        assert_eq!(ha, hb);
    }

    // §16.1 #11: initial commit structure
    #[test]
    fn initial_commit_has_correct_structure() {
        let s = EntrySnapshot {
            title: "Mail".to_string(),
            username: "alice".to_string(),
            password: "p1".to_string(),
            notes: String::new(),
            urls: vec![],
            totp_secrets: vec![],
            custom_fields: vec![],
            tags: vec![],
            timestamp: "2026-01-01T00:00:00Z".to_string(),
        };

        let history = build_initial_history(s).expect("history");

        assert_eq!(history.commits.len(), 1);
        let commit = &history.commits[0];

        // parent must be null
        assert!(commit.parent.is_none(), "initial commit must have no parent");
        // HEAD commit must have no delta (§8.3 rule 1)
        assert!(commit.delta.is_none(), "HEAD commit must have no delta");
        // changed must list all non-empty fields
        assert!(commit.changed.contains(&"title".to_string()));
        assert!(commit.changed.contains(&"username".to_string()));
        assert!(commit.changed.contains(&"password".to_string()));
        // notes is empty; must NOT appear in changed
        assert!(!commit.changed.contains(&"notes".to_string()));
        // head hash matches the single commit's hash
        assert_eq!(history.head, commit.hash);
    }

    // §16.1 #13: restore to HEAD is a no-op
    #[test]
    fn restore_to_head_is_noop() {
        let mut history = build_initial_history(snapshot("p1")).expect("history");
        let head_hash = history.head.clone();

        let changed = restore_to_commit(&mut history, &head_hash).expect("restore");

        assert!(!changed, "restore to HEAD must return false");
        assert_eq!(history.commits.len(), 1, "history must be unchanged");
        assert_eq!(history.head, head_hash, "head must be unchanged");
    }

    // canonicalize_json must handle backslashes and other special chars so that
    // distinct strings produce distinct hashes (no escaping collision).
    #[test]
    fn hash_distinguishes_backslash_from_no_backslash() {
        let mut with_bs = snapshot("p1");
        with_bs.title = "back\\slash".to_string();

        let mut without_bs = snapshot("p1");
        without_bs.title = "backslash".to_string();

        let h1 = content_hash(&with_bs).expect("hash1");
        let h2 = content_hash(&without_bs).expect("hash2");

        assert_ne!(h1, h2, "strings differing only by backslash must hash differently");
    }
}
