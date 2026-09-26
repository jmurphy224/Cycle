// api/_auth.js
// Shared passcode gate for every /api route. Files starting with "_" are not
// exposed as routes by Vercel, so this is only importable, never callable.
//
// Env var to set in Vercel (Project -> Settings -> Environment Variables):
//   APP_PASSCODE -> any phrase you choose; you type it once per device.
//
// Without APP_PASSCODE set, every route refuses requests. That's deliberate:
// these routes spend your Anthropic credits and read/delete your food log, so
// they must never be open to anyone who finds the URL.

import { timingSafeEqual, createHash } from "node:crypto";

const PASSCODE = process.env.APP_PASSCODE;

// Hash both sides so timingSafeEqual always compares equal-length buffers.
const digest = (s) => createHash("sha256").update(String(s)).digest();

// Returns true when the request may proceed; otherwise writes the error
// response and returns false.
export function requireAuth(req, res) {
  if (!PASSCODE) {
    res.status(503).json({ error: "Server passcode not configured — set APP_PASSCODE in Vercel." });
    return false;
  }
  const given = req.headers["x-app-key"];
  if (!given || !timingSafeEqual(digest(given), digest(PASSCODE))) {
    res.setHeader("x-auth", "passcode");
    res.status(401).json({ error: "Wrong or missing passcode" });
    return false;
  }
  return true;
}
