/**
 * IST (Asia/Kolkata, UTC+05:30, no DST) timestamp helpers.
 *
 * Every timestamp written to the Google Sheet used to be produced with
 * `new Date().toISOString()`, which is ALWAYS UTC regardless of the server's
 * own clock or the spreadsheet's display timezone. The spreadsheet's
 * File → Settings → Time zone only controls how Sheets formats real
 * date/formula values (e.g. NOW()) — it has zero effect on a plain text
 * string we push in via the API. The result: every "created_at" / "updated_at"
 * / etc. cell showed a time 5 hours 30 minutes BEHIND the real IST moment.
 *
 * These helpers make the write side always emit IST wall-clock digits (so the
 * sheet shows the correct local time no matter what timezone the Node process
 * itself is running in — a dev laptop set to IST and a UTC cloud container
 * must produce identical output), and the read side always interpret those
 * digits back into the correct absolute instant for comparisons like
 * "hours since last update" or "is it time to send this broadcast yet".
 *
 * IST has a fixed, non-DST offset, so a constant-offset shift is exact and
 * simpler/more predictable than Intl timezone formatting.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS" — the instant's IST wall clock. */
function formatIST(date = new Date(), { seconds = false } = {}) {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  const iso = shifted.toISOString(); // e.g. 2026-07-17T06:33:58.123Z (digits ARE the IST wall clock)
  return iso.slice(0, seconds ? 19 : 16).replace('T', ' ');
}

/** "YYYY-MM-DD" — the instant's IST calendar date. */
function formatISTDate(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Days between the Sheets/Excel serial epoch (1899-12-30) and the Unix epoch. */
const SHEETS_SERIAL_EPOCH_DAYS = 25569;

/**
 * Parse a repair-sheet timestamp cell back into the correct absolute Date.
 * Because rows are written with valueInputOption 'USER_ENTERED', Sheets
 * auto-recognises our "YYYY-MM-DD HH:MM" text as a date/time and silently
 * converts the CELL to a real Sheets date-time serial number (days since
 * 1899-12-30, fractional part = time of day) — so reading it back via the
 * API (valueRenderOption FORMULA) yields a plain number like
 * 46215.27638..., not the original string. Accepts either shape:
 *
 *   - a Sheets serial number (or numeric string) → converted via the
 *     standard serial→Unix-ms formula, which yields a Date whose UTC fields
 *     equal the literal digits we wrote (i.e. still "as if UTC");
 *   - a "YYYY-MM-DD[ T]HH:MM[:SS]" text string (e.g. hand-typed by staff, or
 *     if SHEETS_USE_IMAGE_FORMULA-style raw-text writes are ever used).
 *
 * Either way, those digits are IST wall-clock (see formatIST above), so the
 * final step always undoes the IST shift to recover the true instant. This
 * works identically regardless of the server process's own timezone —
 * unlike `new Date(naiveString)`, which silently uses the RUNNING PROCESS's
 * local offset for a timezone-less string and therefore gives a different
 * (wrong) answer on a UTC production server than on an IST dev machine.
 */
function parseISTString(value) {
  if (value == null || value === '') return null;

  let asIfUtc;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const serial = Number(value);
    if (!Number.isFinite(serial)) return null;
    asIfUtc = new Date(Math.round((serial - SHEETS_SERIAL_EPOCH_DAYS) * 86400000));
  } else {
    const s = String(value).trim();
    if (!s) return null;
    const iso = s.includes('T') ? s : s.replace(' ', 'T');
    asIfUtc = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  }
  if (Number.isNaN(asIfUtc.getTime())) return null;
  // Undo the IST shift to recover the true instant — the exact inverse of formatIST().
  return new Date(asIfUtc.getTime() - IST_OFFSET_MS);
}

/** Calendar year in IST — for the CHA-{year}-#### ticket ID prefix, so the
 *  rollover happens at IST midnight regardless of the server's own timezone. */
function currentISTYear(date = new Date()) {
  return Number(formatISTDate(date).slice(0, 4));
}

/** Hour-of-day (0-23) in IST. Used for proactive-send quiet hours, so the
 *  window means the same thing on a UTC cloud host as on an IST laptop. */
function istHour(date = new Date()) {
  return new Date(date.getTime() + IST_OFFSET_MS).getUTCHours();
}

module.exports = { formatIST, formatISTDate, parseISTString, currentISTYear, istHour, IST_OFFSET_MS };
