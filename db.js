/**
 * db.js — MySQL version.
 *
 * Connects to a MySQL server over the network (e.g. running on your other
 * laptop) instead of the local SQLite file. Every route in server.js only
 * ever calls the functions exported at the bottom of this file — nothing
 * else needs to change.
 *
 * Required .env values (see .env.example):
 *   DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 *
 * See the bottom of this comment block / the chat reply for how to make
 * MySQL on the other laptop reachable in the first place (remote access,
 * firewall, credentials) — that part happens on the OTHER machine, not here.
 */

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL,
      role ENUM('staff','admin') NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_email_role (email, role)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otps (
      email VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL,
      purpose VARCHAR(16) NOT NULL,
      code_hash VARCHAR(128) NOT NULL,
      expires_at BIGINT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      PRIMARY KEY (email, role, purpose)
    )
  `);
}
// Runs once when the server boots. Logs a clear error if the other
// laptop's MySQL can't be reached instead of failing silently.
init()
  .then(() => console.log("[db] Connected to MySQL and tables are ready."))
  .catch((err) => console.error("[db] Could not connect/initialize MySQL:", err.message));

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---------- Users ----------

async function getUserByEmail(email, role) {
  const [rows] = await pool.execute(
    "SELECT * FROM users WHERE email = ? AND role = ?",
    [email, role]
  );
  return rows[0] || null;
}

async function createUser({ name, email, role, passwordHash }) {
  const id = newId();
  await pool.execute(
    "INSERT INTO users (id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, email, role, passwordHash, Date.now()]
  );
  return { id, name, email, role };
}

async function updateUserPassword(email, role, passwordHash) {
  await pool.execute(
    "UPDATE users SET password_hash = ? WHERE email = ? AND role = ?",
    [passwordHash, email, role]
  );
}

// ---------- OTPs ----------

async function saveOtp({ email, role, purpose, codeHash, expiresAt }) {
  await pool.execute(
    `INSERT INTO otps (email, role, purpose, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0`,
    [email, role, purpose, codeHash, expiresAt]
  );
}

async function getOtp(email, role, purpose) {
  const [rows] = await pool.execute(
    "SELECT * FROM otps WHERE email = ? AND role = ? AND purpose = ?",
    [email, role, purpose]
  );
  return rows[0] || null;
}

async function incrementOtpAttempts(email, role, purpose) {
  await pool.execute(
    "UPDATE otps SET attempts = attempts + 1 WHERE email = ? AND role = ? AND purpose = ?",
    [email, role, purpose]
  );
}

async function clearOtp(email, role, purpose) {
  await pool.execute(
    "DELETE FROM otps WHERE email = ? AND role = ? AND purpose = ?",
    [email, role, purpose]
  );
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
