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

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ } });
