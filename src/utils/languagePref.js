/**
 * In-memory cache in front of the Sheets-backed language preference.
 *
 * The durable copy lives in opt_in_contacts column B (see
 * services/sheets.js → get/setCustomerLanguage). Reading that on EVERY inbound
 * message would add a Sheets round-trip to the hot path and burn quota, so we
 * cache per phone for the process lifetime and refresh lazily.
 *
 * The cache is intentionally NOT persisted to disk: Sheets is the source of
 * truth, so a cold start simply re-reads it once per customer.
 */

const { getCustomerLanguage } = require('../services/sheets');

const VALID = new Set(['english', 'hindi', 'gujarati']);
const TTL_MS = 6 * 60 * 60 * 1000; // re-check Sheets at most every 6h per phone
const MAX_ENTRIES = 5000;

const cache = new Map(); // digitsOnlyPhone -> { lang: string|null, at: number }

function key(phone) {
  return String(phone ?? '').replace(/[^0-9]/g, '');
}

/** Cached value only — no Sheets call. undefined = never looked up. */
function getCachedLanguage(phone) {
  const k = key(phone);
  if (!k) return undefined;
  const hit = cache.get(k);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) return undefined;
  return hit.lang;
}

/** Record a known preference (called right after the customer picks one). */
function setCachedLanguage(phone, lang) {
  const k = key(phone);
  if (!k || !VALID.has(lang)) return;
  if (cache.size > MAX_ENTRIES) cache.clear(); // crude but bounded; refills lazily
  cache.set(k, { lang, at: Date.now() });
}

/**
 * The customer's stored language, or null if they've never chosen one.
 * Falls back to null (NOT a guess) on a Sheets error so the caller can decide
 * whether to auto-detect or ask — we never want a transient read failure to
 * silently overwrite a real stored preference.
 * @returns {Promise<'english'|'hindi'|'gujarati'|null>}
 */
async function resolveLanguage(phone) {
  const cached = getCachedLanguage(phone);
  if (cached !== undefined) return cached;

  let lang = null;
  try {
    lang = await getCustomerLanguage(phone);
  } catch (e) {
    console.warn('[LANG] Sheets lookup failed, treating as unknown:', e.message);
    return null; // don't cache a failure
  }
  const k = key(phone);
  if (k) cache.set(k, { lang: VALID.has(lang) ? lang : null, at: Date.now() });
  return VALID.has(lang) ? lang : null;
}

module.exports = { resolveLanguage, getCachedLanguage, setCachedLanguage };
