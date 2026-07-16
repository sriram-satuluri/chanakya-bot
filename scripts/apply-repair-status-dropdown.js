#!/usr/bin/env node
/**
 * Applies Google Sheets data validation (dropdown) to repair_tickets column G (status).
 *
 * Prerequisites: Same .env as the bot (GOOGLE_SHEETS_ID + service account).
 * Spreadsheet editor access for the bot service account email.
 *
 * Optional: SHEETS_STATUS_VALIDATION_LAST_ROW — last spreadsheet row number (default 5020).
 */
require('dotenv').config();
const { applyRepairTicketStatusDropdown } = require('../src/services/sheets');

(async () => {
  try {
    await applyRepairTicketStatusDropdown();
    console.log('[SHEETS] Dropdown applied on repair_tickets column G (status).');
  } catch (e) {
    console.error('[SHEETS] Failed:', e.message);
    process.exit(1);
  }
})();
