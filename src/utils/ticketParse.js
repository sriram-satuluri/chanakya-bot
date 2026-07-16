/**
 * Parse customer-entered ticket IDs loosely: any CHA/year/sequence casing,
 * optional leading "TRACK", unicode dashes, optional shorter sequence (pads to 4 digits).
 */

const UNICODE_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;

/** @returns {string | null} canonical e.g. CHA-2026-0042 or null */
function tryParseTicketId(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(UNICODE_DASHES, '-');
  t = t.replace(/^TRACK\s+/i, '').trim();
  const re = /\bCHA-(\d{4})-(\d{1,4})\b/gi;
  const m = re.exec(t);
  if (!m) return null;
  const year = m[1];
  const seq = m[2].padStart(4, '0');
  return `CHA-${year}-${seq}`;
}

function isTicketLikeMessage(text) {
  return tryParseTicketId(text) !== null;
}

module.exports = { tryParseTicketId, isTicketLikeMessage };
