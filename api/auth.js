// api/auth.js
// Username + password sign-in for family members, plus per-person settings.
//
// POST {action:"login", username, password}   -> {token, user}
// POST {action:"me"}                          -> {user}              (signed in)
// POST {action:"settings", settings}          -> {user}              (signed in)
// POST {action:"password", current, next}     -> {ok:true}           (signed in)
//
// There is no sign-up: accounts are added to the app_users table by the owner.

import { createSession, hashPassword, requireUser, verifyPassword } from "./_auth.js";
import { db, dbConfigured } from "./_db.js";

const MAX_TRIES = 10;
const LOCK_MINUTES = 15;
// Only these settings keys may be saved from the browser.
const SETTINGS_KEYS = ["goals", "showShots", "gymNotes"];

// Compared against when the username doesn't exist, so a wrong username takes
// as long as a wrong password and doesn't reveal which usernames are real.
let dummyHash = null;

const publicUser = (u) => ({ username: u.username, settings: u.settings || {} });
const byId = (id) => `app_users?id=eq.${encodeURIComponent(id)}`;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!dbConfigured) return res.status(500).json({ error: "Server not configured (missing env vars)" });
  const { action } = req.body || {};

  try {
    if (action === "login") {
      const username = String(req.body.username || "").trim().toLowerCase();
      const password = String(req.body.password || "");
      if (!username || !password) return res.status(400).json({ error: "Enter your username and password." });

      const found = await db(`app_users?username=eq.${encodeURIComponent(username)}&select=*`);
      if (!found.ok) return res.status(502).json({ error: "Couldn't reach the database." });
      const user = found.data?.[0];
      if (!user) {
        dummyHash ||= await hashPassword("not-a-real-password");
        await verifyPassword(password, dummyHash);
        return res.status(401).json({ error: "Wrong username or password." });
      }
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        return res.status(429).json({ error: `Too many wrong tries. Wait ${LOCK_MINUTES} minutes and try again.` });
      }
      if (!(await verifyPassword(password, user.password_hash))) {
        const tries = (user.failed_attempts || 0) + 1;
        const lock = tries >= MAX_TRIES;
        await db(byId(user.id), {
          method: "PATCH",
          body: {
            failed_attempts: lock ? 0 : tries,
            locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
          },
        });
        return res.status(401).json({ error: "Wrong username or password." });
      }
      if (user.failed_attempts || user.locked_until) {
        await db(byId(user.id), { method: "PATCH", body: { failed_attempts: 0, locked_until: null } });
      }
      return res.status(200).json({ token: createSession(user), user: publicUser(user) });
    }

    const me = requireUser(req, res);
    if (!me) return;
    const found = await db(`${byId(me.id)}&select=*`);
    const user = found.data?.[0];
    if (!user) {
      // Account was removed — treat as signed out.
      res.setHeader("x-auth", "session");
      return res.status(401).json({ error: "Please sign in" });
    }

    if (action === "me") return res.status(200).json({ user: publicUser(user) });

    if (action === "settings") {
      const patch = {};
      for (const k of SETTINGS_KEYS) if (req.body.settings?.[k] !== undefined) patch[k] = req.body.settings[k];
      if (patch.gymNotes !== undefined) patch.gymNotes = String(patch.gymNotes).slice(0, 300);
      const settings = { ...(user.settings || {}), ...patch };
      const r = await db(byId(me.id), { method: "PATCH", body: { settings }, prefer: "return=representation" });
      if (!r.ok) return res.status(502).json({ error: "Couldn't save settings." });
      return res.status(200).json({ user: publicUser(r.data[0]) });
    }

    if (action === "password") {
      const next = String(req.body.next || "");
      if (!(await verifyPassword(String(req.body.current || ""), user.password_hash))) {
        return res.status(400).json({ error: "Your current password isn't right." });
      }
      if (next.length < 8) return res.status(400).json({ error: "Use at least 8 characters for the new password." });
      await db(byId(me.id), { method: "PATCH", body: { password_hash: await hashPassword(next) } });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
