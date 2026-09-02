const { google } = require('googleapis');
const {
  REPAIR_TICKET_STATUSES,
  DEFAULT_REPAIR_TICKET_STATUS,
  canonicalStatus,
  terminalStopReason,
} = require('../constants/repairTicketStatuses');
const { formatIST, formatISTDate, parseISTString } = require('../utils/istTime');
const { envInt } = require('../utils/env');

/** Max rows fetched for repair sheet (grow if needed). */
const TICKETS_ROW_CAP = envInt('SHEETS_TICKETS_MAX_ROWS', 2500, { min: 1 });

/**
 * Per-call deadline for the Sheets HTTP client.
 *
 * Same idea as the Meta Graph 15s timeout and Cloudinary's 60s upload
 * timeout: a hung Google round-trip must not pin a customer's WhatsApp
 * turn forever. 15s matches Graph — Sheets is a JSON API, not a photo
 * upload. Override with SHEETS_TIMEOUT_MS if a large tab read needs more.
 */
const SHEETS_TIMEOUT_MS = envInt('SHEETS_TIMEOUT_MS', 15000, { min: 1000 });
const SHEETS_RETRY_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient failures worth another try. 4xx (except 429) will not succeed
 * on retry; 429 / 5xx / timeouts / dropped sockets often will.
 */
function isRetryableSheetsError(err) {
  const status = Number(err?.response?.status ?? err?.status ?? err?.code);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const code = String(err?.code || err?.cause?.code || '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'].includes(code)) {
    return true;
  }
  const msg = String(err?.message || '');
  return /timeout|timed out|socket hang up|network/i.test(msg);
}

/**
 * Cloudinary-shaped retry: 3 attempts, 450ms × attempt backoff, log each miss.
 * Non-retryable errors still log once and throw immediately.
 */
async function withSheetsRetry(op) {
  let lastErr;
  for (let attempt = 1; attempt <= SHEETS_RETRY_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      console.warn(`[SHEETS] attempt ${attempt}/${SHEETS_RETRY_ATTEMPTS} failed:`, err.message || String(err));
      if (!isRetryableSheetsError(err) || attempt === SHEETS_RETRY_ATTEMPTS) throw err;
      await sleep(450 * attempt);
    }
  }
  throw lastErr;
}

/**
 * Wrap the methods this module actually calls so every Sheets round-trip gets
 * a timeout (via the gaxios client options) and, where it is SAFE, retry.
 *
 * `append` is deliberately NOT retried. It is the one verb here that is not
 * idempotent: if Google accepts the row but the response times out, a retry
 * appends it a second time. For createRepairTicket that means two rows with
 * the SAME ticket id — the id is minted before the call — and a phantom
 * booking in the sheet that nobody knows is phantom. A ticket that fails
 * loudly (the customer is told to call the store, and the throttle is not
 * recorded so they can retry) is strictly better than one that silently
 * duplicates. `get`, `update` and `batchUpdate` are all idempotent and keep
 * their retries.
 *
 * Pass `_noRetry: true` in the params of a read to opt out per call — for
 * latency-critical paths where a caller's own deadline is shorter than the
 * retry backoff. The key is stripped before the request is built.
 */
function wrapSheetsClient(raw) {
  const values = raw.spreadsheets.values;
  const origValues = {
    get: values.get.bind(values),
    update: values.update.bind(values),
    append: values.append.bind(values),
    batchUpdate: values.batchUpdate.bind(values),
  };
  const retryable = (fn) => (params = {}) => {
    const { _noRetry, ...rest } = params;
    return _noRetry ? fn(rest) : withSheetsRetry(() => fn(rest));
  };
  values.get = retryable(origValues.get);
  values.update = retryable(origValues.update);
  values.batchUpdate = retryable(origValues.batchUpdate);
  // NOT retried — see above. Still gets the client timeout.
  values.append = (params) => origValues.append(params);

  const ss = raw.spreadsheets;
  const origSs = {
    get: ss.get.bind(ss),
    batchUpdate: ss.batchUpdate.bind(ss),
  };
  ss.get = retryable(origSs.get);
  ss.batchUpdate = retryable(origSs.batchUpdate);
  return raw;
}

// ── Auth (reuse client; JWT is lightweight but avoids extra setup per call)
let jwtClient = null;
function getAuth() {
  if (!jwtClient) {
    jwtClient = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    // Token fetch uses the same HTTP stack. Without a deadline a hung OAuth
    // round-trip would pin every Sheets call behind it.
    if (jwtClient.transporter?.defaults) {
      jwtClient.transporter.defaults.timeout = SHEETS_TIMEOUT_MS;
    }
  }
  return jwtClient;
}

let sheetsApi = null;
function sheets() {
  if (!sheetsApi) {
    sheetsApi = wrapSheetsClient(google.sheets({
      version: 'v4',
      auth: getAuth(),
      timeout: SHEETS_TIMEOUT_MS,
    }));
  }
  return sheetsApi;
}

const SHEET_ID = () => process.env.GOOGLE_SHEETS_ID;

/** Cell value that shows inline image preview + keeps URL usable for lookups. */
function sheetImageFormulaFromUrl(url) {
  const u = String(url ?? '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return u;
  const escaped = u.replace(/\\/g, '\\\\').replace(/"/g, '""');
  return `=IMAGE("${escaped}", 1)`;
}

/**
 * Recover HTTPS URL from a sheet cell whether it is plain URL, =IMAGE("..."), or =HYPERLINK("...", ...).
 */
function extractHttpsUrlFromCell(val) {
  const s = String(val ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  const imageQuoted = /IMAGE\s*\(\s*"((?:[^"]|"")*)"/i.exec(s);
  if (imageQuoted) return imageQuoted[1].replace(/""/g, '"');
  const imageBare = /IMAGE\s*\(\s*(https?:\/\/[^)\s,",]+)/i.exec(s);
  if (imageBare) return imageBare[1].trim();
  const hyper = /HYPERLINK\s*\(\s*"((?:[^"]|"")*)"/i.exec(s);
  if (hyper) return hyper[1].replace(/""/g, '"').trim();
  return '';
}

/** Prefer inline preview unless SHEETS_USE_IMAGE_FORMULA=false (plain URL only). */
function beforePhotoSheetCell(url) {
  const u = String(url ?? '').trim();
  if (!u || !/^https?:\/\//i.test(u)) return '';
  const noFormula =
    process.env.SHEETS_USE_IMAGE_FORMULA === '0'
    || String(process.env.SHEETS_USE_IMAGE_FORMULA || '').toLowerCase() === 'false';
  return noFormula ? u : sheetImageFormulaFromUrl(u);
}

// ── Tab names ─────────────────────────────────────────────────
const TABS = {
  TICKETS:       'repair_tickets',
  CATALOG:       'product_catalog',
  LEADS:         'leads_corporate',
  ANALYTICS:     'analytics_log',
  BROADCAST_Q:   'broadcast_queue',
  CONTACTS:      'opt_in_contacts',
};

/**
 * CSV / spreadsheet formula-injection defence.
 *
 * We write rows with valueInputOption: 'USER_ENTERED' so that our own
 * =IMAGE(...) formulas render as inline thumbnails. But 'USER_ENTERED' also
 * evaluates ANY cell starting with = + - @ as a formula — which means a
 * customer named =HYPERLINK("https://evil.com","See status") would become a
 * clickable phishing link when owners view the sheet, and =IMPORTXML(...) could
 * exfiltrate other cells to an attacker-controlled host on next recalc.
 *
 * Every value that originates from a human (customer or owner) MUST go through
 * safeUserText() before ending up in a cell. It prefixes dangerous leading
 * characters with a single apostrophe, which Sheets treats as "this is a
 * literal string, do not evaluate". Numbers, booleans, and our own controlled
 * strings (photo URLs, ticket IDs, timestamps) can bypass this.
 *
 * Whitespace is trimmed first so " =evil" is caught.
 * Length is capped to reject megabyte payloads. Sheets rejects >50k chars per
 * cell anyway; we cap much lower (4k) since none of our fields should be that
 * long and it defangs future misuse.
 *
 * Ref: OWASP CSV Injection cheat sheet, CWE-1236.
 */
const _FORMULA_LEAD = /^[=+\-@\t\r]/;
function safeUserText(value, maxLen = 4000) {
  if (value == null) return '';
  let s = String(value);
  // Cap length up-front so no downstream string ops explode on abuse payloads.
  if (s.length > maxLen) s = s.slice(0, maxLen);
  const trimmed = s.replace(/^\s+/, '');
  if (_FORMULA_LEAD.test(trimmed)) {
    // Prefix the ORIGINAL string (leading whitespace preserved) with '.
    return "'" + s;
  }
  return s;
}

// ══════════════════════════════════════════════════════════════
// REPAIR TICKETS
// ══════════════════════════════════════════════════════════════

// Row layout repair_tickets!A:U — keep in sync with the sheet tab header row:
// A ticket_id · B customer_name · C phone · D bag_type · E problem · F store · G status ·
// H before_photo · I after_photo · J created_at · K updated_at · L estimated_pickup ·
// M language · N notes · O last_reassurance_at · P (reserved — ticket counter lives in P1) ·
// Q opted_in · R last_status_sent · S last_update_sent_at · T stop_reason ·
// U consecutive_failure_count
//
// Q-U drive the proactive repair-status updates (see jobs/statusPoller.js).
// NB: P is deliberately left blank on data rows — P1 holds the ticket counter
// outside the table, so writing '' at that index never touches it.
const TICKET_COL = {
  TICKET_ID: 0, CUSTOMER_NAME: 1, PHONE: 2, BAG_TYPE: 3, PROBLEM: 4, STORE: 5,
  STATUS: 6, BEFORE_PHOTO: 7, AFTER_PHOTO: 8, CREATED_AT: 9, UPDATED_AT: 10,
  ESTIMATED_PICKUP: 11, LANGUAGE: 12, NOTES: 13, LAST_REASSURANCE_AT: 14,
  RESERVED_P: 15,
  OPTED_IN: 16, LAST_STATUS_SENT: 17, LAST_UPDATE_SENT_AT: 18,
  STOP_REASON: 19, CONSECUTIVE_FAILURE_COUNT: 20,
  // V-Y — post-pickup feedback (see jobs/feedbackRequest.js)
  PICKED_UP_SEEN_AT: 21, FEEDBACK_REQUESTED_AT: 22, RATING: 23, RATING_AT: 24,
  // Z — the shop-floor staff member who booked this ticket, when the customer
  // was helped in store. Blank for the many bookings made from home.
  SERVED_BY: 25,
};
/** A1 column letter for a 0-based TICKET_COL index (A-Z is enough here). */
function ticketColLetter(idx) {
  return String.fromCharCode(65 + idx);
}
async function createRepairTicket(data) {
  const photoCell = beforePhotoSheetCell(data.beforePhotoUrl || '');
  // ticketId, phone, store, language are bot-generated / constrained by our own resolvers,
  // so they can bypass safeUserText. Everything from the customer keyboard is sanitized.
  const row = [
    data.ticketId,                                             // bot-generated
    safeUserText(data.customerName),                            // USER INPUT
    safeUserText(data.phone),                                   // USER INPUT (from Meta payload)
    safeUserText(data.bagType, 120),                            // resolver output; still safeUserText for defence-in-depth
    safeUserText(data.problem, 120),                            // resolver output; still safeUserText
    safeUserText(data.store, 120),                              // storeName from STORE_NAMES map — safe, but shielded
    DEFAULT_REPAIR_TICKET_STATUS,
    photoCell,                                                  // constructed by beforePhotoSheetCell; not user text
    '',
    formatIST(),
    formatIST(),
    '',
    safeUserText(data.language || 'english', 30),
    '',                                                         // N notes
    '',                                                         // O last_reassurance_at
    '',                                                         // P reserved (counter is in P1)
    data.updatesOptedIn ? 'TRUE' : 'FALSE',                     // Q opted_in
    '',                                                         // R last_status_sent
    '',                                                         // S last_update_sent_at
    '',                                                         // T stop_reason
    '0',                                                        // U consecutive_failure_count
    '',                                                         // V picked_up_seen_at
    '',                                                         // W feedback_requested_at
    '',                                                         // X rating
    '',                                                         // Y rating_at
    safeUserText(data.servedBy || '', 60),                      // Z served_by — USER INPUT
  ];
  // Returns the sheet row so the caller can attach a photo later without a
  // full-sheet lookup (the photo now arrives AFTER the ticket is created).
  return appendRow(TABS.TICKETS, row);
}

/**
 * Attach a before-photo to an existing ticket row.
 *
 * The photo is collected after ticket creation, so this is how it lands. Uses
 * the same cell formatting as creation (inline =IMAGE preview unless disabled).
 */
async function attachBeforePhoto(rowIndex, url) {
  const cell = beforePhotoSheetCell(url);
  if (!cell || !rowIndex) return false;
  await sheets().spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${TABS.TICKETS}!${ticketColLetter(TICKET_COL.BEFORE_PHOTO)}${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[cell]] },
  });
  invalidateTicketCache();
  return true;
}

/**
 * The ticket a late-arriving photo most likely belongs to: this phone's most
 * recent non-terminal ticket that still has no before-photo.
 *
 * Lets a customer send the photo minutes or days after booking — from the
 * bus, or once they're home with the bag — and still have it filed correctly,
 * instead of it being an orphaned image the bot doesn't understand.
 */
async function findRecentTicketAwaitingPhoto(phone) {
  const want = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!want) return null;
  const rows = await readTicketRows();
  for (let i = rows.length - 1; i >= 1; i--) {   // newest first
    const r = rows[i];
    const ticketId = String(r[TICKET_COL.TICKET_ID] ?? '').trim();
    if (!ticketId || !/^CHA-/i.test(ticketId)) continue;
    if (String(r[TICKET_COL.PHONE] ?? '').replace(/[^0-9]/g, '') !== want) continue;
    if (extractHttpsUrlFromCell(r[TICKET_COL.BEFORE_PHOTO])) continue; // already has one
    if (terminalStopReason(canonicalStatus(r[TICKET_COL.STATUS]))) continue; // done/cancelled
    return {
      ticketId,
      rowIndex: i + 1,
      store: String(r[TICKET_COL.STORE] ?? '').trim(),
      language: String(r[TICKET_COL.LANGUAGE] ?? '').trim().toLowerCase() || 'english',
    };
  }
  return null;
}

async function findTicket(ticketId) {
  const rows = await readTicketRows();
  const wanted = String(ticketId).trim().toUpperCase();
  for (let i = 1; i < rows.length; i++) {
    // String() guard: with valueRenderOption FORMULA, a stray numeric cell in
    // column A comes back as a number and .toUpperCase() would throw.
    if (String(rows[i][0] ?? '').trim().toUpperCase() === wanted) {
      return {
        ticketId:       rows[i][0],
        customerName:   rows[i][1],
        phone:          rows[i][2],
        bagType:        rows[i][3],
        problem:        rows[i][4],
        store:          rows[i][5],
        status:         rows[i][6],
        beforePhotoUrl: extractHttpsUrlFromCell(rows[i][7]),
        afterPhotoUrl:  extractHttpsUrlFromCell(rows[i][8]),
        createdAt:      rows[i][9],
        updatedAt:      rows[i][10],
        estimatedPickup:rows[i][11],
        language:       rows[i][12],
        rowIndex:       i + 1,  // 1-indexed for Sheets API
      };
    }
  }
  return null;
}

/**
 * All tickets raised by a given phone number, newest first.
 *
 * The phone is the caller's Meta-verified WhatsApp sender id, so this is a
 * secure, self-service lookup: a customer only ever sees THEIR OWN tickets and
 * never has to remember a ticket ID. Matching is digits-only so "+91…", spaces,
 * or manual sheet edits still line up. Reuses the same sheet read as findTicket
 * — no extra Google Sheets cost.
 *
 * @param {string} phone
 * @param {number} [limit] cap the result (WhatsApp lists hold max 10 rows)
 */
async function findTicketsByPhone(phone, limit = 10) {
  const want = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!want) return [];
  const rows = await readTicketRows();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const rowPhone = String(rows[i][2] ?? '').replace(/[^0-9]/g, '');
    if (rowPhone && rowPhone === want) {
      out.push({
        ticketId: rows[i][0],
        customerName: String(rows[i][1] ?? '').trim(),
        bagType:  rows[i][3],
        problem:  rows[i][4],
        store:    rows[i][5],
        status:   rows[i][6],
        createdAt: rows[i][9],
      });
    }
  }
  // Rows are appended in creation order, so later rows are newer.
  out.reverse();
  return limit > 0 ? out.slice(0, limit) : out;
}

// Tickets that are 'Ready for Pickup' for 7+ days
async function getUncollectedTickets(daysThreshold = 7) {
  const rows = await readTicketRows();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysThreshold);
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    if (canonicalStatus(rows[i][6]) === 'Ready for Pickup') {
      const updated = parseISTString(rows[i][10]);
      if (updated && updated < cutoff) {
        result.push({
          ticketId:    rows[i][0],
          customerName:rows[i][1],
          phone:       rows[i][2],
          store:       rows[i][5],
          language:    rows[i][12],
          daysWaiting: Math.floor((Date.now() - updated.getTime()) / 86400000),
        });
      }
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
// PROACTIVE REPAIR-UPDATE STATE (repair_tickets Q-U)
// ══════════════════════════════════════════════════════════════

/** Sheet cells hold 'TRUE'/'FALSE' text; treat anything else as false. */
function isSheetTrue(v) {
  return String(v ?? '').trim().toUpperCase() === 'TRUE';
}

/**
 * Every ticket that is a candidate for a proactive status update: opted in,
 * not already stopped, and with a usable phone. Terminal-status filtering and
 * send-vs-skip decisions live in jobs/statusPoller.js — this just surfaces
 * the rows and their update state.
 */
async function getTicketsForProactiveUpdate() {
  const rows = await readTicketRows();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ticketId = String(r[TICKET_COL.TICKET_ID] ?? '').trim();
    if (!ticketId || !/^CHA-/i.test(ticketId)) continue;
    if (!isSheetTrue(r[TICKET_COL.OPTED_IN])) continue;
    // A recorded stop_reason means the lifecycle already ended for this ticket.
    if (String(r[TICKET_COL.STOP_REASON] ?? '').trim()) continue;

    out.push({
      ticketId,
      customerName:      String(r[TICKET_COL.CUSTOMER_NAME] ?? '').trim(),
      phone:             String(r[TICKET_COL.PHONE] ?? '').trim(),
      store:             String(r[TICKET_COL.STORE] ?? '').trim(),
      status:            canonicalStatus(r[TICKET_COL.STATUS]),
      language:          String(r[TICKET_COL.LANGUAGE] ?? '').trim().toLowerCase() || 'english',
      lastStatusSent:    String(r[TICKET_COL.LAST_STATUS_SENT] ?? '').trim(),
      lastUpdateSentAt:  parseISTString(r[TICKET_COL.LAST_UPDATE_SENT_AT]),
      failureCount:      Number(r[TICKET_COL.CONSECUTIVE_FAILURE_COUNT]) || 0,
      rowIndex:          i + 1, // 1-indexed for the Sheets API
    });
  }
  return out;
}

/**
 * Persist the outcome of a proactive send in one batched write (one API call
 * per ticket rather than five). Only the fields provided are written.
 * @param {number} rowIndex 1-indexed sheet row
 * @param {{statusSent?:string, sentAt?:Date, stopReason?:string, failureCount?:number, optedIn?:boolean}} patch
 */
async function recordProactiveUpdate(rowIndex, patch = {}) {
  const data = [];
  const put = (colIdx, value) => data.push({
    range: `${TABS.TICKETS}!${ticketColLetter(colIdx)}${rowIndex}`,
    values: [[value]],
  });

  if (patch.optedIn !== undefined) put(TICKET_COL.OPTED_IN, patch.optedIn ? 'TRUE' : 'FALSE');
  if (patch.statusSent !== undefined) put(TICKET_COL.LAST_STATUS_SENT, safeUserText(patch.statusSent, 200));
  if (patch.sentAt !== undefined) put(TICKET_COL.LAST_UPDATE_SENT_AT, formatIST(patch.sentAt));
  if (patch.stopReason !== undefined) put(TICKET_COL.STOP_REASON, safeUserText(patch.stopReason, 60));
  if (patch.failureCount !== undefined) put(TICKET_COL.CONSECUTIVE_FAILURE_COUNT, String(patch.failureCount));
  if (!data.length) return;

  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  invalidateTicketCache();
}

/**
 * Open (non-terminal, non-stopped) tickets belonging to a phone number.
 * Backs the standing "stop updates" / "resume updates" commands and the
 * "you still have updates on your open ticket" note on bare STOP.
 */
async function getOpenTicketsForPhone(phone, { noRetry = false } = {}) {
  const want = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!want) return [];
  const rows = await readTicketRows({ noRetry });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ticketId = String(r[TICKET_COL.TICKET_ID] ?? '').trim();
    if (!ticketId || !/^CHA-/i.test(ticketId)) continue;
    if (String(r[TICKET_COL.PHONE] ?? '').replace(/[^0-9]/g, '') !== want) continue;
    const status = canonicalStatus(r[TICKET_COL.STATUS]);
    if (terminalStopReason(status)) continue; // already finished/cancelled
    out.push({
      ticketId,
      status,
      rowIndex: i + 1,
      optedIn: isSheetTrue(r[TICKET_COL.OPTED_IN]),
      stopReason: String(r[TICKET_COL.STOP_REASON] ?? '').trim(),
      // Carried so callers can route owner alerts to the right branch and
      // give the humans real context (see utils/ownerPhones.getRecipientsForStore).
      store: String(r[TICKET_COL.STORE] ?? '').trim(),
      customerName: String(r[TICKET_COL.CUSTOMER_NAME] ?? '').trim(),
      language: String(r[TICKET_COL.LANGUAGE] ?? '').trim().toLowerCase() || 'english',
    });
  }
  return out;
}

/**
 * Toggle proactive updates for a phone's open tickets. Opting back in clears
 * the stop_reason and failure counter so a previously-stopped ticket resumes
 * cleanly.
 *
 * @param {string} phone
 * @param {boolean} optedIn
 * @param {{stopReason?: string, ticketId?: string}} [opts]
 *   ticketId — limit the change to that one ticket (used by the answer to the
 *   post-booking question). Omit to apply to every open ticket, which is what
 *   the standing "stop updates" / "resume updates" commands want.
 * @returns {Promise<number>} how many tickets were changed
 */
async function setRepairUpdatesOptIn(phone, optedIn, opts = {}) {
  const { stopReason = '', ticketId = null } = opts;
  const wantId = ticketId ? String(ticketId).trim().toUpperCase() : null;
  const open = await getOpenTicketsForPhone(phone);
  let changed = 0;
  for (const t of open) {
    if (wantId && t.ticketId.toUpperCase() !== wantId) continue;
    await recordProactiveUpdate(t.rowIndex, optedIn
      ? { optedIn: true, stopReason: '', failureCount: 0 }
      : { optedIn: false, stopReason: stopReason || 'opted_out' });
    changed++;
  }
  return changed;
}

// ══════════════════════════════════════════════════════════════
// POST-PICKUP FEEDBACK (repair_tickets V-Y)
// ══════════════════════════════════════════════════════════════

/**
 * Collected tickets that are candidates for a feedback request.
 * Deliberately keyed on 'Picked Up' rather than 'Ready for Pickup': the
 * customer has only experienced the finished repair once they've actually
 * collected the bag and looked at it.
 */
async function getTicketsForFeedback() {
  const rows = await readTicketRows();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ticketId = String(r[TICKET_COL.TICKET_ID] ?? '').trim();
    if (!ticketId || !/^CHA-/i.test(ticketId)) continue;
    if (canonicalStatus(r[TICKET_COL.STATUS]) !== 'Picked Up') continue;
    // Already rated → nothing left to do for this ticket.
    if (String(r[TICKET_COL.RATING] ?? '').trim()) continue;

    out.push({
      ticketId,
      phone:             String(r[TICKET_COL.PHONE] ?? '').trim(),
      customerName:      String(r[TICKET_COL.CUSTOMER_NAME] ?? '').trim(),
      store:             String(r[TICKET_COL.STORE] ?? '').trim(),
      language:          String(r[TICKET_COL.LANGUAGE] ?? '').trim().toLowerCase() || 'english',
      pickedUpSeenAt:    parseISTString(r[TICKET_COL.PICKED_UP_SEEN_AT]),
      feedbackRequestedAt: parseISTString(r[TICKET_COL.FEEDBACK_REQUESTED_AT]),
      rowIndex:          i + 1,
    });
  }
  return out;
}

/** @param {{pickedUpSeenAt?:Date, feedbackRequestedAt?:Date, rating?:number, ratingAt?:Date}} patch */
async function recordFeedbackState(rowIndex, patch = {}) {
  const data = [];
  const put = (colIdx, value) => data.push({
    range: `${TABS.TICKETS}!${ticketColLetter(colIdx)}${rowIndex}`,
    values: [[value]],
  });
  if (patch.pickedUpSeenAt !== undefined) put(TICKET_COL.PICKED_UP_SEEN_AT, formatIST(patch.pickedUpSeenAt));
  if (patch.feedbackRequestedAt !== undefined) put(TICKET_COL.FEEDBACK_REQUESTED_AT, formatIST(patch.feedbackRequestedAt));
  if (patch.rating !== undefined) put(TICKET_COL.RATING, String(patch.rating));
  if (patch.ratingAt !== undefined) put(TICKET_COL.RATING_AT, formatIST(patch.ratingAt));
  if (!data.length) return;
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  invalidateTicketCache();
}

/**
 * The ticket a rating reply belongs to: most recently asked, not yet rated.
 * Returns null when this customer has no outstanding feedback request, which
 * is what stops a stray "3" in conversation being logged as a rating.
 */
async function findTicketAwaitingRating(phone) {
  const want = String(phone ?? '').replace(/[^0-9]/g, '');
  if (!want) return null;
  const candidates = (await getTicketsForFeedback())
    .filter((t) => String(t.phone).replace(/[^0-9]/g, '') === want && t.feedbackRequestedAt);
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.feedbackRequestedAt - a.feedbackRequestedAt);
  return candidates[0];
}

/** True if this phone has at least one open ticket still receiving updates. */
async function hasOpenOptedInTicket(phone) {
  const open = await getOpenTicketsForPhone(phone);
  return open.some(t => t.optedIn && !t.stopReason);
}

// ══════════════════════════════════════════════════════════════
// TICKET ID COUNTER (stored in repair_tickets!P1)
// ══════════════════════════════════════════════════════════════

async function getLastTicketNumber() {
  // IMPORTANT: do NOT swallow read errors into 0. A transient Sheets/network
  // failure returning 0 would make the next ticket CHA-YYYY-0001 again —
  // colliding with an existing ticket and hijacking that customer's tracking.
  // Let read errors propagate so ticket creation fails cleanly (customer is
  // told to call) instead of minting a duplicate ID.
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: SHEET_ID(), range: `${TABS.TICKETS}!P1`,
  });
  const raw = res.data.values?.[0]?.[0];
  // Empty cell = fresh sheet; 0 is the correct starting point.
  if (raw == null || String(raw).trim() === '') return 0;
  const n = parseInt(String(raw).trim(), 10);
  // A corrupted (non-numeric) counter must fail loudly, not silently reset to 1.
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Ticket counter (repair_tickets!P1) is not a valid number: "${raw}"`);
  }
  return n;
}

async function setLastTicketNumber(num) {
  await sheets().spreadsheets.values.update({
    spreadsheetId: SHEET_ID(), range: `${TABS.TICKETS}!P1`,
    valueInputOption: 'RAW', requestBody: { values: [[String(num)]] },
  });
}

// ══════════════════════════════════════════════════════════════
// CORPORATE LEADS
// ══════════════════════════════════════════════════════════════

async function createLead(data) {
  const leadId = 'LEAD-' + Date.now();
  const row = [
    leadId,
    safeUserText(data.company),                 // USER INPUT
    safeUserText(data.name),                    // USER INPUT
    safeUserText(data.phone, 20),               // USER INPUT (from Meta payload)
    safeUserText(data.productType),             // USER INPUT
    safeUserText(data.quantity, 200),           // USER INPUT
    safeUserText(data.budget || '', 200),
    safeUserText(data.branding || '', 500),     // USER INPUT
    safeUserText(data.contactTime || '', 200),
    formatIST(),
    'New',
    '',
    // M — approx price per piece, asked right after quantity. Free text, so it
    // gets the same safeUserText treatment as every other customer-typed cell.
    // Appended at the end rather than reusing the long-empty `budget` column
    // (G): a per-piece figure and a total budget are different numbers, and
    // widening the row leaves every existing lead's columns where they are.
    safeUserText(data.pricePerPiece || '', 200),
  ];
  await appendRow(TABS.LEADS, row);
  return leadId;
}

// ══════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════

async function logAnalytics(data) {
  const row = [
    formatIST(new Date(), { seconds: true }),
    safeUserText(data.phone, 20),
    safeUserText(data.language, 30),
    safeUserText(data.intent, 60),
    safeUserText((data.customerMessage || '').substring(0, 500)),
    safeUserText((data.botResponseSummary || '').substring(0, 300)),
    safeUserText(data.sessionId || '', 120),
    data.escalated ? 'TRUE' : 'FALSE',
    // I, J — funnel position. Recorded so drop-off can be MEASURED rather than
    // guessed at: scripts/funnel-report.js counts how many distinct customers
    // ever reach each step. See the WhatsApp Flow proposal, which is currently
    // deferred precisely because we had no data on where people give up.
    safeUserText(data.flowName || '', 40),
    safeUserText(data.flowStep || '', 40),
  ];
  await appendRow(TABS.ANALYTICS, row);
}

// ══════════════════════════════════════════════════════════════
// OPT-IN CONTACTS (for broadcasts)
// ══════════════════════════════════════════════════════════════

async function addOrUpdateContact(phone, language) {
  const rows = await readAllRows(TABS.CONTACTS);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone) return; // already exists
  }
  await appendRow(TABS.CONTACTS, [
    safeUserText(phone, 20),
    safeUserText(language || 'english', 30),
    formatISTDate(),
    'TRUE',
  ]);
}

/**
 * The customer's saved language preference (opt_in_contacts column B), or null
 * if we've never stored one. This is the durable counterpart to the in-memory
 * session language — it survives restarts, so a returning customer is never
 * re-asked and never silently falls back to auto-detection.
 * @returns {Promise<'english'|'hindi'|'gujarati'|null>}
 */
async function getCustomerLanguage(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const rows = await readAllRows(TABS.CONTACTS);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').replace(/[^0-9]/g, '') === digits) {
      const lang = String(rows[i][1] || '').trim().toLowerCase();
      return ['english', 'hindi', 'gujarati'].includes(lang) ? lang : null;
    }
  }
  return null;
}

/**
 * Persist the customer's chosen language (opt_in_contacts column B), creating
 * the contact row if this is their first contact. Deliberately does NOT touch
 * column D (marketing opted_in) — language and marketing consent are separate.
 */
async function setCustomerLanguage(phone, language) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  const lang = String(language || '').trim().toLowerCase();
  if (!digits || !['english', 'hindi', 'gujarati'].includes(lang)) return;
  const rows = await readAllRows(TABS.CONTACTS);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').replace(/[^0-9]/g, '') === digits) {
      await sheets().spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${TABS.CONTACTS}!B${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[lang]] },
      });
      return;
    }
  }
  await appendRow(TABS.CONTACTS, [
    safeUserText(phone, 20),
    lang,
    formatISTDate(),
    'TRUE',
  ]);
}

const NAME_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const _nameCache = new Map(); // digits -> { name, at }

function _digitsPhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

function _usableCustomerName(s) {
  const t = String(s || '').trim();
  if (t.length < 2 || t.length > 60) return false;
  if (/^(btn_|bag_|prob_|store_|cat_|lang_)/i.test(t)) return false;
  return true;
}

/**
 * Last known name for this WhatsApp number, or null.
 * Prefers opt_in_contacts column E (written when they first book), then the
 * newest repair ticket. Cached so a returning customer tapping Repair does
 * not pay an extra Sheets round-trip on every step.
 */
async function getCustomerName(phone) {
  const digits = _digitsPhone(phone);
  if (!digits) return null;
  const hit = _nameCache.get(digits);
  if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.name;
  try {
    const rows = await readAllRows(TABS.CONTACTS);
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0] || '').replace(/[^0-9]/g, '') === digits) {
        const n = String(rows[i][4] || '').trim();
        if (_usableCustomerName(n)) {
          _nameCache.set(digits, { name: n, at: Date.now() });
          return n;
        }
        break;
      }
    }
  } catch (e) {
    console.warn('[SHEETS] getCustomerName contacts read failed:', e.message);
  }
  try {
    const tickets = await findTicketsByPhone(phone, 1);
    const n = tickets[0]?.customerName;
    if (_usableCustomerName(n)) {
      _nameCache.set(digits, { name: n, at: Date.now() });
      return n;
    }
  } catch (e) {
    console.warn('[SHEETS] getCustomerName tickets read failed:', e.message);
  }
  return null;
}

/**
 * Persist the customer's name on opt_in_contacts column E. Does not touch
 * language (B) or marketing opt-in (D). Creates the row if they have never
 * been seen as a contact.
 */
async function setCustomerName(phone, name) {
  const digits = _digitsPhone(phone);
  const n = String(name || '').trim();
  if (!digits || !_usableCustomerName(n)) return;
  _nameCache.set(digits, { name: n, at: Date.now() });
  const rows = await readAllRows(TABS.CONTACTS);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').replace(/[^0-9]/g, '') === digits) {
      await sheets().spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${TABS.CONTACTS}!E${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[safeUserText(n, 60)]] },
      });
      return;
    }
  }
  await appendRow(TABS.CONTACTS, [
    safeUserText(phone, 20),
    'english',
    formatISTDate(),
    'TRUE',
    safeUserText(n, 60),
  ]);
}

/**
 * Set the opted_in flag (column D) for a contact. Used by the STOP / RESUME
 * keywords so customers control whether broadcasts reach them (WhatsApp
 * Business policy requires honouring opt-outs).
 * If the phone isn't in the tab yet, the row is created with the given state.
 */
async function setContactOptIn(phone, optedIn, language = 'english') {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  if (!digits) return;
  const rows = await readAllRows(TABS.CONTACTS);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || '').replace(/[^0-9]/g, '') === digits) {
      await sheets().spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${TABS.CONTACTS}!D${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[optedIn ? 'TRUE' : 'FALSE']] },
      });
      return;
    }
  }
  await appendRow(TABS.CONTACTS, [
    safeUserText(phone, 20),
    safeUserText(language || 'english', 30),
    formatISTDate(),
    optedIn ? 'TRUE' : 'FALSE',
  ]);
}

/**
 * @param {string} filter One of: 'all' | 'english' | 'hindi' | 'gujarati'.
 *   'all' (default) returns every opted-in contact. Otherwise filters by row's
 *   language column. Anything else falls back to 'all' + a warning log so a
 *   typo in the sheet's audience filter isn't silently ignored.
 */
async function getOptInContacts(filter = 'all') {
  const rows = await readAllRows(TABS.CONTACTS);
  const optedIn = rows.slice(1)
    .filter(r => r[3]?.toUpperCase() === 'TRUE')
    .map(r => ({ phone: (r[0] || '').trim(), language: (r[1] || 'english').trim().toLowerCase() }))
    .filter(c => c.phone);
  const f = String(filter || 'all').trim().toLowerCase();
  if (f === 'all' || f === '') return optedIn;
  if (f === 'english' || f === 'hindi' || f === 'gujarati') {
    return optedIn.filter(c => c.language === f);
  }
  console.warn(`[SHEETS] getOptInContacts: unknown filter "${filter}" — sending to ALL opted-in.`);
  return optedIn;
}

// ══════════════════════════════════════════════════════════════
// BROADCAST QUEUE
// ══════════════════════════════════════════════════════════════

async function getPendingBroadcasts() {
  const rows = await readAllRows(TABS.BROADCAST_Q);
  const now = new Date();
  const pending = [];
  for (let i = 1; i < rows.length; i++) {
    // Staff type sendAt by hand into the sheet as IST wall-clock time (that's
    // what a human reads/writes) — parse it as IST, not as the server's own
    // timezone, or a UTC-hosted bot would fire campaigns 5.5h late.
    const sendAt = parseISTString(rows[i][2]);
    if (rows[i][6] === 'pending' && sendAt && sendAt <= now) {
      pending.push({
        campaignName:  rows[i][0],
        templateName:  rows[i][1],
        sendAt:        rows[i][2],
        audienceFilter:rows[i][3],
        language:      rows[i][4],
        variablesJson: rows[i][5],
        rowIndex:      i + 1,
      });
    }
  }
  return pending;
}

/** @param {'sending'|'sent'|'failed'} status Queue row status (column G). */
async function setBroadcastStatus(rowIndex, status) {
  await sheets().spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${TABS.BROADCAST_Q}!G${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  });
}

// ══════════════════════════════════════════════════════════════
// GENERIC HELPERS
// ══════════════════════════════════════════════════════════════

/**
 * @returns {Promise<number|null>} the 1-indexed sheet row the data landed on,
 *   parsed from the API's updatedRange (e.g. "repair_tickets!A13:U13" -> 13).
 *   Saves a follow-up full-sheet read when the caller needs to update the row
 *   it just created. null if the response shape is unexpected.
 */
async function appendRow(tabName, rowData) {
  const res = await sheets().spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowData] },
  });
  if (tabName === TABS.TICKETS) invalidateTicketCache();
  const m = /![A-Z]+(\d+)/.exec(res?.data?.updates?.updatedRange || '');
  return m ? Number(m[1]) : null;
}

// Generic tab read cap. 1000 was too low: once opt_in_contacts crossed it,
// contact dedup and broadcasts would silently miss everyone below the fold.
const GENERIC_ROW_CAP = envInt('SHEETS_GENERIC_MAX_ROWS', 10000, { min: 1 });
async function readAllRows(tabName) {
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A1:Z${GENERIC_ROW_CAP}`,
  });
  return res.data.values || [];
}

/** Loads repair sheet with formulas preserved (=IMAGE…) so thumbnails stay readable programmatically via extractHttpsUrlFromCell */
/**
 * Short-lived cache for the repair sheet.
 *
 * readTicketRows() pulls the WHOLE tab and has ~9 call sites (tracking, the
 * status poller, feedback, handoff routing, opt-in toggling). A busy minute
 * meant several full-sheet reads, and the cost grows linearly with ticket
 * count. A few seconds of staleness is harmless here — staff edits do not
 * need sub-minute propagation — but a stale read straight after one of OUR
 * writes would be a correctness bug, so every ticket write invalidates.
 */
const TICKET_CACHE_TTL_MS = envInt('SHEETS_TICKET_CACHE_SECONDS', 30, { min: 0 }) * 1000;
let _ticketCache = null;
let _ticketCacheAt = 0;

function invalidateTicketCache() {
  _ticketCache = null;
  _ticketCacheAt = 0;
}

/**
 * @param {{fresh?: boolean, noRetry?: boolean}} [opts]
 *   noRetry — skip the retry backoff for callers on a short deadline. The
 *   retry sleeps 450ms + 900ms before its third attempt, which alone outlasts
 *   a sub-second budget, so retrying there just guarantees the caller's
 *   fallback path instead of ever returning data.
 */
async function readTicketRows({ fresh = false, noRetry = false } = {}) {
  const now = Date.now();
  if (!fresh && _ticketCache && TICKET_CACHE_TTL_MS > 0 && (now - _ticketCacheAt) < TICKET_CACHE_TTL_MS) {
    return _ticketCache;
  }
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${TABS.TICKETS}!A1:Z${TICKETS_ROW_CAP}`,
    valueRenderOption: 'FORMULA',
    _noRetry: noRetry,
  });
  _ticketCache = res.data.values || [];
  _ticketCacheAt = now;
  return _ticketCache;
}

/**
 * Apply a dropdown list to repair_tickets column G (status) for store staff.
 * Skips header row G1 — applies from row 2 downward.
 *
 * Rows covered: configurable via SHEETS_STATUS_VALIDATION_LAST_ROW (exclusive end index = sheet row).
 * Defaults to row 5020 (≈5019 ticket rows visible with dropdown).
 */
async function applyRepairTicketStatusDropdown() {
  const id = SHEET_ID();
  if (!id) throw new Error('GOOGLE_SHEETS_ID is not set');

  const rawLastRow = Number(process.env.SHEETS_STATUS_VALIDATION_LAST_ROW);
  const exclusiveEndRow = Number.isFinite(rawLastRow) ? rawLastRow : 5020;
  const startRowIndex = 1;

  const meta = await sheets().spreadsheets.get({
    spreadsheetId: id,
    fields: 'sheets.properties(sheetId,title)',
  });
  const sh = meta.data.sheets?.find((s) => s.properties?.title === TABS.TICKETS);
  const sheetId = sh?.properties?.sheetId;
  if (!Number.isInteger(sheetId)) {
    throw new Error(`Could not resolve sheet "${TABS.TICKETS}" — check tab title matches exactly.`);
  }

  await sheets().spreadsheets.batchUpdate({
    spreadsheetId: id,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex,
              endRowIndex: Math.max(startRowIndex + 1, exclusiveEndRow),
              startColumnIndex: 6,
              endColumnIndex: 7,
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: REPAIR_TICKET_STATUSES.map((s) => ({ userEnteredValue: s })),
              },
              strict: true,
              showCustomUi: true,
              inputMessage: 'Pick the current repair stage — this syncs with the WhatsApp tracker.',
            },
          },
        },
      ],
    },
  });
}

module.exports = {
  createRepairTicket, findTicket, findTicketsByPhone, getUncollectedTickets,
  getLastTicketNumber, setLastTicketNumber,
  createLead,
  logAnalytics,
  addOrUpdateContact, getOptInContacts, setContactOptIn,
  getCustomerLanguage, setCustomerLanguage,
  getCustomerName, setCustomerName,
  getTicketsForProactiveUpdate, recordProactiveUpdate,
  getOpenTicketsForPhone, setRepairUpdatesOptIn, hasOpenOptedInTicket,
  getTicketsForFeedback, recordFeedbackState, findTicketAwaitingRating,
  attachBeforePhoto, findRecentTicketAwaitingPhoto,
  getPendingBroadcasts, setBroadcastStatus,
  applyRepairTicketStatusDropdown,
  readTicketRows,
  TABS,
  // Retry internals — exported for the unit tests that pin the
  // retry-vs-fail-fast classification.
  isRetryableSheetsError, withSheetsRetry,
};
// Kept private (used only within this module): invalidateTicketCache,
// TICKET_COL, sheetImageFormulaFromUrl, extractHttpsUrlFromCell.
