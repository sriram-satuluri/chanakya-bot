/**
 * Two things happening at once for the same customer.
 *
 * WhatsApp buttons are tappable more than once, and Meta can deliver two
 * events milliseconds apart. The booking step used to read the anti-spam
 * throttle, then `await` twice (mint an id, write the row), then write the
 * throttle — a check-then-act pair with a wide window. Two taps both passed
 * the check and both created a ticket: different ids, two owner alerts, two
 * sheet rows that did not even look like duplicates.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-conc-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';
process.env.SKIP_WEBHOOK_SIGNATURE = '1';
process.env.OWNER_PHONE_CONC = '919000000001';

// ── Stub the outside world before the flows bind to it ────────
const wp = require.resolve('../src/services/whatsapp');
require(wp);
const outbound = [];
require.cache[wp].exports.markAsRead = async () => ({});
require.cache[wp].exports.sendTextMessage = async (to, body) => {
  outbound.push({ to, body: String(body) }); return {};
};
require.cache[wp].exports.sendButtonMessage = async (to, body) => {
  outbound.push({ to, body: String(body) }); return {};
};
require.cache[wp].exports.sendListMessage = async (to, h, body) => {
  outbound.push({ to, body: String(body) }); return {};
};

const sp = require.resolve('../src/services/sheets');
require(sp);
const created = [];
require.cache[sp].exports.createRepairTicket = async (t) => {
  // A real Sheets write takes tens of milliseconds. Without a delay here the
  // two calls would not actually overlap and the test would pass even with the
  // lock removed — the delay is what makes this a genuine race.
  await new Promise((r) => setTimeout(r, 25));
  created.push(t);
  return created.length + 1;
};
require.cache[sp].exports.setCustomerName = async () => {};
require.cache[sp].exports.setRepairUpdatesOptIn = async () => {};
require.cache[sp].exports.getOpenTicketsForPhone = async () => [];
require.cache[sp].exports.logAnalytics = async () => {};

const tid = require.resolve('../src/utils/ticketId');
require(tid);
let seq = 0;
require.cache[tid].exports.generateTicketId = async () => {
  await new Promise((r) => setTimeout(r, 5));
  seq += 1;
  return `CHA-R-2026-${String(seq).padStart(4, '0')}`;
};

for (const k of Object.keys(require.cache)) {
  if (/[\\/]src[\\/]flows/.test(k)) delete require.cache[k];
}
const { handleRepairFlow } = require('../src/flows/repair');

function bookingSession(phone) {
  return {
    phone,
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_store',
    collectedData: { name: 'Ravi', bagType: 'Backpack', problem: 'Zip / Chain Issue' },
  };
}

test('two concurrent store taps create exactly ONE ticket', async () => {
  created.length = 0; outbound.length = 0;
  const phone = '919777000101';

  // Both land before either has finished writing — the real double-tap.
  await Promise.all([
    handleRepairFlow(phone, 'store_alkapuri', 'interactive', {}, bookingSession(phone)),
    handleRepairFlow(phone, 'store_alkapuri', 'interactive', {}, bookingSession(phone)),
  ]);

  assert.strictEqual(
    created.length, 1,
    `exactly one ticket must be created, got ${created.length}: `
    + JSON.stringify(created.map((c) => c.ticketId)),
  );
  // And the customer must not be told about two tickets. Match on a real
  // ticket id — a single successful booking legitimately sends several
  // messages mentioning the word "ticket" (confirmation, T&C reminder,
  // store contacts), so counting those would prove nothing.
  const withTicketId = outbound.filter(
    (m) => m.to === phone && /CHA-[RS]-\d{4}-\d{4}/.test(m.body));
  const distinctIds = new Set(
    withTicketId.map((m) => m.body.match(/CHA-[RS]-\d{4}-\d{4}/)[0]));
  assert.strictEqual(
    distinctIds.size, 1,
    `customer must hear about exactly one ticket id, heard: ${[...distinctIds].join(', ')}`);
});

test('three simultaneous taps still create exactly one ticket', async () => {
  created.length = 0; outbound.length = 0;
  const phone = '919777000102';
  await Promise.all([1, 2, 3].map(() =>
    handleRepairFlow(phone, 'store_sursagar', 'interactive', {}, bookingSession(phone))));
  assert.strictEqual(created.length, 1, `got ${created.length} tickets from 3 taps`);
});

test('the lock is released, so a later legitimate booking still works', async () => {
  // Different phone, so the minutes-long anti-spam throttle does not apply.
  created.length = 0;
  const phone = '919777000103';
  await handleRepairFlow(phone, 'store_alkapuri', 'interactive', {}, bookingSession(phone));
  assert.strictEqual(created.length, 1, 'a normal single booking must still create its ticket');
});

test('the lock is per-phone — two different customers are not blocked', async () => {
  created.length = 0;
  const a = '919777000104';
  const b = '919777000105';
  await Promise.all([
    handleRepairFlow(a, 'store_alkapuri', 'interactive', {}, bookingSession(a)),
    handleRepairFlow(b, 'store_sursagar', 'interactive', {}, bookingSession(b)),
  ]);
  assert.strictEqual(created.length, 2, 'two different customers must both get a ticket');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });
