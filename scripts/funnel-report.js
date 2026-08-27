#!/usr/bin/env node
/**
 * Repair-booking drop-off report.
 *
 * Answers "do customers actually struggle with the booking flow?" with a
 * number instead of an opinion — the open question blocking the WhatsApp Flow
 * proposal in docs/PART3-WHATSAPP-FLOW-PROPOSAL.md.
 *
 * Counts DISTINCT PHONE NUMBERS that ever reached each step of the repair
 * flow, from analytics_log columns I/J. Distinct phones (not message counts)
 * because someone who fumbles a step three times is still one customer, and
 * counting their retries would flatter the funnel.
 *
 * Usage:  node scripts/funnel-report.js [days]      (default: 30)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { google } = require('googleapis');
const { parseISTString } = require('../src/utils/istTime');

// In the order the customer meets them.
const REPAIR_STEPS = ['ask_name', 'ask_bag_type', 'ask_problem', 'ask_store'];

async function main() {
  const days = Number(process.argv[2]) || 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEETS_ID,
    range: 'analytics_log!A2:J20000',
  });
  const rows = res.data.values || [];

  /** step -> Set(phone) */
  const reached = new Map(REPAIR_STEPS.map((s) => [s, new Set()]));
  const ticketPhones = new Set();
  let considered = 0;

  for (const r of rows) {
    const ts = parseISTString(r[0]);
    if (!ts || ts.getTime() < since) continue;
    considered++;
    const phone = String(r[1] || '').replace(/[^0-9]/g, '');
    const flowName = String(r[8] || '').trim();
    const flowStep = String(r[9] || '').trim();
    if (!phone) continue;
    if (flowName === 'repair' && reached.has(flowStep)) reached.get(flowStep).add(phone);
    // 'repair_updates' is only ever reached AFTER a ticket is created, so it
    // is the most reliable completion marker available in this log.
    if (flowName === 'repair_updates') ticketPhones.add(phone);
  }

  console.log(`\nRepair booking funnel — last ${days} days (${considered} analytics rows)\n`);
  if (!considered) {
    console.log('  No rows in range. Note: columns I/J are only populated for');
    console.log('  messages sent AFTER the funnel-tracking change shipped.\n');
    return;
  }

  const first = reached.get(REPAIR_STEPS[0]).size;
  let prev = null;
  for (const step of REPAIR_STEPS) {
    const n = reached.get(step).size;
    const pctStart = first ? Math.round((n / first) * 100) : 0;
    const lost = prev === null ? 0 : prev - n;
    const bar = '█'.repeat(Math.round((first ? n / first : 0) * 30)).padEnd(30, '·');
    console.log(
      `  ${step.padEnd(14)} ${String(n).padStart(4)}  ${bar} ${String(pctStart).padStart(3)}%`
      + (lost > 0 ? `   (-${lost} here)` : ''),
    );
    prev = n;
  }
  const done = ticketPhones.size;
  console.log(`  ${'ticket created'.padEnd(14)} ${String(done).padStart(4)}  `
    + `${'█'.repeat(Math.round((first ? done / first : 0) * 30)).padEnd(30, '·')} `
    + `${String(first ? Math.round((done / first) * 100) : 0).padStart(3)}%`);

  const dropped = first - done;
  console.log('');
  console.log(`  Started booking : ${first}`);
  console.log(`  Completed       : ${done}`);
  console.log(`  Gave up         : ${dropped}${first ? ` (${Math.round((dropped / first) * 100)}%)` : ''}`);
  console.log('');
  console.log('  A high drop at one specific step is the signal worth acting on.');
  console.log('  Spread-out attrition usually means people got distracted, not stuck.');
  console.log('  Returning customers skip ask_name, so ask_bag_type may exceed ask_name — that is expected.\n');
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
