/**
 * otp.js — generates OTP codes and emails them.
 *
 * Email provider: Resend (https://resend.com)
 *   - Free tier: 3,000 emails/month, 100/day — plenty for a hackathon demo.
 *   - No SMTP setup, just one API key and a plain fetch() call (see below).
 *   - Sign up -> verify a sender domain (or use their shared test domain
 *     while developing) -> create an API key -> put it in .env as RESEND_API_KEY.
 *
 * Swapping providers later: only sendOtpEmail() below needs to change.
 *   - SendGrid: POST https://api.sendgrid.com/v3/mail/send
 *   - AWS SES:  use the aws-sdk SES client
 *   - SMS instead of email: use Twilio Verify (https://www.twilio.com/docs/verify)
 *     which manages OTP generation/expiry/attempts FOR you server-side —
 *     you'd call their API instead of generateOtp()/verify below.
 */

const crypto = require("crypto");

function generateOtp() {
  // 6-digit numeric code, crypto-random (not Math.random)
  return String(crypto.randomInt(100000, 1000000));
}

function hashOtp(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

async function sendOtpEmail({ to, code, purpose }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "StockSense <onboarding@resend.dev>";

  const subject =
    purpose === "login" ? "Your StockSense sign-in code" : "Your StockSense password reset code";

  const html = `
    <div style="font-family:sans-serif;max-width:420px;margin:auto">
      <h2 style="margin-bottom:4px">StockSense</h2>
      <p>${purpose === "login" ? "Use this code to sign in:" : "Use this code to reset your password:"}</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:4px">${code}</p>
      <p style="color:#666;font-size:13px">This code expires in 5 minutes. If you didn't request this, ignore this email.</p>
    </div>`;

  if (!apiKey) {
    // No key configured yet — don't crash the demo, just log it so you can
    // still test the flow locally. Set RESEND_API_KEY in .env to send real emails.
    console.warn(`[otp] RESEND_API_KEY not set — would have emailed ${to}: ${code}`);
    return { delivered: false };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errText}`);
  }
  return { delivered: true };
}

module.exports = { generateOtp, hashOtp, sendOtpEmail };
