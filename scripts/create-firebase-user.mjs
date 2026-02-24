#!/usr/bin/env node

/**
 * Create a Firebase Auth email/password user via REST API.
 *
 * Usage:
 *   node scripts/create-firebase-user.mjs --api-key <key> --email user@example.com --password secret
 */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

const { 'api-key': apiKey, email, password } = parseArgs(process.argv.slice(2));

if (!apiKey || !email || !password) {
  console.error('Usage: node scripts/create-firebase-user.mjs --api-key <key> --email <email> --password <password>');
  process.exit(1);
}

const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`;

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email,
    password,
    returnSecureToken: false,
  }),
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(data?.error?.message || 'Failed to create Firebase user');
  process.exit(1);
}

console.log(`Created Firebase user: ${data.localId}`);
console.log(`Email: ${data.email}`);
