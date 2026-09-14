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
require.cache[wp].exports.sendButtonMessage = async (to, body, buttons) => {
  outbound.push({
    to,
    body: String(body),
    buttons: (buttons || []).map((b) => b.id),
  });
  return {};
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
const { getSession } = require('../src/utils/sessionStore');

/**
 * Parked on the optional "who served you" question. Answering this now asks
 * for a photo; the ticket is written on the photo skip/send.
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

function photoSession(phone, extra = {}) {
  return {
    phone,
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_photo',
    collectedData: {
      name: 'Ravi', bagType: 'Backpack',
      problem: 'Zip / Chain Issue', store: 'store_alkapuri',
      servedBy: extra.servedBy || '',
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

test('two concurrent taps on the photo skip create exactly ONE ticket', async () => {
  created.length = 0; outbound.length = 0;
  const phone = '919777000101';

  await Promise.all([
    handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone)),
    handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone)),
  ]);

  assert.strictEqual(
    created.length, 1,
    `exactly one ticket must be created, got ${created.length}: `
    + JSON.stringify(created.map((c) => c.ticketId)),
  );
  const withTicketId = outbound.filter(
    (m) => m.to === phone && /CHA-[RS]-\d{4}-\d{4}/.test(m.body));
  const distinctIds = new Set(
    withTicketId.map((m) => m.body.match(/CHA-[RS]-\d{4}-\d{4}/)[0]));
  assert.strictEqual(
    distinctIds.size, 1,
    `customer must hear about exactly one ticket id, heard: ${[...distinctIds].join(', ')}`);
});

test('three simultaneous photo-skips still create exactly one ticket', async () => {
  created.length = 0; outbound.length = 0;
  const phone = '919777000102';
  await Promise.all([1, 2, 3].map(() =>
    handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone))));
  assert.strictEqual(created.length, 1, `got ${created.length} tickets from 3 taps`);
});

test('the lock is released, so a later legitimate booking still works', async () => {
  created.length = 0;
  const phone = '919777000103';
  await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone));
  assert.strictEqual(created.length, 1, 'a normal single booking must still create its ticket');
});

test('the lock is per-phone — two different customers are not blocked', async () => {
  created.length = 0;
  const a = '919777000104';
  const b = '919777000105';
  await Promise.all([
    handleRepairFlow(a, 'btn_skip_photo', 'interactive', {}, photoSession(a)),
    handleRepairFlow(b, 'btn_skip_photo', 'interactive', {}, photoSession(b)),
  ]);
  assert.strictEqual(created.length, 2, 'two different customers must both get a ticket');
});

test('skipping staff does not create a ticket — it asks for a photo', async () => {
  created.length = 0; outbound.length = 0;
  const phone = '919777000106';
  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone));
  assert.strictEqual(created.length, 0, 'ticket waits for the photo step');
  const asked = outbound.filter((m) => m.to === phone);
  assert.ok(asked.some((m) => /take a photo/i.test(m.body)), 'photo prompt after staff');
  assert.ok(asked.some((m) => (m.buttons || []).includes('btn_skip_photo')), 'Upload later is tappable');
  assert.ok(asked.some((m) => (m.buttons || []).includes('btn_take_photo')), 'Take photo is tappable');
});

// ── Message volume ────────────────────────────────────────────
test('finishing a booking stays a short tail, not the original 6', async () => {
  process.env.REPAIR_UPDATE_TEMPLATE_EN = 'repair_status_update_en';
  const { handleRepairUpdatesAnswer } = require('../src/flows/repairUpdates');
  const phone = '919777000201';
  const count = () => {
    const n = outbound.filter((m) => m.to === phone).length;
    outbound.length = 0;
    return n;
  };

  outbound.length = 0;
  await handleRepairFlow(phone, 'store_alkapuri', 'interactive', {}, beforeStoreSession(phone));
  const afterStore = count();

  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, bookingSession(phone));
  const afterStaff = count();

  await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone));
  const afterPhoto = count();

  await handleRepairUpdatesAnswer(phone, 'ru_yes', {
    phone, language: 'english', currentFlow: 'repair_updates',
    flowStep: 'ask_optin', collectedData: { ticketId: 'CHA-R-2026-0013' },
  });
  const afterYes = count();

  assert.strictEqual(afterStore, 1, `the staff question is one message, sent ${afterStore}`);
  assert.strictEqual(afterStaff, 1, `the photo question is one message, sent ${afterStaff}`);
  assert.ok(afterPhoto <= 2, `confirmation + reminders is at most 2, sent ${afterPhoto}`);
  assert.ok(afterYes <= 1, `answering reminders is at most 1, sent ${afterYes}`);
  assert.ok(afterStore + afterStaff + afterPhoto + afterYes <= 5,
    `booking tail should be <=5, was ${afterStore + afterStaff + afterPhoto + afterYes}`);
});

test('merging did not drop the ticket id, the T&C line, or the store numbers', async () => {
  const phone = '919777000202';
  outbound.length = 0;
  await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone));
  const confirmation = outbound.filter((m) => m.to === phone)[0].body;

  assert.match(confirmation, /CHA-[RS]-\d{4}-\d{4}/, 'ticket id must survive the merge');
  assert.ok(confirmation.includes('accept our Terms'), 'T&C acceptance line must survive');
  assert.ok(confirmation.includes('+91 99740 17723'), 'Alkapuri store number first');
  assert.ok(confirmation.includes('+91 70483 82178'), 'shared customer-care line');
  assert.ok(!confirmation.includes('Vatsal Joshi'), 'named directory is not on the ticket');
  assert.ok(confirmation.length < 4000, `must stay under the WhatsApp limit, was ${confirmation.length}`);
});

// ── Optional salesperson assignment ───────────────────────────
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

test('a typed staff name is remembered, then skip-photo writes it on the ticket', async () => {
  created.length = 0;
  const phone = '919777000302';
  await handleRepairFlow(phone, 'Rahul Patel', 'text', {}, atStaffStep(phone));
  assert.strictEqual(created.length, 0, 'ticket waits for the photo question');
  const parked = getSession(phone);
  assert.strictEqual(parked.flowStep, 'ask_photo');
  assert.strictEqual(parked.collectedData.servedBy, 'Rahul Patel');

  await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone, { servedBy: 'Rahul Patel' }));
  assert.strictEqual(created.length, 1, 'the ticket must still be created');
  assert.strictEqual(created[0].servedBy, 'Rahul Patel');
});

test('Skip staff then Skip photo books the ticket with no one assigned', async () => {
  created.length = 0;
  const phone = '919777000303';
  await handleRepairFlow(phone, 'btn_skip_staff', 'interactive', {}, atStaffStep(phone));
  assert.strictEqual(created.length, 0);
  await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone));
  assert.strictEqual(created.length, 1, 'skipping must not block the booking');
  assert.strictEqual(created[0].servedBy, '');
  assert.strictEqual(created[0].beforePhotoUrl, '');
});

test('an emoji is not a salesperson', async () => {
  const junkInputs = ['👍', '🙏🏽', '..', '123', 'R'];
  for (let i = 0; i < junkInputs.length; i++) {
    const junk = junkInputs[i];
    created.length = 0;
    const phone = `9197770004${String(10 + i)}`;
    await handleRepairFlow(phone, junk, 'text', {}, atStaffStep(phone));
    assert.strictEqual(created.length, 0, `"${junk}" must not book yet`);
    await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone));
    assert.strictEqual(created.length, 1, `"${junk}" must still book the ticket after skip-photo`);
    assert.strictEqual(created[0].servedBy, '', `"${junk}" must not be stored as a name`);
  }
});

test('Devanagari and Gujarati staff names are accepted', async () => {
  const names = ['राहुल', 'રાહુલ'];
  for (let i = 0; i < names.length; i++) {
    created.length = 0;
    const phone = `9197770005${String(10 + i)}`;
    await handleRepairFlow(phone, names[i], 'text', {}, atStaffStep(phone));
    assert.strictEqual(getSession(phone).collectedData.servedBy, names[i], `"${names[i]}" should be accepted`);
    await handleRepairFlow(phone, 'btn_skip_photo', 'interactive', {}, photoSession(phone, { servedBy: names[i] }));
    assert.strictEqual(created.length, 1, `"${names[i]}" must book a ticket`);
    assert.strictEqual(created[0].servedBy, names[i], `"${names[i]}" should land on the ticket`);
  }
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });

