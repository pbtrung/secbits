use serde::{Deserialize, Serialize};

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
    #[serde(rename = "cardholderName")]
    pub cardholder_name: String,
    #[serde(rename = "cardNumber")]
    pub card_number: String,
    pub expiry: String,
    pub cvv: String,
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
