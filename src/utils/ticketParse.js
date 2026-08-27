/**
 * Parse customer-entered ticket IDs loosely: any CHA/year/sequence casing,
 * optional store letter (R Alkapuri / S Sursagar), optional leading "TRACK",
 * unicode dashes, optional shorter sequence (pads to 4 digits).
 *
 * New tickets: CHA-R-2026-0020 / CHA-S-2026-0020
 * Legacy tickets (still on the sheet): CHA-2026-0042
 */

const UNICODE_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;

/** @returns {string | null} canonical e.g. CHA-R-2026-0020 or CHA-2026-0042 */
function tryParseTicketId(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(UNICODE_DASHES, '-');
  t = t.replace(/^TRACK\s+/i, '').trim();
  // Store letter is optional so TRACK CHA-2026-42 still finds old tickets.
  const re = /\bCHA-(?:([RS])-)?(\d{4})-(\d{1,4})\b/gi;
  const m = re.exec(t);
  if (!m) return null;
  const letter = m[1] ? m[1].toUpperCase() : '';
  const year = m[2];
  const seq = m[3].padStart(4, '0');
  return letter ? `CHA-${letter}-${year}-${seq}` : `CHA-${year}-${seq}`;
}

function isTicketLikeMessage(text) {
  return tryParseTicketId(text) !== null;
}

module.exports = { tryParseTicketId, isTicketLikeMessage };
