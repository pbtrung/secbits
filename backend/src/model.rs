use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::Result;
use crate::error::AppError;

const MAX_HISTORY_COMMITS: usize = 20;
const HASH_HEX_LEN: usize = 32;
const FIELD_TITLE: &str = "title";
const FIELD_USERNAME: &str = "username";
const FIELD_PASSWORD: &str = "password";
const FIELD_CARDHOLDER_NAME: &str = "cardholderName";
const FIELD_CARD_NUMBER: &str = "cardNumber";
const FIELD_EXPIRY: &str = "expiry";
const FIELD_CVV: &str = "cvv";
const FIELD_NOTES: &str = "notes";
const FIELD_URLS: &str = "urls";
const FIELD_TOTP_SECRETS: &str = "totpSecrets";
const FIELD_CUSTOM_FIELDS: &str = "customFields";
const FIELD_TAGS: &str = "tags";
const FIELD_TIMESTAMP: &str = "timestamp";

const SNAPSHOT_FIELDS: [&str; 11] = [
    FIELD_TITLE,
    FIELD_USERNAME,
    FIELD_PASSWORD,
    FIELD_CARDHOLDER_NAME,
    FIELD_CARD_NUMBER,
    FIELD_EXPIRY,
    FIELD_CVV,
    FIELD_NOTES,
    FIELD_URLS,
    FIELD_TOTP_SECRETS,
    FIELD_CUSTOM_FIELDS,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CustomField {
    pub id: i64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct EntrySnapshot {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default, rename = "cardholderName")]
    pub cardholder_name: String,
    #[serde(default, rename = "cardNumber")]
    pub card_number: String,
    #[serde(default)]
    pub expiry: String,
    #[serde(default)]
    pub cvv: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default, rename = "totpSecrets")]
    pub totp_secrets: Vec<String>,
    #[serde(default, rename = "customFields")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryDelta {
    pub set: serde_json::Map<String, serde_json::Value>,
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
    #[serde(rename = "type")]
    pub entry_type: String,
    pub head: String,
    #[serde(rename = "head_snapshot")]
    pub head_snapshot: EntrySnapshot,
    pub commits: Vec<HistoryCommit>,
}

impl HistoryObject {
    pub fn new(entry_type: String, snapshot: EntrySnapshot) -> Self {
        let hash = content_hash(&snapshot);
        let changed = changed_from_empty(&snapshot);
        let commit = HistoryCommit {
            hash: hash.clone(),
            parent: None,
            timestamp: snapshot.timestamp.clone(),
            changed,
            delta: None,
        };

        Self {
            entry_type,
            head: hash,
            head_snapshot: snapshot,
            commits: vec![commit],
        }
    }
}

pub fn content_hash(snapshot: &EntrySnapshot) -> String {
    let mut payload = serde_json::to_value(snapshot)
        .expect("entry snapshot must serialize")
        .as_object()
        .cloned()
        .expect("entry snapshot must serialize as object");

    payload.remove(FIELD_TIMESTAMP);

    let mut hasher = Sha256::new();
    hasher.update(
        serde_json::to_vec(&payload).expect("snapshot payload without timestamp must serialize"),
    );
    let digest = hasher.finalize();

    let mut out = String::with_capacity(HASH_HEX_LEN);
    for byte in digest.iter().take(HASH_HEX_LEN / 2) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn normalize_for_compare(snapshot: &EntrySnapshot) -> serde_json::Value {
    serde_json::json!({
        FIELD_TITLE: snapshot.title,
        FIELD_USERNAME: snapshot.username,
        FIELD_PASSWORD: snapshot.password,
        FIELD_CARDHOLDER_NAME: snapshot.cardholder_name,
        FIELD_CARD_NUMBER: snapshot.card_number,
        FIELD_EXPIRY: snapshot.expiry,
        FIELD_CVV: snapshot.cvv,
        FIELD_NOTES: snapshot.notes,
        FIELD_URLS: normalize_urls(&snapshot.urls),
        FIELD_TOTP_SECRETS: normalize_set(snapshot.totp_secrets.iter().cloned()),
        FIELD_CUSTOM_FIELDS: normalize_custom_fields(&snapshot.custom_fields),
        FIELD_TAGS: normalize_set(snapshot.tags.iter().map(|t| t.to_ascii_lowercase())),
    })
}

pub fn append_snapshot(history: &mut HistoryObject, snapshot: EntrySnapshot) -> Result<bool> {
    if history.commits.is_empty() {
        *history = HistoryObject::new(history.entry_type.clone(), snapshot);
        return Ok(true);
    }

    let new_hash = content_hash(&snapshot);
    if new_hash == history.head {
        return Ok(false);
    }

    let previous_head_hash = history.head.clone();
    let previous_head_snapshot = history.head_snapshot.clone();

    let changed = changed_fields(&snapshot, &previous_head_snapshot);

    if let Some(previous_head_commit) = history.commits.first_mut() {
        previous_head_commit.delta = Some(snapshot_to_delta(&previous_head_snapshot));
    }

    history.commits.insert(
        0,
        HistoryCommit {
            hash: new_hash.clone(),
            parent: Some(previous_head_hash),
            timestamp: snapshot.timestamp.clone(),
            changed,
            delta: None,
        },
    );

    history.head = new_hash;
    history.head_snapshot = snapshot;

    while history.commits.len() > MAX_HISTORY_COMMITS {
        history.commits.pop();
    }

    if let Some(oldest_hash) = history.commits.last().map(|c| c.hash.clone()) {
        let oldest_snapshot = reconstruct_snapshot(history, &oldest_hash)?;
        if let Some(oldest) = history.commits.last_mut() {
            oldest.parent = None;
            oldest.delta = Some(snapshot_to_delta(&oldest_snapshot));
        }
    }

    Ok(true)
}

pub fn reconstruct_snapshot(history: &HistoryObject, hash: &str) -> Result<EntrySnapshot> {
    if history.head == hash {
        return Ok(history.head_snapshot.clone());
    }

    let mut current = history.head_snapshot.clone();

    for commit in history.commits.iter().skip(1) {
        let delta = commit.delta.as_ref().ok_or_else(|| {
            AppError::Other(format!("missing delta for commit {}", commit.hash))
        })?;
        current = apply_delta(&current, delta)?;

        if commit.hash == hash {
            return Ok(current);
        }
    }

    Err(AppError::CommitNotFound)
}

pub fn restore_to_commit(history: &mut HistoryObject, hash: &str, timestamp: String) -> Result<bool> {
    if history.head == hash {
        return Ok(false);
    }

    let mut reconstructed = reconstruct_snapshot(history, hash)?;
    reconstructed.timestamp = timestamp;

    append_snapshot(history, reconstructed)
}

fn changed_from_empty(snapshot: &EntrySnapshot) -> Vec<String> {
    let empty = EntrySnapshot::default();
    changed_fields(snapshot, &empty)
}

fn changed_fields(newer: &EntrySnapshot, older: &EntrySnapshot) -> Vec<String> {
    let mut changed = Vec::new();

    if newer.title != older.title {
        changed.push(FIELD_TITLE.to_string());
    }
    if newer.username != older.username {
        changed.push(FIELD_USERNAME.to_string());
    }
    if newer.password != older.password {
        changed.push(FIELD_PASSWORD.to_string());
    }
    if newer.cardholder_name != older.cardholder_name {
        changed.push(FIELD_CARDHOLDER_NAME.to_string());
    }
    if newer.card_number != older.card_number {
        changed.push(FIELD_CARD_NUMBER.to_string());
    }
    if newer.expiry != older.expiry {
        changed.push(FIELD_EXPIRY.to_string());
    }
    if newer.cvv != older.cvv {
        changed.push(FIELD_CVV.to_string());
    }
    if newer.notes != older.notes {
        changed.push(FIELD_NOTES.to_string());
    }

    if normalize_urls(&newer.urls) != normalize_urls(&older.urls) {
        changed.push(FIELD_URLS.to_string());
    }

    if normalize_set(newer.totp_secrets.iter().cloned())
        != normalize_set(older.totp_secrets.iter().cloned())
    {
        changed.push(FIELD_TOTP_SECRETS.to_string());
    }

    if normalize_custom_fields(&newer.custom_fields) != normalize_custom_fields(&older.custom_fields) {
        changed.push(FIELD_CUSTOM_FIELDS.to_string());
    }

    if normalize_set(newer.tags.iter().map(|t| t.to_ascii_lowercase()))
        != normalize_set(older.tags.iter().map(|t| t.to_ascii_lowercase()))
    {
        changed.push(FIELD_TAGS.to_string());
    }

    changed
}

fn snapshot_to_delta(snapshot: &EntrySnapshot) -> HistoryDelta {
    let json = serde_json::to_value(snapshot)
        .expect("entry snapshot must serialize")
        .as_object()
        .cloned()
        .expect("entry snapshot must serialize as object");

    let mut set = serde_json::Map::new();
    let mut unset = Vec::new();

    for field in SNAPSHOT_FIELDS {
        let value = json
            .get(field)
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Null);

        if is_empty_value(&value) {
            unset.push(field.to_string());
        } else {
            set.insert(field.to_string(), value);
        }
    }

    if is_empty_value(json.get(FIELD_TAGS).unwrap_or(&serde_json::Value::Null)) {
        unset.push(FIELD_TAGS.to_string());
    } else if let Some(value) = json.get(FIELD_TAGS) {
        set.insert(FIELD_TAGS.to_string(), value.clone());
    }

    HistoryDelta { set, unset }
}

fn apply_delta(snapshot: &EntrySnapshot, delta: &HistoryDelta) -> Result<EntrySnapshot> {
    let mut object = serde_json::to_value(snapshot)
        .expect("entry snapshot must serialize")
        .as_object()
        .cloned()
        .expect("entry snapshot must serialize as object");

    for field in &delta.unset {
        object.remove(field);
    }

    for (field, value) in &delta.set {
        object.insert(field.clone(), value.clone());
    }

    let restored: EntrySnapshot =
        serde_json::from_value(serde_json::Value::Object(object)).map_err(|err| {
            AppError::Other(format!("failed to decode reconstructed snapshot: {err}"))
        })?;

    Ok(restored)
}

fn is_empty_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => true,
        serde_json::Value::String(s) => s.is_empty(),
        serde_json::Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn normalize_urls(urls: &[String]) -> Vec<String> {
    let set = normalize_set(urls.iter().map(|url| {
        let lowered = url.to_ascii_lowercase();
        lowered.trim_end_matches('/').to_string()
    }));
    set.into_iter().collect()
}

fn normalize_set<I>(items: I) -> BTreeSet<String>
where
    I: IntoIterator<Item = String>,
{
    items.into_iter().collect()
}

fn normalize_custom_fields(fields: &[CustomField]) -> BTreeMap<i64, (String, String)> {
    let mut out = BTreeMap::new();
    for field in fields {
        out.insert(field.id, (field.label.clone(), field.value.clone()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        CustomField, EntrySnapshot, HistoryObject, append_snapshot, content_hash, normalize_for_compare,
        reconstruct_snapshot, restore_to_commit,
    };

    fn login_snapshot(title: &str, username: &str, password: &str, timestamp: &str) -> EntrySnapshot {
        EntrySnapshot {
            title: title.to_string(),
            username: username.to_string(),
            password: password.to_string(),
            urls: vec!["https://example.com/".to_string()],
            tags: vec!["Work".to_string()],
            timestamp: timestamp.to_string(),
            ..EntrySnapshot::default()
        }
    }

    #[test]
    fn content_hash_is_timestamp_independent() {
        let a = login_snapshot("Gmail", "alice", "one", "2026-02-28T10:00:00Z");
        let b = login_snapshot("Gmail", "alice", "one", "2026-02-28T10:05:00Z");

        let hash_a = content_hash(&a);
        let hash_b = content_hash(&b);

        assert_eq!(hash_a, hash_b);
        assert_eq!(hash_a.len(), 32);
    }

    #[test]
    fn normalize_for_compare_applies_semantic_rules() {
        let mut a = login_snapshot("Gmail", "alice", "pw", "2026-02-28T10:00:00Z");
        a.urls = vec!["HTTPS://Example.com/".to_string()];
        a.tags = vec!["Work".to_string(), "Personal".to_string()];
        a.totp_secrets = vec!["B".to_string(), "A".to_string()];
        a.custom_fields = vec![
            CustomField {
                id: 2,
                label: "k2".to_string(),
                value: "v2".to_string(),
            },
            CustomField {
                id: 1,
                label: "k1".to_string(),
                value: "v1".to_string(),
            },
        ];

        let mut b = login_snapshot("Gmail", "alice", "pw", "2026-02-28T11:00:00Z");
        b.urls = vec!["https://example.com".to_string()];
        b.tags = vec!["personal".to_string(), "work".to_string()];
        b.totp_secrets = vec!["A".to_string(), "B".to_string()];
        b.custom_fields = vec![
            CustomField {
                id: 1,
                label: "k1".to_string(),
                value: "v1".to_string(),
            },
            CustomField {
                id: 2,
                label: "k2".to_string(),
                value: "v2".to_string(),
            },
        ];

        assert_eq!(normalize_for_compare(&a), normalize_for_compare(&b));
    }

    #[test]
    fn append_dedup_reconstruct_restore_and_overflow() {
        let first = login_snapshot("Gmail", "alice", "one", "2026-02-28T10:00:00Z");
        let mut history = HistoryObject::new("login".to_string(), first.clone());

        let mut dedup = first.clone();
        dedup.timestamp = "2026-02-28T10:00:01Z".to_string();
        assert!(!append_snapshot(&mut history, dedup).expect("append dedup"));
        assert_eq!(history.commits.len(), 1);

        let second = login_snapshot("Gmail", "alice", "two", "2026-02-28T10:01:00Z");
        assert!(append_snapshot(&mut history, second.clone()).expect("append second"));
        assert_eq!(history.commits.len(), 2);
        assert_eq!(history.commits[0].parent.as_deref(), Some(history.commits[1].hash.as_str()));
        assert!(history.commits[1].delta.is_some());

        let first_hash = history.commits[1].hash.clone();
        let reconstructed = reconstruct_snapshot(&history, &first_hash).expect("reconstruct oldest");
        assert_eq!(reconstructed.password, "one");

        let second_hash = history.head.clone();
        assert!(!restore_to_commit(&mut history, &second_hash, "2026-02-28T10:01:10Z".to_string())
            .expect("restore head no-op"));

        assert!(restore_to_commit(&mut history, &first_hash, "2026-02-28T10:02:00Z".to_string())
            .expect("restore to first"));
        assert_eq!(history.head_snapshot.password, "one");

        for idx in 0..25 {
            let snap = login_snapshot(
                "Gmail",
                "alice",
                &format!("pw-{idx}"),
                &format!("2026-02-28T10:{:02}:00Z", (idx % 59) + 1),
            );
            append_snapshot(&mut history, snap).expect("append overflow");
        }

        assert_eq!(history.commits.len(), 20);
        let oldest = history.commits.last().expect("oldest");
        assert!(oldest.parent.is_none());
        assert!(oldest.delta.is_some());
    }
}
