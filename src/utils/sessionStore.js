/**
 * Session store — in memory, backed by disk.
 *
 * Each phone number has a session object holding the language, the active
 * flow, and whatever the customer has answered so far. Sessions expire after
 * 2 hours of inactivity.
 *
 * WHY IT PERSISTS: this used to be a bare Map. Every restart — and on a host
 * with auto-deploy that means every push — silently destroyed every
 * conversation in flight. Someone three questions into a booking lost the lot
 * and got no explanation, they just found the bot had forgotten them. Writing
 * the map to disk (debounced, same pattern as utils/dedupStore.js) makes a
 * redeploy invisible to anyone mid-flow.
 *
 * Expired sessions are dropped on load, so a long outage doesn't resurrect
 * stale half-finished flows.
 */

const fs = require('fs');
const path = require('path');
const { statePath } = require('./dataDir');

const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const REMINDER_TIMEOUT_MS = 30 * 60 * 1000;     // 30 minutes
const FLUSH_DEBOUNCE_MS = 1000;

function resolvePath() {
  return statePath('sessions');
}

/** @type {Map<string, object>} */
const sessions = loadSessions();
let flushTimer = null;

function loadSessions() {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
    const cutoff = Date.now() - SESSION_TIMEOUT_MS;
    let restored = 0, dropped = 0;
    for (const [phone, s] of Object.entries(raw || {})) {
      // Drop anything already past its idle timeout rather than reviving it.
      if (!s || (s.lastActivity && s.lastActivity < cutoff)) { dropped++; continue; }
      map.set(phone, s);
      restored++;
    }
    if (restored || dropped) {
      console.log(`[SESSIONS] Restored ${restored} live session(s) from disk (${dropped} expired, discarded).`);
    }
  } catch {
    // No file / unreadable — start empty. Not an error on a fresh install.
  }
  return map;
}

function flushNow() {
  try {
    const fp = resolvePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(Object.fromEntries(sessions)), 'utf8');
  } catch (e) {
    // Non-fatal: sessions keep working in memory, they just won't survive a
    // restart until the disk recovers.
    console.warn('[SESSIONS] persist failed (in-memory sessions still active):', e.message);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

// Best-effort save on shutdown so an intentional redeploy loses nothing at all.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { flushNow(); } catch { /* shutting down anyway */ } });
}

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, createEmptySession(phone));
  }
  const session = sessions.get(phone);

  // Check if session timed out
  const idleMs = Date.now() - (session.lastActivity || 0);
  if (session.lastActivity && idleMs > SESSION_TIMEOUT_MS) {
    // Reset everything except language preference
    const lang = session.language;
    const newSession = createEmptySession(phone);
    newSession.language = lang;
    sessions.set(phone, newSession);
    return newSession;
  }

  return session;
}

function updateSession(phone, updates) {
  const session = getSession(phone);
  Object.assign(session, updates);
  sessions.set(phone, session);
  scheduleFlush();
}

/**
 * Reset the flow, keeping the two things that are properties of the PERSON
 * rather than of the flow they just finished: their language, and the fact
 * that we have already greeted them.
 *
 * `greeted` used to be dropped here, so every flow completion re-armed the
 * full "Hey ya! 👋 Welcome to Chanakya – The Bag Studio, Vadodara's #1 Bag
 * Store since 1996…" block. Someone who had just booked a repair and then
 * typed something unrecognised got greeted like a stranger.
 */
function clearSession(phone) {
  const prev = sessions.get(phone);
  const newSession = createEmptySession(phone);
  if (prev?.language) newSession.language = prev.language;
  if (prev?.greeted) newSession.greeted = true;
  sessions.set(phone, newSession);
  scheduleFlush();
}

function createEmptySession(phone) {
  return {
    phone,
    language: null,        // 'english' | 'hindi' | 'gujarati'
    currentFlow: null,     // which flow is active
    flowStep: null,        // step within that flow
    reminderSent: false,   // whether 30-min reminder was sent
    collectedData: {},     // data gathered during a flow
    lastActivity: null,    // unix timestamp
    fallbackCount: 0,      // consecutive fallback triggers
    greeted: false,        // full welcome block already shown this session
    needsLanguagePick: false, // first contact, still owed a language choice
    languagePickAsked: 0,  // how many times the picker has gone unanswered
  };
}

// Clean up very old sessions every hour. .unref() so the timer doesn't
// block graceful shutdown (SIGTERM handler in src/index.js).
setInterval(() => {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS * 2;
  for (const [phone, session] of sessions) {
    if (session.lastActivity && session.lastActivity < cutoff) {
      sessions.delete(phone);
    }
  }
  scheduleFlush();
}, 60 * 60 * 1000).unref();

// Check for 30-min reminder every 5 minutes
const { sendTextMessage } = require('../services/whatsapp');
const M = require('../messages/index');

setInterval(() => {
  const now = Date.now();
  for (const [phone, session] of sessions) {
    if (
      session.currentFlow &&
      session.currentFlow !== 'paused' && // don't nag paused sessions
      !session.reminderSent &&
      session.lastActivity &&
      (now - session.lastActivity) > REMINDER_TIMEOUT_MS
    ) {
      const lang = session.language || 'english';
      sendTextMessage(phone, M.get('flow_reminder', lang)).catch((e) => {
        console.warn('[REMINDER] Failed to send flow_reminder:', e.message);
      });
      updateSession(phone, { reminderSent: true });
    }
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  getSession, updateSession, clearSession,
  /** Force the debounced write to disk immediately (shutdown, tests). */
  _flushNow: flushNow,
};
