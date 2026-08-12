/**
 * Durable webhook de-duplication.
 *
 * Meta retries webhook deliveries for hours if it doesn't get a 200 (and
 * sometimes even when it does). The in-memory Map this replaces was emptied on
 * every restart, so a redeploy inside Meta's retry window could re-process a
 * message the bot had already handled — creating a DUPLICATE repair ticket
 * with a fresh ticket ID, which is confusing for the customer and dirties the
 * sheet.
 *
 * Storage is a small JSON file (the same shape the old snapshot/last-contact
 * caches used) rather than anything heavier: this is one boolean per message
 * id for ~10 minutes, and a Sheets round-trip per inbound message would be far
 * more expensive than the problem it solves.
 *
 * Writes are debounced — an fsync per inbound message is unnecessary when the
 * worst case for losing the last second of state is exactly the duplicate we
 * were already tolerating before.
 *
 * NOTE: single-process only, like the rest of the bot (see utils/ticketId.js).
 * Horizontal scaling would need Redis SETNX instead.
 */

const fs = require('fs');
const path = require('path');
const { envInt } = require('./env');

/**
 * How long a message id is remembered.
 *
 * Meta retries an undelivered webhook with exponential backoff for up to
 * SEVEN DAYS before discarding it, so the dedup window has to span that
 * whole period to actually do its job. A short window (this was originally
 * 30 minutes) only covers a quick restart: a crash followed by Meta's retry
 * hours or days later would find the id expired and create a SECOND repair
 * ticket for the same request — the exact bug this store exists to prevent.
 *
 * 7 days of ids is cheap at this volume: a few hundred messages a day is
 * low thousands of entries at ~70 bytes each, i.e. a file well under a
 * megabyte.
 */
const TTL_MS = envInt('DEDUP_TTL_MINUTES', 7 * 24 * 60, { min: 1 }) * 60 * 1000;

/**
 * Hard ceiling on remembered ids, as a backstop against unbounded growth if
 * volume ever spikes. Sized to hold ~7 days of traffic for this shop with
 * generous headroom; eviction is oldest-first (those are nearest expiry
 * anyway) and is logged, because silently forgetting ids would quietly
 * re-open the duplicate-ticket window.
 */
const MAX_ENTRIES = envInt('DEDUP_MAX_ENTRIES', 20000, { min: 100 });
const FLUSH_DEBOUNCE_MS = 2000;

function resolvePath() {
  const explicit = process.env.DEDUP_CACHE_PATH?.trim();
  if (explicit) return explicit;
  return path.join(process.cwd(), 'data', 'processed_messages.json');
}

/** @type {Map<string, number>|null} messageId -> epoch ms first seen */
let cache = null;
let flushTimer = null;

function load() {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      const cutoff = Date.now() - TTL_MS;
      for (const [id, ts] of Object.entries(raw)) {
        if (Number.isFinite(ts) && ts >= cutoff) cache.set(id, ts);
      }
      console.log(`[DEDUP] Restored ${cache.size} recent message id(s) from disk.`);
    }
  } catch {
    // Missing/corrupt file is fine — we simply start with an empty window.
  }
  return cache;
}

function flushNow() {
  try {
    const fp = resolvePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(Object.fromEntries(cache ?? [])), 'utf8');
  } catch (e) {
    // Non-fatal: we degrade to in-memory-only dedup until the disk recovers.
    console.warn('[DEDUP] persist failed (in-memory dedup still active):', e.message);
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushNow(); }, FLUSH_DEBOUNCE_MS);
  flushTimer.unref?.();
}

function prune(now = Date.now()) {
  const c = load();
  const cutoff = now - TTL_MS;
  for (const [id, ts] of c) if (ts < cutoff) c.delete(id);

  // Hard cap in case of a burst before the TTL sweep catches up. Evicting
  // early shortens the effective dedup window, so say so loudly rather than
  // silently re-opening the duplicate-ticket risk.
  if (c.size > MAX_ENTRIES) {
    const over = c.size - MAX_ENTRIES;
    while (c.size > MAX_ENTRIES) c.delete(c.keys().next().value);
    console.warn(
      `[DEDUP] Evicted ${over} id(s) early to stay under DEDUP_MAX_ENTRIES=${MAX_ENTRIES}. `
      + `The effective dedup window is now shorter than DEDUP_TTL_MINUTES — raise the cap `
      + `if message volume has grown.`,
    );
  }
}

/**
 * Atomically claim a message id.
 * @returns {boolean} true if this is the FIRST time we've seen it (caller
 *   should process it); false if it's a duplicate (caller should skip).
 */
function claimMessage(messageId) {
  const id = String(messageId ?? '').trim();
  if (!id) return true; // nothing to dedup on — let the caller decide
  const c = load();
  const now = Date.now();
  if (c.has(id)) return false;
  c.set(id, now);
  if (c.size > MAX_ENTRIES) prune(now);
  scheduleFlush();
  return true;
}

// Periodic sweep so a quiet bot doesn't hold ids forever.
setInterval(() => { prune(); scheduleFlush(); }, 5 * 60 * 1000).unref();

module.exports = { claimMessage, _flushNow: flushNow };
