/**
 * Parse customer-entered ticket IDs loosely: any CHA/year/sequence casing,
 * optional store letter (R Alkapuri / S Sursagar), optional leading "TRACK",
 * unicode dashes, optional shorter sequence (pads to 4 digits).
 *
 * New tickets: CHA-R-2026-0020 / CHA-S-2026-0020
 * Legacy tickets (still on the sheet): CHA-2026-0042
 */

const UNICODE_DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const { currentISTYear } = require('./istTime');

/**
 * The short form a customer can say out loud: "R-13" for CHA-R-2026-0013.
 *
 * "See-Aitch-Ay dash Arr dash two-oh-two-six dash oh-oh-one-three" is not
 * something anyone reads down a phone line correctly. The STORED id never
 * changes \u2014 this is display and input sugar only.
 *
 * @returns {string|null} e.g. "R-13", or null for a legacy id with no letter
 */
function shortTicketCode(ticketId) {
  const m = /^CHA-([RS])-(\d{4})-(\d{1,4})$/i.exec(String(ticketId || '').trim());
  if (!m) return null;
  return `${m[1].toUpperCase()}-${String(Number(m[3]))}`;
}

/** @returns {string | null} canonical e.g. CHA-R-2026-0020 or CHA-2026-0042 */
function tryParseTicketId(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(UNICODE_DASHES, '-');
  t = t.replace(/^TRACK\s+/i, '').trim();
  // Store letter is optional so TRACK CHA-2026-42 still finds old tickets.
  const re = /\bCHA-(?:([RS])-)?(\d{4})-(\d{1,4})\b/gi;
  const m = re.exec(t);
  if (m) {
    const letter = m[1] ? m[1].toUpperCase() : '';
    const year = m[2];
    const seq = m[3].padStart(4, '0');
    return letter ? `CHA-${letter}-${year}-${seq}` : `CHA-${year}-${seq}`;
  }

  // Short spoken form: R13, R-13, s 7. The letter is REQUIRED \u2014 a bare number
  // would collide with the 1-5 feedback ratings and with ordinary digits in
  // conversation, so "13" on its own is deliberately not a ticket reference.
  //
  // FUTURE-YOU: the year is resolved as "this year in IST", which is wrong for
  // a few days around 1 January \u2014 someone quoting R-13 on 2 Jan means last
  // year's ticket, and we will look for this year's. Not worth solving now
  // (the full id still works, and the not-found reply asks for it), but if
  // this bites, try the current year and then the previous one before giving up.
  const short = /^([RS])[\s-]?(\d{1,4})$/i.exec(t);
  if (short) {
    const letter = short[1].toUpperCase();
    const seq = short[2].padStart(4, '0');
    return `CHA-${letter}-${currentISTYear()}-${seq}`;
  }
  return null;
}

function isTicketLikeMessage(text) {
  return tryParseTicketId(text) !== null;
}

module.exports = { tryParseTicketId, isTicketLikeMessage, shortTicketCode };
