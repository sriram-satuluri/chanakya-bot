/**
 * Per-phone flood control.
 *
 * The HTTP rate limiter in index.js keys on IP, and every inbound webhook
 * arrives from Meta's IPs — so it provides exactly zero protection against one
 * abusive customer. Before this cap, a single number could send hundreds of
 * messages a minute, earn a reply to each, and push the global outbound
 * circuit breaker (240/min) over its limit, at which point every OTHER
 * customer's reply and every owner alert was dropped as well.
 *
 * NOTE ON WHAT THESE ASSERT: the meaningful number is how many messages get
 * PAST THE THROTTLE, not how many replies go out. One accepted message can
 * produce several sends — "hi" shows the main menu, which is a button message
 * plus a list message — so asserting on reply count alone would happily pass
 * with twice as many messages accepted as intended. `markAsRead` is the
 * statement immediately after the throttle check and never runs for a rejected
 * message, so counting it counts accepted messages exactly.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-flood-'));
process.env.DATA_DIR = TMP;
process.env.NODE_ENV = 'test';
process.env.SKIP_WEBHOOK_SIGNATURE = '1';

const CAP = 20;
process.env.INBOUND_MAX_PER_PHONE_PER_MIN = String(CAP);

const wp = require.resolve('../src/services/whatsapp');
require(wp);

/** Messages that passed the throttle. */
let accepted = 0;
/** Outbound sends produced by those messages. */
let sends = 0;

require.cache[wp].exports.markAsRead = async () => { accepted += 1; return {}; };
for (const f of ['sendTextMessage', 'sendButtonMessage', 'sendListMessage']) {
  require.cache[wp].exports[f] = async () => { sends += 1; return {}; };
}

const sp = require.resolve('../src/services/sheets');
require(sp);
for (const k of ['logAnalytics', 'addOrUpdateContact', 'setCustomerName', 'setCustomerLanguage']) {
  require.cache[sp].exports[k] = async () => {};
}
require.cache[sp].exports.getCustomerLanguage = async () => 'english';
require.cache[sp].exports.getCustomerName = async () => null;

const { updateSession } = require('../src/utils/sessionStore');
const { handleWebhook } = require('../src/webhook/handler');

async function send(phone, body) {
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
        messages: [{ id: `wamid.${Math.random()}`, from: phone, type: 'text', text: { body } }],
      } }] }],
    },
  }, res);
}

function ready(phone) {
  updateSession(phone, {
    language: 'english', needsLanguagePick: false, greeted: true, lastActivity: Date.now(),
  });
}

function reset() { accepted = 0; sends = 0; }

// ── The exact number allowed through ──────────────────────────
test('exactly CAP messages pass the throttle, no matter how many are sent', async () => {
  const phone = '919555300001';
  ready(phone); reset();

  for (let i = 0; i < 100; i++) await send(phone, `spam ${i}`);

  assert.strictEqual(
    accepted, CAP,
    `exactly ${CAP} messages must pass the throttle out of 100, got ${accepted}`,
  );
});

test('the boundary is exact: message CAP is accepted, message CAP+1 is not', async () => {
  const phone = '919555300010';
  ready(phone); reset();

  for (let i = 0; i < CAP; i++) await send(phone, `msg ${i}`);
  assert.strictEqual(accepted, CAP, `all ${CAP} within the cap must be accepted`);

  await send(phone, 'one too many');
  assert.strictEqual(accepted, CAP, 'the message after the cap must be rejected');

  await send(phone, 'and another');
  assert.strictEqual(accepted, CAP, 'and it must stay rejected, not reset');
});

test('a rejected message produces no outbound send at all', async () => {
  const phone = '919555300011';
  ready(phone); reset();

  for (let i = 0; i < CAP; i++) await send(phone, `msg ${i}`);
  const sendsAtCap = sends;

  for (let i = 0; i < 25; i++) await send(phone, `over ${i}`);
  assert.strictEqual(
    sends, sendsAtCap,
    'messages past the cap must cost nothing — silently dropped, not answered',
  );
});

// ── It must not punish anyone else ────────────────────────────
test('a flooding number does not stop other customers being served', async () => {
  const abuser = '919555300002';
  const victim = '919555300003';
  ready(abuser); ready(victim); reset();

  for (let i = 0; i < 60; i++) await send(abuser, `spam ${i}`);
  assert.strictEqual(accepted, CAP, 'the abuser is capped');

  const acceptedBefore = accepted;
  await send(victim, 'hi');
  assert.strictEqual(
    accepted, acceptedBefore + 1,
    'an unrelated customer must be accepted normally while another floods',
  );
});

test('the cap is per-phone, so ordinary use is never throttled', async () => {
  const phone = '919555300004';
  ready(phone); reset();

  // A real booking is a handful of messages, far under the cap.
  const realConversation = ['hi', 'repair', 'Ravi', 'menu', 'track', 'menu'];
  for (const m of realConversation) await send(phone, m);

  assert.strictEqual(
    accepted, realConversation.length,
    'every message in an ordinary conversation must pass',
  );
  assert.ok(sends > 0, 'and it must still be answered');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });
