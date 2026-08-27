/**
 * Integration tests with Sheets/WhatsApp stubbed out.
 *
 * Covers the two behaviours that changed most recently and are hardest to
 * verify by hand: session survival across a restart, and the reordered
 * booking flow that creates the ticket BEFORE asking for a photo.
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolate all on-disk state to a temp dir before anything loads.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-test-'));
process.env.SESSION_CACHE_PATH = path.join(TMP, 'sessions.json');
process.env.DEDUP_CACHE_PATH = path.join(TMP, 'dedup.json');
process.env.THROTTLE_CACHE_PATH = path.join(TMP, 'throttles.json');
process.env.SKIP_WEBHOOK_SIGNATURE = '1';
process.env.NODE_ENV = 'test';

test('sessions survive a restart (was: every redeploy wiped in-progress bookings)', () => {
  const p = require.resolve('../src/utils/sessionStore');

  // First "process": get three questions into a booking.
  let store = require(p);
  store.updateSession('919999000001', {
    language: 'hindi',
    currentFlow: 'repair',
    flowStep: 'ask_problem',
    collectedData: { name: 'Ravi', bagType: 'Backpack' },
    lastActivity: Date.now(),
  });
  store._flushNow ? store._flushNow() : null;

  // Force the debounced write out, then simulate a restart.
  const raw = JSON.parse(fs.readFileSync(process.env.SESSION_CACHE_PATH, 'utf8'));
  assert.ok(raw['919999000001'], 'session should have been written to disk');

  delete require.cache[p];
  store = require(p);
  const restored = store.getSession('919999000001');

  assert.strictEqual(restored.flowStep, 'ask_problem', 'flow position survives restart');
  assert.strictEqual(restored.collectedData.name, 'Ravi', 'answers survive restart');
  assert.strictEqual(restored.language, 'hindi', 'language survives restart');
});

test('expired sessions are discarded on load, not resurrected', () => {
  const p = require.resolve('../src/utils/sessionStore');
  const THREE_HOURS_AGO = Date.now() - 3 * 60 * 60 * 1000;
  fs.writeFileSync(process.env.SESSION_CACHE_PATH, JSON.stringify({
    '919999000002': { phone: '919999000002', currentFlow: 'repair', flowStep: 'ask_name', lastActivity: THREE_HOURS_AGO },
  }), 'utf8');

  delete require.cache[p];
  const store = require(p);
  const s = store.getSession('919999000002');
  assert.strictEqual(s.currentFlow, null, 'stale flow must not be revived');
});

test('booking creates the ticket BEFORE the photo, so no photo means no lost booking', async () => {
  // Stub the outside world.
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => { sent.push(body); return {}; };
  require.cache[wp].exports.sendButtonMessage = async (to, body) => { sent.push(body); return {}; };
  require.cache[wp].exports.sendListMessage = async (to, h, body) => { sent.push(body); return {}; };

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  const created = [];
  require.cache[sp].exports.createRepairTicket = async (t) => { created.push(t); return 42; };
  require.cache[sp].exports.setRepairUpdatesOptIn = async () => 1;
  require.cache[sp].exports.getOpenTicketsForPhone = async () => [];

  const tid = require.resolve('../src/utils/ticketId');
  require(tid);
  require.cache[tid].exports.generateTicketId = async () => 'CHA-2026-0500';

  delete require.cache[require.resolve('../src/flows/repair')];
  const { handleRepairFlow } = require('../src/flows/repair');

  const session = {
    phone: '919999000003', language: 'english',
    currentFlow: 'repair', flowStep: 'ask_store',
    collectedData: { name: 'Ravi', bagType: 'Backpack', problem: 'Zip / Chain Issue' },
  };
  await handleRepairFlow('919999000003', 'store_alkapuri', 'text', {}, session);

  assert.strictEqual(created.length, 1, 'ticket created from four answers alone');
  assert.strictEqual(created[0].ticketId, 'CHA-2026-0500');
  assert.strictEqual(created[0].beforePhotoUrl, '', 'photo intentionally empty at creation');
  assert.ok(
    sent.some((m) => /Repair Request Confirmed/i.test(m || '')),
    'customer gets their confirmation without ever sending a photo',
  );
});

test('a late photo is filed against the right ticket', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => { sent.push(body); return {}; };
  require.cache[wp].exports.downloadMedia = async () => Buffer.from('fake-image');

  const cp = require.resolve('../src/services/cloudinary');
  require(cp);
  require.cache[cp].exports.uploadBuffer = async () => 'https://res.cloudinary.com/x/photo.jpg';

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  const attached = [];
  require.cache[sp].exports.findRecentTicketAwaitingPhoto = async () => ({
    ticketId: 'CHA-2026-0500', rowIndex: 42, store: 'Alkapuri (Race Course Road)', language: 'english',
  });
  require.cache[sp].exports.attachBeforePhoto = async (row, url) => { attached.push({ row, url }); return true; };

  delete require.cache[require.resolve('../src/flows/latePhoto')];
  const { handleLatePhoto } = require('../src/flows/latePhoto');

  const handled = await handleLatePhoto('919999000003', { image: { id: 'media-1' } }, 'english');

  assert.strictEqual(handled, true, 'the image is consumed, not left to fall through');
  assert.deepStrictEqual(attached, [{ row: 42, url: 'https://res.cloudinary.com/x/photo.jpg' }]);
  assert.ok(sent.some((m) => /CHA-2026-0500/.test(m || '')), 'customer is told which ticket it joined');
});

test('an image with no open ticket is answered, not silently swallowed', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => { sent.push(body); return {}; };

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  require.cache[sp].exports.findRecentTicketAwaitingPhoto = async () => null;

  delete require.cache[require.resolve('../src/flows/latePhoto')];
  const { handleLatePhoto } = require('../src/flows/latePhoto');

  const handled = await handleLatePhoto('919999000004', { image: { id: 'media-2' } }, 'english');
  assert.strictEqual(handled, true);
  assert.ok(sent.length === 1, 'customer gets an explanation rather than silence');
});

test('an image sent after booking is filed, NOT treated as "show me the menu"', async () => {
  // detectIntent maps an image with no active flow to 'main_menu', so this
  // used to restart the whole conversation. routeMessage must intercept the
  // image before that branch.
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => { sent.push(body); return {}; };
  require.cache[wp].exports.sendButtonMessage = async (to, body) => { sent.push(body); return {}; };
  require.cache[wp].exports.markAsRead = async () => ({});
  require.cache[wp].exports.downloadMedia = async () => Buffer.from('img');

  const cp = require.resolve('../src/services/cloudinary');
  require(cp);
  require.cache[cp].exports.uploadBuffer = async () => 'https://res.cloudinary.com/x/p.jpg';

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  const attached = [];
  require.cache[sp].exports.logAnalytics = async () => {};
  require.cache[sp].exports.getCustomerLanguage = async () => 'english';
  require.cache[sp].exports.addOrUpdateContact = async () => {};
  require.cache[sp].exports.hasOpenOptedInTicket = async () => false;
  require.cache[sp].exports.findRecentTicketAwaitingPhoto = async () => ({
    ticketId: 'CHA-2026-0777', rowIndex: 9, store: 'Alkapuri (Race Course Road)', language: 'english',
  });
  require.cache[sp].exports.attachBeforePhoto = async (row, url) => { attached.push({ row, url }); return true; };

  for (const k of Object.keys(require.cache)) {
    if (/chanakya-bot[\\/]src[\\/](webhook|flows)/.test(k)) delete require.cache[k];
  }
  const { handleWebhook } = require('../src/webhook/handler');

  await handleWebhook({
    headers: {}, rawBody: null,
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        messages: [{ id: 'wamid.IMG' + Date.now(), from: '919999000009', type: 'image', image: { id: 'media-9' } }],
        contacts: [{ profile: { name: 'T' } }],
      } }] }],
    },
  }, { sendStatus() {}, status() { return this; }, json() {}, send() {} });
  await new Promise((r) => setTimeout(r, 400));

  assert.strictEqual(attached.length, 1, 'photo filed against the awaiting ticket');
  assert.ok(
    !sent.some((m) => /Welcome to/i.test(m || '')),
    'the welcome/main menu must NOT be sent — that was the conversation restarting',
  );
});

test('brand-new number: first reply is the language picker, not the menu', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => {
    sent.push({ kind: 'text', body, buttons: [] }); return {};
  };
  require.cache[wp].exports.sendButtonMessage = async (to, body, buttons) => {
    sent.push({ kind: 'button', body, buttons: (buttons || []).map((b) => b.id) }); return {};
  };
  require.cache[wp].exports.markAsRead = async () => ({});

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  require.cache[sp].exports.logAnalytics = async () => {};
  require.cache[sp].exports.getCustomerLanguage = async () => null;
  require.cache[sp].exports.addOrUpdateContact = async () => {};

  for (const k of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](webhook|flows|utils[\\/]languagePref)/.test(k)) delete require.cache[k];
  }
  const { handleWebhook } = require('../src/webhook/handler');
  sent.length = 0;
  const phone = '919111000101';
  await handleWebhook({
    headers: {}, rawBody: null,
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        messages: [{ id: 'wamid.NEW' + Date.now(), from: phone, type: 'text', text: { body: 'hi' } }],
        contacts: [{ profile: { name: 'T' } }],
      } }] }],
    },
  }, { sendStatus() {}, status() { return this; }, json() {}, send() {} });
  await new Promise((r) => setTimeout(r, 250));

  assert.strictEqual(sent.length, 1, `expected 1 outbound, got ${sent.length}: ${JSON.stringify(sent)}`);
  assert.strictEqual(sent[0].kind, 'button');
  assert.deepStrictEqual(sent[0].buttons, ['lang_english', 'lang_hindi', 'lang_gujarati']);
  assert.ok(!sent[0].buttons.includes('btn_repair'), 'picker must arrive before the menu');
});

test('returning customer skips the name question and gets the bag-type list', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => {
    sent.push({ kind: 'text', body }); return {};
  };
  require.cache[wp].exports.sendListMessage = async (to, h, body, btn, sections) => {
    sent.push({ kind: 'list', body, sections }); return {};
  };
  require.cache[wp].exports.sendButtonMessage = async (to, body) => {
    sent.push({ kind: 'button', body }); return {};
  };

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  require.cache[sp].exports.getCustomerName = async () => 'Ravi';
  require.cache[sp].exports.setCustomerName = async () => {};

  delete require.cache[require.resolve('../src/flows/repair')];
  const { handleRepairFlow } = require('../src/flows/repair');

  await handleRepairFlow('919888000001', 'btn_repair', 'text', {}, { language: 'english' });

  assert.ok(
    !sent.some((m) => /may I know your \*name\*/i.test(m.body || '')),
    'must not ask a returning customer for their name',
  );
  assert.ok(
    sent.some((m) => /Welcome back, \*Ravi/i.test(m.body || '')),
    'should greet them by the stored name',
  );
  assert.ok(
    sent.some((m) => /What type of bag needs repair/i.test(m.body || '')),
    'should ask bag type as its own question',
  );
  const list = sent.find((m) => m.kind === 'list' && m.sections);
  const rowIds = (list?.sections || []).flatMap((s) => (s.rows || []).map((r) => r.id));
  assert.ok(rowIds.includes('bag_0'), 'bag-type list includes bag_0');
  assert.ok(!rowIds.some((id) => String(id).startsWith('combo_')), 'must not use the combined bag+issue list');
});

test('picking a bag type continues to the problem list', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => {
    sent.push({ kind: 'text', body }); return {};
  };
  require.cache[wp].exports.sendListMessage = async (to, h, body) => {
    sent.push({ kind: 'list', header: h, body }); return {};
  };
  require.cache[wp].exports.sendButtonMessage = async (to, body) => {
    sent.push({ kind: 'button', body }); return {};
  };

  delete require.cache[require.resolve('../src/flows/repair')];
  const { handleRepairFlow } = require('../src/flows/repair');
  const { getSession } = require('../src/utils/sessionStore');

  await handleRepairFlow('919888000002', 'bag_0', 'text', {}, {
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_bag_type',
    collectedData: { name: 'Ravi' },
  });

  assert.ok(
    sent.some((m) => /What's the problem/i.test(m.body || '')),
    'bag-type tap should ask the problem next',
  );
  assert.ok(
    !sent.some((m) => /Your Repairs/i.test((m.header || '') + (m.body || ''))),
    'must not jump to the track-repairs picker',
  );
  const s = getSession('919888000002');
  assert.strictEqual(s.flowStep, 'ask_problem');
  assert.strictEqual(s.collectedData.bagType, 'Trolley / Luggage Bag');
});

test('picking a problem continues to the store picker', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => {
    sent.push({ kind: 'text', body }); return {};
  };
  require.cache[wp].exports.sendListMessage = async (to, h, body) => {
    sent.push({ kind: 'list', body }); return {};
  };
  require.cache[wp].exports.sendButtonMessage = async (to, body) => {
    sent.push({ kind: 'button', body }); return {};
  };

  delete require.cache[require.resolve('../src/flows/repair')];
  const { handleRepairFlow } = require('../src/flows/repair');
  const { getSession } = require('../src/utils/sessionStore');

  await handleRepairFlow('919888000003', 'prob_0', 'text', {}, {
    language: 'english',
    currentFlow: 'repair',
    flowStep: 'ask_problem',
    collectedData: { name: 'Ravi', bagType: 'Trolley / Luggage Bag' },
  });

  assert.ok(
    sent.some((m) => m.kind === 'button' && /Almost done/i.test(m.body || '')),
    'problem tap should open the store picker',
  );
  const s = getSession('919888000003');
  assert.strictEqual(s.flowStep, 'ask_store');
  assert.strictEqual(s.collectedData.problem, 'Zip / Chain Issue');
});

test('throttles survive a process restart', () => {
  const p = require.resolve('../src/utils/throttleStore');
  delete require.cache[p];
  let store = require(p);
  const ts = Date.now() - 1000;
  store.setTimestamp('ticket', '919000000001', ts);
  store._flushNow();
  delete require.cache[p];
  store = require(p);
  assert.strictEqual(store.getTimestamp('ticket', '919000000001'), ts);
});

test('STOP on first contact is honoured before the language picker', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (_to, body) => {
    sent.push({ kind: 'text', body }); return {};
  };
  require.cache[wp].exports.sendButtonMessage = async (_to, body, buttons) => {
    sent.push({ kind: 'button', body, buttons: (buttons || []).map((b) => b.id) }); return {};
  };
  require.cache[wp].exports.markAsRead = async () => ({});

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  const opts = [];
  require.cache[sp].exports.logAnalytics = async () => {};
  require.cache[sp].exports.getCustomerLanguage = async () => null;
  require.cache[sp].exports.setContactOptIn = async (phone, optedIn) => { opts.push({ phone, optedIn }); };
  require.cache[sp].exports.hasOpenOptedInTicket = async () => false;
  require.cache[sp].exports.addOrUpdateContact = async () => {};

  for (const k of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](webhook|flows|utils[\\/]languagePref)/.test(k)) delete require.cache[k];
  }
  const { handleWebhook } = require('../src/webhook/handler');
  sent.length = 0;
  const phone = '919111000201';
  await handleWebhook({
    headers: {}, rawBody: null,
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        messages: [{ id: 'wamid.STOP' + Date.now(), from: phone, type: 'text', text: { body: 'STOP' } }],
        contacts: [{ profile: { name: 'T' } }],
      } }] }],
    },
  }, { sendStatus() {}, status() { return this; }, json() {}, send() {} });

  assert.deepStrictEqual(opts, [{ phone, optedIn: false }], 'STOP must persist marketing opt-out');
  assert.ok(
    sent.some((m) => m.kind === 'text' && /won.?t receive promotional/i.test(m.body || '')),
    'customer gets the opt-out confirmation, not the picker',
  );
  assert.ok(
    !sent.some((m) => (m.buttons || []).includes('lang_english')),
    'language picker must not swallow a first-contact STOP',
  );
});

test('corporate lead is not confirmed, notified, or throttled when createLead fails', async () => {
  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  const sent = [];
  require.cache[wp].exports.sendTextMessage = async (to, body) => {
    sent.push({ to, body }); return {};
  };
  require.cache[wp].exports.sendButtonMessage = async (to, body) => {
    sent.push({ to, body, kind: 'button' }); return {};
  };

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  require.cache[sp].exports.createLead = async () => { throw new Error('sheets down'); };

  const op = require.resolve('../src/utils/ownerPhones');
  require(op);
  require.cache[op].exports.getRecipientsForCorporate = () => ['919000099999'];

  delete require.cache[require.resolve('../src/flows/corporate')];
  const { handleCorporateFlow } = require('../src/flows/corporate');
  const { getTimestamp } = require('../src/utils/throttleStore');
  const { getSession, updateSession } = require('../src/utils/sessionStore');

  const phone = '919111000202';
  const session = {
    language: 'english',
    currentFlow: 'corporate',
    flowStep: 'ask_branding',
    collectedData: { company: 'Acme', name: 'Ravi', productType: 'Bags', quantity: '100' },
  };
  updateSession(phone, { ...session, lastActivity: Date.now() });

  await handleCorporateFlow(phone, 'logo on the flap', session);

  assert.ok(
    sent.some((m) => /technical issue saving your enquiry/i.test(m.body || '')),
    'customer is told the enquiry was not saved',
  );
  assert.ok(!sent.some((m) => /Enquiry Received/i.test(m.body || '')), 'must not confirm a failed write');
  assert.ok(!sent.some((m) => m.to === '919000099999'), 'owners must not be pinged');
  assert.strictEqual(getTimestamp('lead', phone), 0, 'failed write must not start the throttle window');
  assert.strictEqual(getSession(phone).flowStep, 'ask_branding', 'session stays on branding so they can retry');
});

test('webhook does not ACK until processing has finished, even if processing throws', async () => {
  const events = [];
  const ss = require.resolve('../src/utils/sessionStore');
  require(ss);
  const origGet = require.cache[ss].exports.getSession;
  require.cache[ss].exports.getSession = (phone) => {
    if (phone === '919111000303') {
      events.push('process');
      throw new Error('boom');
    }
    return origGet(phone);
  };

  const wp = require.resolve('../src/services/whatsapp');
  require(wp);
  require.cache[wp].exports.markAsRead = async () => ({});

  const sp = require.resolve('../src/services/sheets');
  require(sp);
  require.cache[sp].exports.logAnalytics = async () => {};
  require.cache[sp].exports.getCustomerLanguage = async () => null;

  for (const k of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](webhook|flows|utils[\\/]languagePref)/.test(k)) delete require.cache[k];
  }
  const { handleWebhook } = require('../src/webhook/handler');

  const res = {
    headersSent: false,
    sendStatus() { events.push('ack'); this.headersSent = true; },
    status() { return this; },
    json() {},
    send() {},
  };
  try {
    await handleWebhook({
      headers: {}, rawBody: null,
      body: {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: {
          messages: [{ id: 'wamid.BOOM' + Date.now(), from: '919111000303', type: 'text', text: { body: 'hi' } }],
          contacts: [{ profile: { name: 'T' } }],
        } }] }],
      },
    }, res);
  } finally {
    require.cache[ss].exports.getSession = origGet;
  }

  assert.deepStrictEqual(events, ['process', 'ack'], 'ACK must not precede processing (old bug: 200 then work)');
});


test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ } });
