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

/**
 * A booking parked on its FINAL step — the optional "who served you" question.
 * That is where the ticket is now written, so that is where the double-tap
 * race lives. (It used to be the store picker; the salesperson step was added
 * after it, and the in-flight lock moved with the write.)
 */
function bookingSession(phone) {
  return {
    phone,
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_salesperson',
    collectedData: {
      name: 'Ravi', bagType: 'Backpack',
      problem: 'Zip / Chain Issue', store: 'store_alkapuri',
    },
  };
}

/** A booking one step earlier, at the store picker. */
function beforeStoreSession(phone) {
  return {
    phone,
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_store',
    collectedData: { name: 'Ravi', bagType: 'Backpack', problem: 'Zip / Chain Issue' },
  };
}

test('two concurrent taps on the final step create exactly ONE ticket', async () => {
  created.length = 0; outbound.length = 0;
  const phone = '919777000101';

  // Both land before either has finished writing — the real double-tap.
  await Promise.all([
    handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone)),
    handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone)),
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
    handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone))));
  assert.strictEqual(created.length, 1, `got ${created.length} tickets from 3 taps`);
});

test('the lock is released, so a later legitimate booking still works', async () => {
  // Different phone, so the minutes-long anti-spam throttle does not apply.
  created.length = 0;
  const phone = '919777000103';
  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone));
  assert.strictEqual(created.length, 1, 'a normal single booking must still create its ticket');
});

test('the lock is per-phone — two different customers are not blocked', async () => {
  created.length = 0;
  const a = '919777000104';
  const b = '919777000105';
  await Promise.all([
    handleRepairFlow(a, 'btn_skip_staff', 'interactive', {}, bookingSession(a)),
    handleRepairFlow(b, 'btn_skip_staff', 'interactive', {}, bookingSession(b)),
  ]);
  assert.strictEqual(created.length, 2, 'two different customers must both get a ticket');
});

// ── Message volume ────────────────────────────────────────────
/**
 * Booking used to fire six notifications for one button tap: confirmation,
 * T&C reminder, contact block, opt-in question, then confirm + photo request.
 * The ticket id — the one thing worth keeping — scrolled away under the rest.
 * Nothing was removed; the same words are merged into fewer sends.
 */
test('finishing a booking costs at most 4 messages, not the original 6', async () => {
  process.env.REPAIR_UPDATE_TEMPLATE_EN = 'repair_status_update_en';
  const { handleRepairUpdatesAnswer } = require('../src/flows/repairUpdates');
  const phone = '919777000201';
  const count = () => {
    const n = outbound.filter((m) => m.to === phone).length;
    outbound.length = 0;
    return n;
  };

  outbound.length = 0;
  // Tap the store → the optional "who served you" question.
  await handleRepairFlow(phone, 'store_alkapuri', 'interactive', {}, beforeStoreSession(phone));
  const afterStore = count();

  // Skip it → merged confirmation + the updates question.
  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone));
  const afterSkip = count();

  await handleRepairUpdatesAnswer(phone, 'ru_yes', {
    phone, language: 'english', currentFlow: 'repair_updates',
    flowStep: 'ask_optin', collectedData: { ticketId: 'CHA-R-2026-0013' },
  });
  const afterYes = count();

  assert.strictEqual(afterStore, 1, `the staff question is one message, sent ${afterStore}`);
  assert.ok(afterSkip <= 2, `confirmation + opt-in is at most 2, sent ${afterSkip}`);
  assert.ok(afterYes <= 1, `answering the opt-in is at most 1, sent ${afterYes}`);
  // 4, not 3: the optional salesperson step deliberately costs one message.
  // Still well under the six this flow used to fire.
  assert.ok(afterStore + afterSkip + afterYes <= 4,
    `booking tail should be <=4, was ${afterStore + afterSkip + afterYes}`);
});

test('merging did not drop the ticket id, the T&C line, or the contacts', async () => {
  const phone = '919777000202';
  outbound.length = 0;
  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone));
  const confirmation = outbound.filter((m) => m.to === phone)[0].body;

  assert.match(confirmation, /CHA-[RS]-\d{4}-\d{4}/, 'ticket id must survive the merge');
  assert.ok(confirmation.includes('accept our Terms'), 'T&C acceptance line must survive');
  assert.ok(confirmation.includes('Vatsal Joshi'), 'store contacts must survive');
  assert.ok(confirmation.length < 4000, `must stay under the WhatsApp limit, was ${confirmation.length}`);
});

// ── Optional salesperson assignment ───────────────────────────
/**
 * Many tickets are raised at the counter with a staff member walking the
 * customer through it. Capturing who that was lets the work be assigned.
 *
 * Optional by design: most bookings are made from home with nobody serving
 * them, and those customers must not be blocked by a question that does not
 * apply. Anything unusable is treated as "no staff member" rather than
 * re-prompted — a booking is never held hostage to an optional field.
 */
function atStaffStep(phone) {
  return {
    phone,
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_salesperson',
    collectedData: {
      name: 'Aarav Shah', bagType: 'Backpack',
      problem: 'Zip / Chain Issue', store: 'store_alkapuri',
    },
  };
}

test('choosing a store now asks who is helping, with a one-tap Skip', async () => {
  outbound.length = 0;
  const phone = '919777000301';
  await handleRepairFlow(phone, 'store_alkapuri', 'interactive', {}, {
    phone, language: 'english', currentFlow: 'repair', flowStep: 'ask_store',
    collectedData: { name: 'Aarav', bagType: 'Backpack', problem: 'Zip / Chain Issue' },
  });
  const asked = outbound.filter((m) => m.to === phone);
  assert.strictEqual(asked.length, 1, 'exactly one prompt');
  assert.match(asked[0].body, /team member/i, 'should ask about a staff member');
});

test('a typed staff name is stored on the ticket', async () => {
  created.length = 0;
  const phone = '919777000302';
  await handleRepairFlow(phone, 'Rahul Patel', 'text', {}, atStaffStep(phone));
  assert.strictEqual(created.length, 1, 'the ticket must still be created');
  assert.strictEqual(created[0].servedBy, 'Rahul Patel');
});

test('Skip books the ticket with no one assigned', async () => {
  created.length = 0;
  const phone = '919777000303';
  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, atStaffStep(phone));
  assert.strictEqual(created.length, 1, 'skipping must not block the booking');
  assert.strictEqual(created[0].servedBy, '');
});

test('an emoji is not a salesperson', async () => {
  // A single emoji is a surrogate pair, so its .length is 2 and a plain
  // length check waves it straight through — this caught "👍" being filed as
  // the staff member during the walkthrough.
  const junkInputs = ['👍', '🙏🏽', '..', '123', 'R'];
  for (let i = 0; i < junkInputs.length; i++) {
    const junk = junkInputs[i];
    created.length = 0;
    // A distinct phone per case: two of these strings have the same .length,
    // and reusing a number trips the 10-minute anti-spam ticket throttle,
    // which looks exactly like the feature being broken.
    const phone = `9197770004${String(10 + i)}`;
    await handleRepairFlow(phone, junk, 'text', {}, atStaffStep(phone));
    assert.strictEqual(created.length, 1, `"${junk}" must still book the ticket`);
    assert.strictEqual(created[0].servedBy, '', `"${junk}" must not be stored as a name`);
  }
});

test('Devanagari and Gujarati staff names are accepted', async () => {
  const names = ['राहुल', 'રાહુલ'];
  for (let i = 0; i < names.length; i++) {
    created.length = 0;
    const phone = `9197770005${String(10 + i)}`;
    await handleRepairFlow(phone, names[i], 'text', {}, atStaffStep(phone));
    assert.strictEqual(created.length, 1, `"${names[i]}" must book a ticket`);
    assert.strictEqual(created[0].servedBy, names[i], `"${names[i]}" should be accepted`);
  }
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });
