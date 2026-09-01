/**
 * The gates a customer must get past to be served — and the ways out of them.
 *
 * These live in their own file on purpose. They need a clean module cache: the
 * flow modules destructure the WhatsApp senders at load time, so a harness has
 * to stub those senders BEFORE requiring the flows. Sharing a file with other
 * suites meant an earlier test's handler stayed live holding an earlier test's
 * stubs, and everything here silently captured nothing.
 *
 * Every case below is a bug that reached a real customer path:
 *   - the first-contact language picker could not be escaped by typing
 *   - typing your language did nothing when it matched the auto-guess
 *   - "talk to a person" was swallowed by store_location and repair_updates
 *   - Change Language and Terms were handled but unreachable
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Isolate all on-disk state before anything loads.
// Uses the modern single DATA_DIR. test/integration.test.js deliberately still
// uses the legacy per-file vars, so both resolution paths stay covered.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-gates-'));
process.env.DATA_DIR = TMP;
process.env.SKIP_WEBHOOK_SIGNATURE = '1';
process.env.NODE_ENV = 'test';
process.env.OWNER_PHONE_GATETEST = '919000000001';
// Keep the handoff branch lookup from adding a real timeout to every escalation.
process.env.HANDOFF_BRANCH_LOOKUP_MS = '0';

// ── Harness: stub the outside world, THEN load the router ─────
const wp = require.resolve('../src/services/whatsapp');
require(wp);
const outbound = [];
require.cache[wp].exports.markAsRead = async () => ({});
require.cache[wp].exports.sendTextMessage = async (to, body) => {
  outbound.push({ kind: 'text', to, body: String(body) }); return {};
};
require.cache[wp].exports.sendButtonMessage = async (to, body, buttons) => {
  outbound.push({ kind: 'buttons', to, body: String(body), ids: (buttons || []).map((b) => b.id) }); return {};
};
require.cache[wp].exports.sendListMessage = async (to, header, body, label, sections) => {
  const ids = (sections && sections[0] ? sections[0].rows : []).map((r) => r.id);
  outbound.push({ kind: 'list', to, body: String(body), ids }); return {};
};

const sp = require.resolve('../src/services/sheets');
require(sp);
for (const k of ['logAnalytics', 'setCustomerLanguage', 'addOrUpdateContact',
  'setContactOptIn', 'setCustomerName', 'setRepairUpdatesOptIn']) {
  require.cache[sp].exports[k] = async () => {};
}
require.cache[sp].exports.getCustomerLanguage = async () => null;
require.cache[sp].exports.getCustomerName = async () => null;
require.cache[sp].exports.getOpenTicketsForPhone = async () => [];
require.cache[sp].exports.hasOpenOptedInTicket = async () => false;

const { handleWebhook } = require('../src/webhook/handler');
const { updateSession, getSession } = require('../src/utils/sessionStore');
const { detectIntent } = require('../src/utils/intentDetect');

/** Deliver one inbound text message and return everything the bot sent back. */
async function send(phone, body) {
  outbound.length = 0;
  const res = {
    headersSent: false,
    sendStatus() { this.headersSent = true; },
    status() { return this; }, json() {}, send() {},
  };
  await handleWebhook({
    headers: {}, rawBody: null,
    body: {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: {
        messages: [{ id: `wamid.${phone}.${Date.now()}.${Math.random()}`, from: phone, type: 'text', text: { body } }],
      } }] }],
    },
  }, res);
  await new Promise((r) => setTimeout(r, 40));
  return outbound.slice();
}

const allIds = (sent) => sent.flatMap((m) => m.ids || []);
const allText = (sent) => sent.map((m) => m.body).join(' | ');

// ── The language gate ─────────────────────────────────────────
test('first contact is still offered the language picker', async () => {
  const sent = await send('919444000001', 'hello');
  assert.deepStrictEqual(allIds(sent), ['lang_english', 'lang_hindi', 'lang_gujarati']);
});

test('asking for a human on first contact escapes the picker', async () => {
  const phone = '919444000002';
  await send(phone, 'hello');
  const sent = await send(phone, 'talk to a person');
  assert.ok(allText(sent).includes('Connecting you'), 'handoff must outrank the language question');
  assert.ok(!allIds(sent).includes('lang_english'), 'must not re-send the picker instead of a human');
});

test('typing a language name answers the picker even when it matches the auto-guess', async () => {
  const phone = '919444000003';
  await send(phone, 'hi');
  // Provisional detection already guessed english for Latin script, so the old
  // `langOverride !== session.language` guard discarded this answer silently
  // and asked again — answering correctly looked exactly like being ignored.
  const sent = await send(phone, 'English');
  assert.ok(!allIds(sent).includes('lang_english'), 'picker must not be re-sent after a correct typed answer');
  assert.ok(allIds(sent).includes('btn_repair'), 'should land on the main menu');
  assert.ok(!allText(sent).includes("didn't quite get that"), 'a correct answer must not be met with an apology');
});

test('the picker gives up after two unanswered sends rather than looping forever', async () => {
  const phone = '919444000004';
  assert.ok(allIds(await send(phone, 'zzz')).includes('lang_english'), 'ask 1');
  assert.ok(allIds(await send(phone, 'zzz')).includes('lang_english'), 'ask 2');
  const third = await send(phone, 'zzz');
  assert.ok(!allIds(third).includes('lang_english'), 'must stop asking');
  assert.ok(allIds(third).includes('btn_repair'), 'and let them into the menu anyway');
});

test('tapping a language button still works', async () => {
  const phone = '919444000005';
  await send(phone, 'hi');
  const sent = await send(phone, 'lang_hindi');
  assert.ok(allIds(sent).includes('btn_repair'), 'a tap should go straight to the menu');
});

// ── Escape hatches inside flows ───────────────────────────────
test('a handoff request is not swallowed by the store-locations flow', async () => {
  const phone = '919444000006';
  updateSession(phone, {
    language: 'english', needsLanguagePick: false,
    currentFlow: 'store_location', flowStep: 'pick_store', lastActivity: Date.now(),
  });
  const sent = await send(phone, 'talk to a person');
  assert.ok(allText(sent).includes('Connecting you'), 'must hand off, not re-send the store picker');
  assert.ok(!allIds(sent).includes('btn_dir_alkapuri'), 'must not re-send the store picker');
});

test('a handoff at the updates opt-in question hands off without recording a decline', async () => {
  const phone = '919444000007';
  updateSession(phone, {
    language: 'english', needsLanguagePick: false,
    currentFlow: 'repair_updates', flowStep: 'ask_optin',
    collectedData: { ticketId: 'CHA-S-2026-0001' }, lastActivity: Date.now(),
  });
  const sent = await send(phone, 'talk to a person');
  assert.ok(allText(sent).includes('Connecting you'), 'must hand off');
  // The old behaviour read this as "no thanks", recorded it as their consent
  // decision, and moved on to the photo request.
  assert.ok(!allText(sent).toLowerCase().includes('photo'), 'must not fall through to the photo request');
});

// ── Menu reachability ─────────────────────────────────────────
test('the menu exposes Change Language and Terms without typing', async () => {
  const phone = '919444000008';
  updateSession(phone, { language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now() });
  const ids = allIds(await send(phone, 'menu'));
  assert.ok(ids.includes('btn_language'), 'Change Language must be tappable');
  assert.ok(ids.includes('btn_terms'), 'Terms must be tappable');
});

// ── Fallback quality ──────────────────────────────────────────
test('two unresolved messages lead with Talk to a Person, not a third apology', async () => {
  const phone = '919444000009';
  updateSession(phone, { language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now() });

  const first = await send(phone, 'qqzz1');
  assert.ok(allText(first).includes("didn't quite get that"), 'first miss is a gentle re-prompt');
  // …and must NOT replay the full welcome at someone mid-conversation.
  assert.ok(!allText(first).includes('since 1996'), 'must not re-greet a customer already in conversation');

  const second = await send(phone, 'qqzz2');
  assert.deepStrictEqual(allIds(second), ['btn_human', 'btn_main_menu'],
    'second miss offers a human first');
});

// ── The SAME trap, reached the other way ──────────────────────
/**
 * A returning customer who taps 🌐 Change Language sits in
 * currentFlow === 'language' with needsLanguagePick FALSE. The first version
 * of the escape hatches keyed on needsLanguagePick alone, so this path
 * inherited neither release and looped forever — the original blocker,
 * relocated onto a row that is now one tap away on every menu.
 */
test('Change Language is escapable by a returning customer', async () => {
  const phone = '919444000010';
  updateSession(phone, { language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now() });

  assert.ok(allIds(await send(phone, 'btn_language')).includes('lang_english'), 'picker should open');
  assert.ok(allIds(await send(phone, 'qwerty')).includes('lang_english'), 'unrecognised input re-asks once');

  const out = await send(phone, 'talk to a person');
  assert.ok(allText(out).includes('Connecting you'), 'handoff must escape the change-language picker too');
  assert.ok(!allIds(out).includes('lang_english'), 'must not re-send the picker instead of a human');
});

test('Change Language also gives up after two unanswered asks', async () => {
  const phone = '919444000011';
  updateSession(phone, { language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now() });

  await send(phone, 'btn_language');
  assert.ok(allIds(await send(phone, 'aaa')).includes('lang_english'), 'ask 1');
  assert.ok(allIds(await send(phone, 'bbb')).includes('lang_english'), 'ask 2');
  const third = await send(phone, 'ccc');
  assert.ok(!allIds(third).includes('lang_english'), 'must stop asking');
  assert.ok(allIds(third).includes('btn_repair'), 'and return them to the menu');
});

test('typing a language at the Change Language picker lands on the menu, not an apology', async () => {
  const phone = '919444000013';
  updateSession(phone, { language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now() });
  await send(phone, 'btn_language');
  const out = await send(phone, 'Hindi');
  assert.ok(!allText(out).includes("didn't quite get that"), 'a correct typed answer must not be met with an apology');
  assert.ok(allIds(out).includes('btn_repair'), 'should land on the menu');
  // The welcome BODY (not the button titles, which this harness doesn't capture)
  // must have switched language.
  assert.ok(allText(out).includes('स्वागत'), 'and the menu body should be in Hindi');
});

test('Change Language still works when it is actually answered', async () => {
  const phone = '919444000012';
  updateSession(phone, { language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now() });
  await send(phone, 'btn_language');
  const out = await send(phone, 'lang_hindi');
  assert.ok(allIds(out).includes('btn_repair'), 'should land on the menu');
  assert.ok(allText(out).includes('हिंदी'), 'and the menu should be in the newly chosen language');
});

// ── Waiting on a human ────────────────────────────────────────
/**
 * Found by walking the bot as a frustrated customer: after asking for a
 * person, saying "still there? hello?" replayed the entire welcome block —
 * "Welcome to Chanakya, Vadodara's #1 Bag Store since 1996" — at someone
 * mid-handoff. The paused state WAS being read, but only to auto-resume, and
 * that check sat BELOW the main_menu branch, which a typed greeting hits
 * first. Order matters here as much as the check itself.
 */
async function intoHandoff(phone) {
  updateSession(phone, {
    language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now(),
  });
  await send(phone, 'talk to a person');
}

test('checking in while waiting for a human is reassured, not re-onboarded', async () => {
  const phone = '919444000020';
  await intoHandoff(phone);

  for (const probe of ['still there? hello?', 'any update', 'asdkjh']) {
    const out = await send(phone, probe);
    const text = allText(out);
    assert.ok(text.includes('queue for a team member'), `"${probe}" should reassure`);
    assert.ok(!text.includes('since 1996'), `"${probe}" must not replay the full welcome`);
    assert.strictEqual(allIds(out).length, 0, 'and must not re-show the menu buttons');
  }
});

test('a deliberate action still takes you out of the handoff queue', async () => {
  const a = '919444000021';
  await intoHandoff(a);
  const repair = await send(a, 'btn_repair');
  assert.ok(allText(repair).includes('name'), 'tapping Repair must start the booking');

  const b = '919444000022';
  await intoHandoff(b);
  const menu = await send(b, 'btn_main_menu');
  assert.ok(allIds(menu).includes('btn_repair'), 'tapping Main Menu must show the menu');

  const c = '919444000023';
  await intoHandoff(c);
  const track = await send(c, 'track');
  assert.ok(!allText(track).includes('queue for a team member'), 'typing "track" must resume');
});

// ── Store direction buttons ───────────────────────────────────
/**
 * These two buttons were matched only while the store flow sat on its
 * 'pick_store' step — but that flow calls clearSession() the moment it
 * answers, so the very next tap arrived with no flow at all and fell through
 * to "It seems I'm having trouble understanding". A button the bot itself
 * sent, one message earlier.
 *
 * WhatsApp buttons stay tappable in the chat history forever, so a direction
 * tap has to work from any state, at any time.
 */
const CONFUSED = /trouble understanding|didn't quite get/;

test('tapping the SAME store twice works both times', async () => {
  const phone = '919444000030';
  updateSession(phone, {
    language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now(),
  });
  await send(phone, 'btn_location');

  const first = await send(phone, 'btn_dir_alkapuri');
  assert.ok(allText(first).includes('Alkapuri'), 'first tap should show Alkapuri');

  const second = await send(phone, 'btn_dir_alkapuri');
  assert.ok(!CONFUSED.test(allText(second)), 'a repeat tap must not fall back');
  assert.ok(allText(second).includes('Alkapuri'), 'and must show Alkapuri again');
});

test('tapping the OTHER store right after works too', async () => {
  const phone = '919444000031';
  updateSession(phone, {
    language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now(),
  });
  await send(phone, 'btn_location');
  await send(phone, 'btn_dir_alkapuri');

  const other = await send(phone, 'btn_dir_sursagar');
  assert.ok(!CONFUSED.test(allText(other)), 'the other store must not fall back');
  assert.ok(allText(other).includes('Sursagar'), 'and must show Sursagar');
});

test('a direction tap mid-booking answers WITHOUT losing the booking', async () => {
  const phone = '919444000032';
  const booking = {
    language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now(),
    currentFlow: 'repair', flowStep: 'ask_problem',
    collectedData: { name: 'Meera', bagType: 'Backpack' },
  };
  updateSession(phone, booking);

  const out = await send(phone, 'btn_dir_sursagar');
  assert.ok(!CONFUSED.test(allText(out)), 'must be understood mid-flow');
  assert.ok(allText(out).includes('Sursagar'), 'must show the store info');

  // The whole point: the half-finished booking is untouched.
  const s = getSession(phone);
  assert.strictEqual(s.currentFlow, 'repair', 'flow must survive');
  assert.strictEqual(s.flowStep, 'ask_problem', 'step must survive');
  assert.deepStrictEqual(s.collectedData, { name: 'Meera', bagType: 'Backpack' },
    'answers already given must survive');

  // …and the customer can carry straight on.
  const resumed = await send(phone, 'prob_0');
  assert.ok(allIds(resumed).length > 0, 'the booking must continue normally');
});

test('a direction tap resolves as a real intent, from no session at all', () => {
  // The router-level guarantee, independent of any flow.
  assert.strictEqual(detectIntent('btn_dir_alkapuri', { phone: null }), 'store_location');
  assert.strictEqual(detectIntent('btn_dir_sursagar', { phone: null }), 'store_location');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ } });
