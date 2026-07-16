const { google } = require('googleapis');
const {
  REPAIR_TICKET_STATUSES,
  DEFAULT_REPAIR_TICKET_STATUS,
} = require('../constants/repairTicketStatuses');

/** Max rows fetched for repair sheet (grow if needed). */
const TICKETS_ROW_CAP = Number(process.env.SHEETS_TICKETS_MAX_ROWS) || 2500;

// ── Auth (reuse client; JWT is lightweight but avoids extra setup per call)
let jwtClient = null;
function getAuth() {
  if (!jwtClient) {
    jwtClient = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return jwtClient;
}

let sheetsApi = null;
function sheets() {
  if (!sheetsApi) sheetsApi = google.sheets({ version: 'v4', auth: getAuth() });
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
  BROADCASTS:    'broadcast_log',
  BROADCAST_Q:   'broadcast_queue',
  CONTACTS:      'opt_in_contacts',
};

// ── Cache for catalog (refreshed every 15 min) ────────────────
let catalogCache = null;
let catalogCacheTime = 0;

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

// Row layout repair_tickets!A:O — keep in sync with the sheet tab header row:
// A ticket_id · B customer_name · C phone · D bag_type · E problem · F store · G status ·
// H before_photo · I after_photo · J created_at · K updated_at · L estimated_pickup ·
// M language · N notes · O last_reassurance_at · (counter in P1 outside table)
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
    new Date().toISOString().slice(0, 16).replace('T', ' '),
    new Date().toISOString().slice(0, 16).replace('T', ' '),
    '',
    safeUserText(data.language || 'english', 30),
    '',
    '',
  ];
  await appendRow(TABS.TICKETS, row);
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
        lastReassuranceAt: rows[i][14] || '',
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

// Returns all tickets whose status changed since lastChecked
async function getChangedTickets(lastChecked) {
  const rows = await readTicketRows();
  const changed = [];
  for (let i = 1; i < rows.length; i++) {
    const updatedAt = rows[i][10];
    if (updatedAt && new Date(updatedAt) > lastChecked) {
      changed.push({
        ticketId:      rows[i][0],
        customerName:  rows[i][1],
        phone:         rows[i][2],
        status:        rows[i][6],
        afterPhotoUrl: extractHttpsUrlFromCell(rows[i][8]),
        store:         rows[i][5],
        language:      rows[i][12],
        estimatedPickup: rows[i][11],
        rowIndex:      i + 1,
      });
    }
  }
  return changed;
}

// Tickets that are 'Ready for Pickup' for 7+ days
async function getUncollectedTickets(daysThreshold = 7) {
  const rows = await readTicketRows();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysThreshold);
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][6] === 'Ready for Pickup') {
      const updated = new Date(rows[i][10]);
      if (updated < cutoff) {
        result.push({
          ticketId:    rows[i][0],
          customerName:rows[i][1],
          phone:       rows[i][2],
          store:       rows[i][5],
          language:    rows[i][12],
          daysWaiting: Math.floor((Date.now() - updated) / 86400000),
        });
      }
    }
  }
  return result;
}

function parseSheetDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

// Open tickets with no row update for staleHours+, and no reassurance ping in minHoursBetweenPings+
async function getTicketsNeedingReassurance(options = {}) {
  const staleMs = (options.staleHours ?? (Number(process.env.REASSURANCE_STALE_HOURS) || 24)) * 3600000;
  const betweenMs =
    (options.minHoursBetweenPings ?? (Number(process.env.REASSURANCE_MIN_HOURS) || 20)) * 3600000;
  const skipStatuses = new Set([
    DEFAULT_REPAIR_TICKET_STATUS,
    'Picked Up',
    'Cannot Repair',
  ]);
  const now = Date.now();
  const rows = await readTicketRows();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const ticketId = rows[i][0]?.trim();
    if (!ticketId) continue;
    const status = rows[i][6];
    if (skipStatuses.has(status)) continue;

    const updatedAt = parseSheetDate(rows[i][10]);
    if (!updatedAt || now - updatedAt.getTime() < staleMs) continue;

    const lastPing = parseSheetDate(rows[i][14]);
    if (lastPing && now - lastPing.getTime() < betweenMs) continue;

    out.push({
      ticketId,
      phone: rows[i][2],
      status: status || '',
      store: rows[i][5] || '',
      language: rows[i][12] || 'english',
      estimatedPickup: rows[i][11] || '',
      rowIndex: i + 1,
    });
  }
  return out;
}

async function setTicketReassuranceTime(rowIndex, at = new Date()) {
  const ts = at.toISOString().slice(0, 16).replace('T', ' ');
  await sheets().spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `${TABS.TICKETS}!O${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ts]] },
  });
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
// PRODUCT CATALOG
// ══════════════════════════════════════════════════════════════

async function getCatalog() {
  const now = Date.now();
  if (catalogCache && (now - catalogCacheTime) < 15 * 60 * 1000) {
    return catalogCache;
  }
  const rows = await readAllRows(TABS.CATALOG);
  const catalog = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][5]?.toUpperCase() === 'TRUE') { // in_stock
      catalog.push({
        productId:    rows[i][0],
        category:     rows[i][1],
        brand:        rows[i][2],
        name:         rows[i][3],
        priceRange:   rows[i][4],
        descEn:       rows[i][6],
        descHi:       rows[i][7],
        descGu:       rows[i][8],
        imageUrl:     rows[i][9],
        availability: rows[i][10],
      });
    }
  }
  catalogCache = catalog;
  catalogCacheTime = now;
  return catalog;
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
    new Date().toISOString().slice(0, 16).replace('T', ' '),
    'New',
    '',
  ];
  await appendRow(TABS.LEADS, row);
  return leadId;
}

// ══════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════

async function logAnalytics(data) {
  const row = [
    new Date().toISOString().slice(0, 19).replace('T', ' '),
    safeUserText(data.phone, 20),
    safeUserText(data.language, 30),
    safeUserText(data.intent, 60),
    safeUserText((data.customerMessage || '').substring(0, 500)),
    safeUserText((data.botResponseSummary || '').substring(0, 300)),
    safeUserText(data.sessionId || '', 120),
    data.escalated ? 'TRUE' : 'FALSE',
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
    new Date().toISOString().slice(0, 10),
    'TRUE',
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
    new Date().toISOString().slice(0, 10),
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
    if (rows[i][6] === 'pending' && new Date(rows[i][2]) <= now) {
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

async function markBroadcastSent(rowIndex) {
  return setBroadcastStatus(rowIndex, 'sent');
}

// ══════════════════════════════════════════════════════════════
// GENERIC HELPERS
// ══════════════════════════════════════════════════════════════

async function appendRow(tabName, rowData) {
  await sheets().spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [rowData] },
  });
}

// Generic tab read cap. 1000 was too low: once opt_in_contacts crossed it,
// contact dedup and broadcasts would silently miss everyone below the fold.
const GENERIC_ROW_CAP = Number(process.env.SHEETS_GENERIC_MAX_ROWS) || 10000;
async function readAllRows(tabName) {
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${tabName}!A1:Z${GENERIC_ROW_CAP}`,
  });
  return res.data.values || [];
}

/** Loads repair sheet with formulas preserved (=IMAGE…) so thumbnails stay readable programmatically via extractHttpsUrlFromCell */
async function readTicketRows() {
  const res = await sheets().spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `${TABS.TICKETS}!A1:Z${TICKETS_ROW_CAP}`,
    valueRenderOption: 'FORMULA',
  });
  return res.data.values || [];
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
  createRepairTicket, findTicket, findTicketsByPhone, getChangedTickets, getUncollectedTickets,
  getTicketsNeedingReassurance, setTicketReassuranceTime,
  getLastTicketNumber, setLastTicketNumber,
  getCatalog,
  createLead,
  logAnalytics,
  addOrUpdateContact, getOptInContacts, setContactOptIn,
  getPendingBroadcasts, markBroadcastSent, setBroadcastStatus,
  applyRepairTicketStatusDropdown,
  readTicketRows,
  TABS,
  sheetImageFormulaFromUrl, extractHttpsUrlFromCell,
};
