#!/usr/bin/env node
/**
 * Tickets that were booked in WhatsApp but never showed up at the store.
 *
 * A ticket sitting on the default "bag not received yet" status for days is
 * almost always a customer who booked and then didn't drop the bag off —
 * or a row staff forgot to move. Either way the sheet should not stay silent.
 *
 * Usage:  node scripts/orphan-tickets.js [days]     (default: 7)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const {
  DEFAULT_REPAIR_TICKET_STATUS,
  canonicalStatus,
} = require('../src/constants/repairTicketStatuses');
const { parseISTString } = require('../src/utils/istTime');

function last4(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  return d.length > 4 ? '***' + d.slice(-4) : '***';
}

async function main() {
  const days = Number(process.argv[2]) || 7;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'repair_tickets!A2:J5000',
  });
  const rows = res.data.values || [];
  const awaiting = canonicalStatus(DEFAULT_REPAIR_TICKET_STATUS);
  const orphans = [];

  for (const r of rows) {
    const ticketId = String(r[0] || '').trim();
    if (!ticketId) continue;
    const status = canonicalStatus(r[6]);
    if (status !== awaiting && String(r[6] || '').trim() !== '') continue;
    const created = parseISTString(r[9]);
    if (!created || created.getTime() > cutoff) continue;
    const ageDays = Math.floor((Date.now() - created.getTime()) / (24 * 60 * 60 * 1000));
    orphans.push({
      ticketId,
      name: String(r[1] || '').trim() || '—',
      phone: last4(r[2]),
      store: String(r[5] || '').trim() || '—',
      ageDays,
    });
  }

  orphans.sort((a, b) => b.ageDays - a.ageDays);

  console.log(`\nOrphan tickets — booked, still "awaiting drop-off", older than ${days} days\n`);
  if (!orphans.length) {
    console.log('  None. Either bags are arriving, or staff are updating column G.\n');
    return;
  }
  console.log('  Ticket          Age   Store                         Phone      Name');
  console.log('  --------------- ----- ----------------------------- ---------- --------------------');
  for (const o of orphans) {
    console.log(
      `  ${o.ticketId.padEnd(15)} ${String(o.ageDays + 'd').padStart(4)}  `
      + `${o.store.slice(0, 27).padEnd(27)}  ${o.phone.padEnd(10)} ${o.name.slice(0, 20)}`,
    );
  }
  console.log(`\n  ${orphans.length} row(s). Call them, or mark the row Cancelled if they are not coming.\n`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
