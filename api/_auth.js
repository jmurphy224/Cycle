// api/_auth.js
// Sign-in sessions and password hashing, shared by every /api route. Files
// starting with "_" are not exposed as routes by Vercel, so this is only
// importable, never callable.
//
// Sessions are signed tokens (HMAC-SHA256) the browser keeps and sends as
// "Authorization: Bearer <token>". The signing key is derived from
// SUPABASE_SERVICE_KEY, which is already a server-only secret — so there is no
// extra env var to set, and rotating that key signs everyone out.
//
// Passwords are stored as scrypt hashes in the app_users table, never as text.

import { createHash, createHmac, pbkdf2 as pbkdf2Cb, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const pbkdf2 = promisify(pbkdf2Cb);
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SECRET = SERVICE_KEY ? createHash("sha256").update("cycle-session:" + SERVICE_KEY).digest() : null;
const SESSION_MS = 180 * 24 * 60 * 60 * 1000; // stay signed in ~6 months per device

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload) => createHmac("sha256", SECRET).update(payload).digest();

export function createSession(user) {
  const payload = b64u(JSON.stringify({ u: user.id, n: user.username, e: Date.now() + SESSION_MS }));
  return `${payload}.${b64u(sign(payload))}`;
}

function readSession(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m || !SECRET) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const want = sign(payload);
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let d;
  try {
    d = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!d.u || !(d.e > Date.now())) return null;
  return { id: d.u, username: d.n };
}

// Returns {id, username} when the request carries a valid session; otherwise
// writes a 401 (tagged so the app knows to show the sign-in screen) and
// returns null.
export function requireUser(req, res) {
  if (!SECRET) {
    res.status(503).json({ error: "Server not configured (missing SUPABASE_SERVICE_KEY)" });
    return null;
  }
  const user = readSession(req);
  if (!user) {
    res.setHeader("x-auth", "session");
    res.status(401).json({ error: "Please sign in" });
    return null;
  }
  return user;
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// Also accepts "pbkdf2$<iterations>$<salt>$<hash>" (PBKDF2-SHA256), the format
// used for accounts created by hand outside the app. Changing the password
// in the app re-saves it as scrypt.
export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts[0] === "scrypt" && parts.length === 6) {
    const [, N, r, p, salt, hash] = parts;
    const want = Buffer.from(hash, "base64");
    const got = await scrypt(password, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
    return timingSafeEqual(got, want);
  }
  if (parts[0] === "pbkdf2" && parts.length === 4) {
    const [, iterations, salt, hash] = parts;
    const want = Buffer.from(hash, "base64");
    const got = await pbkdf2(password, Buffer.from(salt, "base64"), +iterations, want.length, "sha256");
    return timingSafeEqual(got, want);
  }
  return false;
}
