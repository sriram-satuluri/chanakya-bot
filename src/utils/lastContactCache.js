/**
 * Tracks when each customer last messaged US (inbound via webhook), persisted
 * to a small JSON file so the status poller can tell whether a phone's 24-hour
 * WhatsApp service window is still open (free free-form push) or closed (paid
 * template territory). Same persistence model as repairStatusSnapshotCache —
 * lives under data/ (attach a volume in production, see LAUNCH_CHECKLIST.md).
 *
 * Fail-safe by design: if the file is missing or an entry is absent (fresh
 * deploy, no volume, pre-existing ticket), the phone is treated as
 * window-CLOSED. That fails CHEAP — we skip a free push — never expensive.
 */

const fs = require('fs');
const path = require('path');

/** Entries older than this are useless for window checks — prune them. */
const PRUNE_AFTER_MS = 48 * 3600 * 1000;
/** Prune whenever the map grows past this many phones. */
const PRUNE_AT_SIZE = 5000;

function resolvePath() {
  const explicit = process.env.LAST_CONTACT_CACHE_PATH?.trim();
  if (explicit) return explicit;
  return path.join(process.cwd(), 'data', 'last_contact.json');
}

let cache = null; // { [digitsOnlyPhone]: epochMsOfLastInbound }

function load() {
  if (cache) return cache;
  try {
    const o = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
    cache = o && typeof o === 'object' ? o : {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    const fp = resolvePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(cache ?? {}), 'utf8');
  } catch (e) {
    // Non-fatal: window checks just fail closed until the disk recovers.
    console.warn('[LAST-CONTACT] persist failed (window checks fail closed):', e.message);
  }
}

function prune(now = Date.now()) {
  const c = load();
  for (const [p, ts] of Object.entries(c)) {
    if (!Number.isFinite(ts) || now - ts > PRUNE_AFTER_MS) delete c[p];
  }
}

/** Call on every inbound customer message (webhook). */
function recordInboundMessage(phone) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!digits) return;
  const c = load();
  c[digits] = Date.now();
  if (Object.keys(c).length > PRUNE_AT_SIZE) prune();
  save();
}

/**
 * Is this phone's WhatsApp customer-service window still open?
 * Uses a 23.5h margin (not a razor-thin 24h) so a push queued near the
 * boundary can't get rejected mid-flight while it works through the poller.
 */
function isServiceWindowOpen(phone, marginHours = 23.5) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!digits) return false;
  const ts = load()[digits];
  if (!Number.isFinite(ts)) return false; // unknown → closed → fail cheap
  return Date.now() - ts < marginHours * 3600 * 1000;
}

module.exports = { recordInboundMessage, isServiceWindowOpen };
