require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const db = require("./db");
const { generateOtp, hashOtp, sendOtpEmail } = require("./otp");

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_OTP_ATTEMPTS = 5;

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

// Generous general limit, tighter one on the OTP-sending route specifically
// (that's the one someone could abuse to spam an inbox / rack up email costs).
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300 }));
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  message: { error: "Too many code requests. Wait a minute and try again." },
});

const ROLES = ["staff", "admin"];
function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}
function isValidRole(r) {
  return ROLES.includes(r);
}
function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// ---------------------------------------------------------------------------
// POST /api/auth/signup  { name, email, password, role }
// ---------------------------------------------------------------------------
app.post("/api/auth/signup", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normEmail(req.body.email);
    const password = String(req.body.password || "");
    const role = req.body.role;

    if (!name || !email || password.length < 6 || !isValidRole(role)) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }
    const existing = await db.getUserByEmail(email, role);
    if (existing) {
      return res.status(409).json({ error: `An ${role} account already exists for that email.` });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await db.createUser({ name, email, role, passwordHash });
    return res.json({ ok: true, user: { name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/login  { email, password, role }  -> password-based login
// ---------------------------------------------------------------------------
app.post("/api/auth/login", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const password = String(req.body.password || "");
    const role = req.body.role;
    if (!email || !password || !isValidRole(role)) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }
    const user = await db.getUserByEmail(email, role);
    if (!user) return res.status(401).json({ error: `No ${role} account found for that email.` });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect password." });

    const token = signToken(user);
    return res.json({ ok: true, token, user: { name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/request-otp  { email, role, purpose: "login" | "reset" }
// Sends a 6-digit code by email. Same endpoint powers both "sign in with a
// code" and "forgot password".
// ---------------------------------------------------------------------------
app.post("/api/auth/request-otp", otpLimiter, async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const role = req.body.role;
    const purpose = req.body.purpose === "login" ? "login" : "reset";
    if (!email || !isValidRole(role)) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }
    const user = await db.getUserByEmail(email, role);
    // Don't reveal account existence for login-OTP; do for reset (matches
    // the current UI's messaging). Adjust to taste.
    if (!user) {
      return res.status(404).json({ error: `No ${role} account found for that email.` });
    }

    const code = generateOtp();
    await db.saveOtp({
      email,
      role,
      purpose,
      codeHash: hashOtp(code),
      expiresAt: Date.now() + OTP_TTL_MS,
    });

    const { delivered } = await sendOtpEmail({ to: email, code, purpose });
    return res.json({ ok: true, delivered });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not send code." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-otp-login  { email, role, code }
// Verifies a login-purpose code and returns a session token (no password).
// ---------------------------------------------------------------------------
app.post("/api/auth/verify-otp-login", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const role = req.body.role;
    const code = String(req.body.code || "").trim();
    if (!email || !isValidRole(role) || !code) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }

    const record = await db.getOtp(email, role, "login");
    if (!record) return res.status(400).json({ error: "Request a new code first." });
    if (Date.now() > record.expires_at) return res.status(400).json({ error: "Code expired — request a new one." });
    if (record.attempts >= MAX_OTP_ATTEMPTS) return res.status(429).json({ error: "Too many attempts — request a new code." });
    if (hashOtp(code) !== record.code_hash) {
      await db.incrementOtpAttempts(email, role, "login");
      return res.status(401).json({ error: "Incorrect code." });
    }

    const user = await db.getUserByEmail(email, role);
    if (!user) return res.status(404).json({ error: "Account no longer exists." });

    await db.clearOtp(email, role, "login");
    const token = signToken(user);
    return res.json({ ok: true, token, user: { name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password  { email, role, code, newPassword }
// ---------------------------------------------------------------------------
app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const role = req.body.role;
    const code = String(req.body.code || "").trim();
    const newPassword = String(req.body.newPassword || "");
    if (!email || !isValidRole(role) || !code || newPassword.length < 6) {
      return res.status(400).json({ error: "Missing or invalid fields." });
    }

    const record = await db.getOtp(email, role, "reset");
    if (!record) return res.status(400).json({ error: "Request a new code first." });
    if (Date.now() > record.expires_at) return res.status(400).json({ error: "Code expired — request a new one." });
    if (record.attempts >= MAX_OTP_ATTEMPTS) return res.status(429).json({ error: "Too many attempts — request a new code." });
    if (hashOtp(code) !== record.code_hash) {
      await db.incrementOtpAttempts(email, role, "reset");
      return res.status(401).json({ error: "Incorrect code." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(email, role, passwordHash);
    await db.clearOtp(email, role, "reset");
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`StockSense auth API listening on http://localhost:${PORT}`);
});
