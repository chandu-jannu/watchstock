/**
 * db.js — the ONLY file that talks to storage.
 *
 * Every route in server.js calls the functions exported here — none of them
 * touch SQL directly. That means when you're ready to move to your real
 * database (Postgres, MySQL, MongoDB, Supabase, whatever), you only ever
 * edit THIS file. The function names and shapes below are the "contract" —
 * keep them the same and server.js needs zero changes.
 *
 * Ships with SQLite via Node's own built-in node:sqlite module (Node 22+)
 * so it runs immediately with no setup and nothing to compile — one local
 * file, stocksense.db, created next to this file.
 *
 * ---- Swapping to Postgres later (example) ----
 * npm install pg
 * const { Pool } = require("pg");
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * Then rewrite each exported function below to run the equivalent SQL
 * against `pool` instead of `sqlite`. The rest of the app doesn't change.
 */

const path = require("path");
const { DatabaseSync } = require("node:sqlite"); // built into Node 22+, nothing to install

const sqlite = new DatabaseSync(path.join(__dirname, "stocksense.db"));

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('staff','admin')),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(email, role)
  );

  CREATE TABLE IF NOT EXISTS otps (
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('login','reset')),
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (email, role, purpose)
  );
`);

function newId() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  );
}

// ---------- Users ----------

async function getUserByEmail(email, role) {
  const row = sqlite
    .prepare("SELECT * FROM users WHERE email = ? AND role = ?")
    .get(email, role);
  return row || null;
}

async function createUser({ name, email, role, passwordHash }) {
  const id = newId();
  sqlite
    .prepare(
      "INSERT INTO users (id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, name, email, role, passwordHash, Date.now());
  return { id, name, email, role };
}

async function updateUserPassword(email, role, passwordHash) {
  sqlite
    .prepare(
      "UPDATE users SET password_hash = ? WHERE email = ? AND role = ?"
    )
    .run(passwordHash, email, role);
}

// ---------- OTPs ----------
// purpose: "login" (passwordless sign-in) or "reset" (forgot password)

async function saveOtp({ email, role, purpose, codeHash, expiresAt }) {
  sqlite
    .prepare(
      `INSERT INTO otps (email, role, purpose, code_hash, expires_at, attempts)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(email, role, purpose)
       DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`
    )
    .run(email, role, purpose, codeHash, expiresAt);
}

async function getOtp(email, role, purpose) {
  const row = sqlite
    .prepare(
      "SELECT * FROM otps WHERE email = ? AND role = ? AND purpose = ?"
    )
    .get(email, role, purpose);
  return row || null;
}

async function incrementOtpAttempts(email, role, purpose) {
  sqlite
    .prepare(
      "UPDATE otps SET attempts = attempts + 1 WHERE email = ? AND role = ? AND purpose = ?"
    )
    .run(email, role, purpose);
}

async function clearOtp(email, role, purpose) {
  sqlite
    .prepare("DELETE FROM otps WHERE email = ? AND role = ? AND purpose = ?")
    .run(email, role, purpose);
}

module.exports = {
  getUserByEmail,
  createUser,
  updateUserPassword,
  saveOtp,
  getOtp,
  incrementOtpAttempts,
  clearOtp,
};
