#!/usr/bin/env node
/**
 * Creates a new SecBits user and outputs the wrangler d1 execute command to insert them.
 *
 * Usage:
 *   node scripts/create-user.mjs --email user@example.com --password secret --username Alice
 *
 * Then run the printed wrangler command to insert the user into D1.
 */
import { randomBytes, pbkdf2Sync } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

function generateId() {
  const buf = randomBytes(42);
  return Array.from(buf, b => ID_CHARS[b % 62]).join('');
}

function hashPassword(password) {
  const salt = randomBytes(32);
  const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256');
  return salt.toString('base64') + ':' + hash.toString('base64');
}

const { email, password, username } = parseArgs(process.argv.slice(2));

if (!email || !password || !username) {
  console.error('Usage: node scripts/create-user.mjs --email <email> --password <password> --username <name>');
  process.exit(1);
}

const id = generateId();
const passwordHash = hashPassword(password);

console.log(`User ID:  ${id}`);
console.log(`Email:    ${email}`);
console.log(`Username: ${username}`);
console.log('');
console.log('Run this to insert the user into D1:');
console.log('');
console.log(`wrangler d1 execute secbits-db --command "INSERT INTO users (id, email, password_hash, username) VALUES ('${id}', '${email}', '${passwordHash.replace(/'/g, "''")}', '${username.replace(/'/g, "''")}')"`);
