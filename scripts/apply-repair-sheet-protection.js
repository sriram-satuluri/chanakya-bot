#!/usr/bin/env node
/**
 * Locks repair_tickets so shop-floor Editors can only change Current Status
 * (column G). Column A (ticket id), P1 (counter), and every other cell stay
 * editable only by the bot service account and SHEET_FULL_ACCESS_EMAILS.
 *
 * Prerequisites: same .env as the bot. Spreadsheet editor access for the
 * service account. Staff must be shared as Editors (not Owners) — Google
 * always lets a file owner edit protected ranges.
 *
 * Locks A–F, H and beyond, and G1. Column G from row 2 stays unlocked so
 * the status dropdown still appears after the bot writes a ticket. A whole-
 * tab lock with G as an exception hides that dropdown — do not use it.
 *
 * Re-run anytime; previous bot locks are replaced in place.
 */
require('dotenv').config();
const { applyRepairTicketSheetProtection } = require('../src/services/sheets');

(async () => {
  try {
    const result = await applyRepairTicketSheetProtection();
    console.log('[SHEETS] Protection applied.', result.editors.join(', '));
  } catch (e) {
    console.error('[SHEETS] Failed:', e.message);
    process.exit(1);
  }
})();
