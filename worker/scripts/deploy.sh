#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler not found. Install with: npm install -g wrangler" >&2
  exit 1
fi

echo "Set required Worker secrets (if not already set):"
echo "  wrangler secret put FIREBASE_PROJECT_ID"
echo "  wrangler secret put RQLITE_URL"
echo "  wrangler secret put RQLITE_USERNAME"
echo "  wrangler secret put RQLITE_PASSWORD"
echo

echo "Ensure rqlite schema is applied using worker/schema.sql before deploy."

echo "Deploying worker..."
wrangler deploy
