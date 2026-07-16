// In-memory session store. Each phone number has a session object.
// Sessions expire after 2 hours of inactivity.

const sessions = new Map();
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const REMINDER_TIMEOUT_MS = 30 * 60 * 1000;     // 30 minutes

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
}

function clearSession(phone) {
  const lang = sessions.get(phone)?.language;
  const newSession = createEmptySession(phone);
  if (lang) newSession.language = lang;
  sessions.set(phone, newSession);
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

module.exports = { getSession, updateSession, clearSession };
