/**
 * Regression tests for the pure logic — no network, no Sheets, no WhatsApp.
 *
 * Every case here is a bug that was actually found and fixed during the audit.
 * They exist so the same bug cannot come back silently: each one genuinely
 * failed at some point in this codebase's history.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');

const { envInt, envBool } = require('../src/utils/env');
const { formatIST, parseISTString, istHour, currentISTYear } = require('../src/utils/istTime');
const {
  canonicalStatus, terminalStopReason, DEFAULT_REPAIR_TICKET_STATUS,
} = require('../src/constants/repairTicketStatuses');
const { sanitizeTemplateParam, isLikelySendablePhone } = require('../src/services/whatsapp');
const { detectIntent } = require('../src/utils/intentDetect');
const { getRecipientsForStore, branchSlugFromStoreHint } = require('../src/utils/ownerPhones');
const { tryParseTicketId } = require('../src/utils/ticketParse');

// ── env parsing ───────────────────────────────────────────────
test('envInt respects an explicit 0 (was silently becoming the default)', () => {
  process.env.__T = '0';
  assert.strictEqual(envInt('__T', 10, { min: 0 }), 0);
  delete process.env.__T;
});

test('envInt falls back when unset, empty, or non-numeric', () => {
  delete process.env.__T;
  assert.strictEqual(envInt('__T', 10), 10);
  process.env.__T = '';
  assert.strictEqual(envInt('__T', 10), 10);
  process.env.__T = 'abc';
  assert.strictEqual(envInt('__T', 10), 10);
  delete process.env.__T;
});

test('envInt rejects out-of-range instead of clamping silently', () => {
  process.env.__T = '99';
  assert.strictEqual(envInt('__T', 10, { max: 23 }), 10);
  delete process.env.__T;
});

test('envBool reads 0/false as false', () => {
  process.env.__B = '0';
  assert.strictEqual(envBool('__B', true), false);
  delete process.env.__B;
});

// ── IST time ──────────────────────────────────────────────────
test('formatIST emits IST wall clock, not UTC', () => {
  const d = new Date('2026-07-17T01:11:00.000Z'); // 06:41 IST
  assert.strictEqual(formatIST(d), '2026-07-17 06:41');
});

test('parseISTString round-trips formatIST', () => {
  const d = new Date('2026-07-17T01:11:00.000Z');
  assert.strictEqual(parseISTString(formatIST(d)).getTime(), d.getTime());
});

test('parseISTString handles Sheets date serial numbers', () => {
  const d = new Date('2026-07-17T01:11:00.000Z');
  const serial = (Date.UTC(2026, 6, 17, 6, 41) - Date.UTC(1899, 11, 30)) / 86400000;
  assert.strictEqual(parseISTString(serial).getTime(), d.getTime());
});

test('istHour is timezone-independent', () => {
  assert.strictEqual(istHour(new Date('2026-07-17T01:11:00.000Z')), 6);
});

test('currentISTYear rolls at IST midnight, not UTC', () => {
  // 2026-12-31T19:00Z is already 00:30 on 2027-01-01 in IST
  assert.strictEqual(currentISTYear(new Date('2026-12-31T19:00:00.000Z')), 2027);
});

// ── status matching ───────────────────────────────────────────
test('canonicalStatus forgives a missing trailing period', () => {
  const typo = DEFAULT_REPAIR_TICKET_STATUS.replace(/\.$/, '');
  assert.strictEqual(canonicalStatus(typo), DEFAULT_REPAIR_TICKET_STATUS);
});

test('canonicalStatus forgives case and extra spaces', () => {
  assert.strictEqual(canonicalStatus('  ready  for   pickup. '), 'Ready for Pickup');
});

test('canonicalStatus passes through a genuinely custom status', () => {
  assert.strictEqual(canonicalStatus('Sent to vendor'), 'Sent to vendor');
});

test('terminalStopReason classifies end states', () => {
  assert.strictEqual(terminalStopReason('Ready for Pickup'), 'completed');
  assert.strictEqual(terminalStopReason('Picked Up'), 'completed');
  assert.strictEqual(terminalStopReason('Cannot Repair'), 'cancelled');
  assert.strictEqual(terminalStopReason('Bag Received'), null);
});

// ── template parameter safety ─────────────────────────────────
test('sanitizeTemplateParam strips newlines and tabs Meta rejects', () => {
  assert.strictEqual(sanitizeTemplateParam('Ravi\nPatel', 60, 'there'), 'Ravi Patel');
  assert.strictEqual(sanitizeTemplateParam('Ravi\tKumar', 60, 'there'), 'Ravi Kumar');
});

test('sanitizeTemplateParam collapses the 4+ spaces Meta rejects', () => {
  assert.strictEqual(sanitizeTemplateParam('Ravi    Patel', 60, 'there'), 'Ravi Patel');
});

test('sanitizeTemplateParam falls back when the value is empty', () => {
  assert.strictEqual(sanitizeTemplateParam('   ', 60, 'there'), 'there');
});

test('isLikelySendablePhone accepts real numbers and rejects junk', () => {
  assert.strictEqual(isLikelySendablePhone('918490046663'), true);
  assert.strictEqual(isLikelySendablePhone('+91 84900 46663'), true);
  assert.strictEqual(isLikelySendablePhone('Ramesh'), false);
  assert.strictEqual(isLikelySendablePhone(''), false);
});

// ── intent routing ────────────────────────────────────────────
const S = () => ({ phone: null });

test('bare "stop" is marketing opt-out, NOT repair updates', () => {
  assert.strictEqual(detectIntent('stop', S()), 'opt_out');
});

test('"stop updates" is repair updates, NOT marketing', () => {
  assert.strictEqual(detectIntent('stop updates', S()), 'repair_updates_off');
  assert.strictEqual(detectIntent('अपडेट बंद', S()), 'repair_updates_off');
  assert.strictEqual(detectIntent('અપડેટ બંધ', S()), 'repair_updates_off');
});

test('"my zip stopped working" does not opt anyone out', () => {
  assert.strictEqual(detectIntent('my zip stopped working', S()), 'repair');
});

test('handoff triggers work in all three scripts', () => {
  assert.strictEqual(detectIntent('talk to a person', S()), 'escalate');
  assert.strictEqual(detectIntent('किसी से बात कराओ', S()), 'escalate');
  assert.strictEqual(detectIntent('કોઈ સાથે વાત', S()), 'escalate');
});

test('language picker and change-language route correctly', () => {
  assert.strictEqual(detectIntent('lang_hindi', S()), 'language_choice');
  assert.strictEqual(detectIntent('language', S()), 'change_language');
  assert.strictEqual(detectIntent('ભાષા', S()), 'change_language');
});

test('rating replies route to feedback', () => {
  assert.strictEqual(detectIntent('rate_1', S()), 'feedback_rating');
  assert.strictEqual(detectIntent('4', S()), 'feedback_rating');
});

// ── owner routing ─────────────────────────────────────────────
test('branchSlugFromStoreHint understands name, button id and bare slug', () => {
  assert.strictEqual(branchSlugFromStoreHint('Sursagar (Opp. Pratap Talkies)'), 'sursagar');
  assert.strictEqual(branchSlugFromStoreHint('store_alkapuri'), 'alkapuri');
  assert.strictEqual(branchSlugFromStoreHint('sursagar'), 'sursagar');
  assert.strictEqual(branchSlugFromStoreHint(''), null);
});

test('no store context never guesses a branch owner in', () => {
  process.env.OWNER_PHONE_TESTA = '911111111111';
  process.env.BRANCH_OWNER_SURSAGAR = '912222222222';
  assert.deepStrictEqual(getRecipientsForStore(null), ['911111111111']);
  assert.ok(getRecipientsForStore('Sursagar (Opp. Pratap Talkies)').includes('912222222222'));
  assert.ok(!getRecipientsForStore('Alkapuri (Race Course Road)').includes('912222222222'));
  delete process.env.OWNER_PHONE_TESTA;
  delete process.env.BRANCH_OWNER_SURSAGAR;
});

// ── ticket id parsing ─────────────────────────────────────────
test('tryParseTicketId is forgiving about case, dashes and a TRACK prefix', () => {
  assert.strictEqual(tryParseTicketId('cha-2026-0042'), 'CHA-2026-0042');
  assert.strictEqual(tryParseTicketId('TRACK CHA-2026-42'), 'CHA-2026-0042');
  assert.strictEqual(tryParseTicketId('CHA–2026–0042'), 'CHA-2026-0042');
  assert.strictEqual(tryParseTicketId('hello'), null);
});
