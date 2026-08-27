/**
 * Disk-backed per-phone throttles.
 *
 * Ticket / corporate-lead / handoff-alert / track-lookup budgets used to live
 * in module-level Maps. A redeploy reset them, so a spammer who waited for a
 * push got a free window. Same persistence pattern as utils/dedupStore.js.
 *
 * Values are JSON (a timestamp number, or a small object). Entries older than
 * 48h are dropped on load and on write so the file cannot grow without bound.
 *
 * Single-process only, like the rest of the bot.
 */

const fs = require('fs');
const path = require('path');

const FLUSH_DEBOUNCE_MS = 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

function resolvePath() {
  const explicit = process.env.THROTTLE_CACHE_PATH?.trim();
  if (explicit) return explicit;
  return path.join(process.cwd(), 'data', 'throttles.json');
}

function key(kind, phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return `${kind}:${digits || 'unknown'}`;
}

/** @type {Record<string, unknown>|null} */
let cache = null;
let flushTimer = null;

function isFresh(value, now) {
  if (value == null) return false;
  if (typeof value === 'number') return now - value < MAX_AGE_MS;
  if (typeof value === 'object') {
    const ts = Number(value.at || value.resetAt || value.ts || 0);
    return ts > 0 && now - ts < MAX_AGE_MS;
  }
  return false;
}

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) {
        if (isFresh(v, now)) cache[k] = v;
      }
    }
  } catch {
    // Missing/unreadable — start empty. Not an error on a fresh install.
  }
  return cache;
}

function flushNow() {
  try {
    const fp = resolvePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(load())) {
      if (isFresh(v, now)) out[k] = v;
    }
    cache = out;
    fs.writeFileSync(fp, JSON.stringify(out), 'utf8');
  } catch (e) {
    console.warn('[THROTTLE] persist failed (in-memory throttles still active):', e.message);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

function getRecord(kind, phone) {
  return load()[key(kind, phone)];
}

function setRecord(kind, phone, value) {
  load()[key(kind, phone)] = value;
  scheduleFlush();
}

function getTimestamp(kind, phone) {
  const v = getRecord(kind, phone);
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') return Number(v.at || v.ts || 0);
  return 0;
}

function setTimestamp(kind, phone, ts = Date.now()) {
  setRecord(kind, phone, ts);
}

module.exports = {
  getRecord, setRecord,
  getTimestamp, setTimestamp,
  /** Tests / shutdown. */
  _flushNow: flushNow,
};
