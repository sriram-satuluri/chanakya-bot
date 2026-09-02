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

const fs = require('node:fs');
const path = require('node:path');

const { envInt, envBool } = require('../src/utils/env');
const {
  repairUpdatesReady, feedbackTemplatesReady, resolveRepairUpdateTemplate,
  missingTemplateEnv,
} = require('../src/utils/metaTemplates');
const { formatIST, parseISTString, istHour, currentISTYear } = require('../src/utils/istTime');
const {
  canonicalStatus, terminalStopReason, DEFAULT_REPAIR_TICKET_STATUS,
} = require('../src/constants/repairTicketStatuses');
const { sanitizeTemplateParam, isLikelySendablePhone } = require('../src/services/whatsapp');
const { isRetryableSheetsError, withSheetsRetry } = require('../src/services/sheets');
const { detectIntent, intentMap } = require('../src/utils/intentDetect');
const {
  getRecipientsForStore,
  branchSlugFromStoreHint,
  getRecipientsForCorporate,
  getRecipientsForRepair,
} = require('../src/utils/ownerPhones');
const { tryParseTicketId, shortTicketCode } = require('../src/utils/ticketParse');
const { ticketLetterFromStore } = require('../src/utils/ticketId');

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

test('the Language menu button opens the picker, not the main menu', () => {
  // btn_language looks like a button id, so the generic button handling used
  // to skip it and fall through to 'fallback' -> main menu, i.e. the button
  // restarted the conversation instead of offering the three languages.
  assert.strictEqual(detectIntent('btn_language', S()), 'change_language');
});

test('list row ids stay in the repair flow (bag, problem)', () => {
  const s = { phone: '919000000099', currentFlow: 'repair' };
  assert.strictEqual(detectIntent('bag_0', s), '__continue_flow__');
  assert.strictEqual(detectIntent('prob_1', s), '__continue_flow__');
});

test('"hi" inside stitching does not dump a booking into the main menu', () => {
  const s = { phone: '919000000099', currentFlow: 'repair' };
  assert.notStrictEqual(detectIntent('Stitching / Tear', s), 'main_menu');
  assert.notStrictEqual(detectIntent('Something else', s), 'main_menu');
  assert.strictEqual(detectIntent('hi', S()), 'main_menu');
});

test('an image mid-flow continues the flow', () => {
  assert.strictEqual(detectIntent('__IMAGE__', { phone: null, currentFlow: 'repair' }), '__continue_flow__');
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

// ── bulk-order lead routing ───────────────────────────────────
test('CORPORATE_OWNER_PHONES replaces the general list for bulk leads only', () => {
  process.env.OWNER_PHONE_TESTA = '911111111111';
  process.env.CORPORATE_OWNER_PHONES = '919974017727,919974017725';

  // Bulk goes to exactly the two named numbers — the general owner is dropped.
  assert.deepStrictEqual(
    getRecipientsForCorporate(),
    ['919974017727', '919974017725']
  );
  // ...but that same general owner still gets every repair ticket.
  assert.ok(getRecipientsForRepair('alkapuri').includes('911111111111'));

  delete process.env.OWNER_PHONE_TESTA;
  delete process.env.CORPORATE_OWNER_PHONES;
});

test('bulk leads fall back to general owners when the override is unset', () => {
  process.env.OWNER_PHONE_TESTA = '911111111111';
  delete process.env.CORPORATE_OWNER_PHONES;
  assert.deepStrictEqual(getRecipientsForCorporate(), ['911111111111']);
  delete process.env.OWNER_PHONE_TESTA;
});

test('CORPORATE_OWNER_PHONES tolerates spaces, +, blanks and duplicates', () => {
  process.env.OWNER_PHONE_TESTA = '911111111111';
  process.env.CORPORATE_OWNER_PHONES = ' +919974017727 , ,919974017725,919974017727 ';
  assert.deepStrictEqual(
    getRecipientsForCorporate(),
    ['919974017727', '919974017725']
  );
  delete process.env.OWNER_PHONE_TESTA;
  delete process.env.CORPORATE_OWNER_PHONES;
});

test('an all-garbage CORPORATE_OWNER_PHONES falls back rather than alerting nobody', () => {
  process.env.OWNER_PHONE_TESTA = '911111111111';
  process.env.CORPORATE_OWNER_PHONES = 'not-a-number, ,abc';
  assert.deepStrictEqual(getRecipientsForCorporate(), ['911111111111']);
  delete process.env.OWNER_PHONE_TESTA;
  delete process.env.CORPORATE_OWNER_PHONES;
});

// ── ticket id parsing ─────────────────────────────────────────
test('tryParseTicketId is forgiving about case, dashes and a TRACK prefix', () => {
  assert.strictEqual(tryParseTicketId('cha-2026-0042'), 'CHA-2026-0042');
  assert.strictEqual(tryParseTicketId('TRACK CHA-2026-42'), 'CHA-2026-0042');
  assert.strictEqual(tryParseTicketId('CHA–2026–0042'), 'CHA-2026-0042');
  assert.strictEqual(tryParseTicketId('hello'), null);
});

test('tryParseTicketId understands store letters R (Alkapuri) and S (Sursagar)', () => {
  assert.strictEqual(tryParseTicketId('cha-r-2026-20'), 'CHA-R-2026-0020');
  assert.strictEqual(tryParseTicketId('TRACK CHA-S-2026-0020'), 'CHA-S-2026-0020');
  assert.strictEqual(tryParseTicketId('CHA–R–2026–0042'), 'CHA-R-2026-0042');
});

test('ticketLetterFromStore maps both shops and rejects unknown', () => {
  assert.strictEqual(ticketLetterFromStore('store_alkapuri'), 'R');
  assert.strictEqual(ticketLetterFromStore('Alkapuri (Race Course Road)'), 'R');
  assert.strictEqual(ticketLetterFromStore('store_sursagar'), 'S');
  assert.strictEqual(ticketLetterFromStore('sursagar'), 'S');
  assert.strictEqual(ticketLetterFromStore(''), null);
});

test('Shop menu button routes to the catalog', () => {
  assert.strictEqual(detectIntent('btn_shop', S()), 'shop_catalog');
});

// ── approved-template gating ──────────────────────────────────
const TEMPLATE_ENV_KEYS = [
  'REPAIR_UPDATE_TEMPLATE_EN', 'REPAIR_UPDATE_TEMPLATE_HI', 'REPAIR_UPDATE_TEMPLATE_GU',
  'FEEDBACK_TEMPLATE_EN', 'FEEDBACK_TEMPLATE_HI', 'FEEDBACK_TEMPLATE_GU',
];

function withClearedTemplateEnv(fn) {
  const saved = {};
  for (const k of TEMPLATE_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    fn();
  } finally {
    for (const k of TEMPLATE_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('repair/feedback jobs stay off until template env is set', () => {
  withClearedTemplateEnv(() => {
    assert.strictEqual(repairUpdatesReady(), false);
    assert.strictEqual(feedbackTemplatesReady(), false);
    assert.strictEqual(resolveRepairUpdateTemplate('english'), null);
    assert.ok(missingTemplateEnv().includes('REPAIR_UPDATE_TEMPLATE_EN'));
  });
});

test('setting only the English repair template is enough to go live', () => {
  withClearedTemplateEnv(() => {
    process.env.REPAIR_UPDATE_TEMPLATE_EN = 'repair_status_update_en';
    assert.strictEqual(repairUpdatesReady(), true);
    assert.deepStrictEqual(resolveRepairUpdateTemplate('hindi'), {
      name: 'repair_status_update_en',
      langCode: 'en',
    });
    assert.strictEqual(feedbackTemplatesReady(), false);
  });
});

// ── encoding (PowerShell -replace has already destroyed these once) ──
const UNICODE_SOURCES = [
  'src/messages/index.js',
  'src/utils/intentDetect.js',
  'src/flows/repair.js',
  'src/flows/catalog.js',
  'src/flows/mainMenu.js',
  'src/flows/corporate.js',
  'src/flows/escalate.js',
];

test('user-facing source files keep Devanagari and Gujarati, not mojibake', () => {
  const mojibake = /Ã|à¤|àª/;
  const devanagari = /[ऀ-ॿ]/;
  const gujarati = /[\u0A80-\u0AFF]/;
  for (const rel of UNICODE_SOURCES) {
    const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.equal(mojibake.test(text), false, `${rel} contains mojibake`);
    assert.equal(devanagari.test(text), true, `${rel} lost Devanagari`);
    assert.equal(gujarati.test(text), true, `${rel} lost Gujarati`);
  }
});

// ── bulk-order customer-facing copy ───────────────────────────
const CORPORATE_KEYS = [
  'corporate_intro', 'corporate_ask_company', 'corporate_ask_name',
  'corporate_ask_product', 'corporate_ask_quantity', 'corporate_ask_price',
  'corporate_ask_branding', 'corporate_recap', 'corporate_throttle',
  'corporate_create_failed', 'corporate_confirmed',
];

test('bulk contact block is Nilesh then Vatsal, and does not carry Vedant', () => {
  const { corporateContactBlock } = require('../src/constants/publicContact');
  const block = corporateContactBlock();
  assert.ok(block.includes('+91 99740 17727'), 'Nilesh is listed');
  assert.ok(block.includes('+91 99740 17725'), 'Vatsal is listed');
  assert.ok(!block.includes('+91 99745 92477'), 'Vedant is NOT on the bulk block');
  assert.ok(
    block.indexOf('+91 99740 17727') < block.indexOf('+91 99740 17725'),
    'Nilesh is listed first',
  );
});

test('escalation directory is untouched by the bulk contact change', () => {
  const { directoryWithEmail } = require('../src/constants/publicContact');
  const block = directoryWithEmail();
  assert.ok(block.includes('+91 99745 92477'), 'Vedant still reachable via escalation');
  assert.ok(block.includes('+91 99740 17725'), 'Vatsal still reachable via escalation');
});

test('bulk confirmation shows the fixed pair and the marketplace link, in every language', () => {
  const M = require('../src/messages/index');
  const { CORPORATE_MARKETPLACE_URL } = require('../src/constants/publicContact');
  for (const lang of ['english', 'hindi', 'gujarati']) {
    const body = M.get('corporate_confirmed', lang);
    assert.ok(body.includes('+91 99740 17727'), `${lang}: Nilesh`);
    assert.ok(body.includes('+91 99740 17725'), `${lang}: Vatsal`);
    assert.ok(!body.includes('+91 99745 92477'), `${lang}: Vedant must not appear`);
    assert.ok(body.includes(CORPORATE_MARKETPLACE_URL), `${lang}: marketplace link`);
  }
});

test('the marketplace link is the www host, and the category prompt carries it', () => {
  const M = require('../src/messages/index');
  const { CORPORATE_MARKETPLACE_URL } = require('../src/constants/publicContact');
  assert.strictEqual(CORPORATE_MARKETPLACE_URL, 'https://www.chanakyacorporate.com/product-list');
  for (const lang of ['english', 'hindi', 'gujarati']) {
    assert.ok(
      M.get('corporate_ask_product', lang).includes(CORPORATE_MARKETPLACE_URL),
      `${lang}: category prompt links to the marketplace`,
    );
  }
});

/* get() silently falls back to English for a missing language, so a dropped
 * translation ships invisibly. Comparing against the English string is what
 * makes that visible. */
test('every bulk-flow message is really translated, not falling back to English', () => {
  const M = require('../src/messages/index');
  for (const key of CORPORATE_KEYS) {
    const en = M.get(key, 'english');
    assert.ok(!/^\[Missing:/.test(en), `${key} has no English copy`);
    for (const lang of ['hindi', 'gujarati']) {
      assert.notStrictEqual(M.get(key, lang), en, `${key} is not translated into ${lang}`);
    }
  }
});

/* front.chanakyacorporate.com stopped resolving (NXDOMAIN) while it was still
 * hardcoded here, so the bot sent customers to a dead host and nothing logged
 * an error — we never fetch these URLs ourselves. This guards the whole tree
 * rather than the one constant, because the string was duplicated last time. */
test('no source file links to the dead front. subdomain', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : (full.endsWith('.js') ? [full] : []);
  });
  const offenders = walk(path.join(__dirname, '..', 'src'))
    .filter((f) => /front\.chanakyacorporate/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, [], 'these still point at the dead host');
});

test('every marketplace link the bot can emit uses one live host', () => {
  const { CATALOG_SITE, browseAllUrl, categoryUrl, CATEGORIES } = require('../src/constants/catalogCategories');
  const { CORPORATE_MARKETPLACE_URL } = require('../src/constants/publicContact');
  assert.strictEqual(CATALOG_SITE, 'https://www.chanakyacorporate.com');
  assert.strictEqual(browseAllUrl(), 'https://www.chanakyacorporate.com/product-list');
  assert.strictEqual(CORPORATE_MARKETPLACE_URL, browseAllUrl(), 'bulk link must not drift from the catalogue host');
  for (const cat of CATEGORIES) {
    assert.ok(
      categoryUrl(cat).startsWith('https://www.chanakyacorporate.com/product-list?category='),
      `${cat.apiName} deep-link is on the live host`,
    );
  }
});

test('the store contact block links to the marketplace, not a bare hostname', () => {
  const { directoryWithEmailAndWebForBranch } = require('../src/constants/publicContact');
  const { browseAllUrl } = require('../src/constants/catalogCategories');
  const block = directoryWithEmailAndWebForBranch('sursagar');
  assert.ok(block.includes(browseAllUrl()), 'full tappable URL is present');
  assert.ok(!/front\.chanakyacorporate/i.test(block), 'dead host is gone');
});

test('the bulk category prompt tells people to come back to the chat', () => {
  const M = require('../src/messages/index');
  const expectations = {
    english:  /come back and tell me here/i,
    hindi:    /यहीं वापस आकर/,
    gujarati: /અહીં જ પાછા આવીને/,
  };
  for (const [lang, re] of Object.entries(expectations)) {
    assert.match(M.get('corporate_ask_product', lang), re, `${lang}: return-to-chat nudge`);
  }
});

test('the category prompt is no longer bag-only', () => {
  const M = require('../src/messages/index');
  const en = M.get('corporate_ask_product', 'english');
  assert.ok(!/what type of bags/i.test(en), 'old bag-only wording is gone');
  for (const example of ['Electronics', 'Corporate Gifting', 'Helmets', 'Thermoware']) {
    assert.ok(en.includes(example), `examples mention ${example}`);
  }
});

/* sendButtonMessage does .substring(0, 20) on every title, so an over-long
 * label does not error — it ships truncated mid-word ("🛍️ Corporate Marketp").
 * Devanagari and Gujarati run longer than their English counterparts, so a
 * label that fits in English can still overflow in the other two. */
test('no reply-button title can be silently truncated by the 20-char cap', () => {
  const flowsDir = path.join(__dirname, '..', 'src', 'flows');
  // The single-line button form: { id: 'btn_x', title: '…' } with no description.
  const buttonLine = /\{\s*id:\s*'([a-z_]+)',\s*title:\s*'([^']+)'\s*\}/g;
  const offenders = [];
  for (const file of fs.readdirSync(flowsDir).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(flowsDir, file), 'utf8');
    for (const [, id, title] of text.matchAll(buttonLine)) {
      if (title.length > 20) offenders.push(`${file} ${id} (${title.length}) ${title}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'these titles will render truncated');
});

test('the marketplace rename is consistent across menu, terms and catalogue', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
  const menu = read('flows/mainMenu.js');
  const terms = read('flows/terms.js');
  const catalog = read('flows/catalog.js');
  // The old English label is gone from every entry point.
  for (const [name, text] of [['mainMenu', menu], ['terms', terms]]) {
    assert.ok(!/title:\s*'🛍️ Shop'/.test(text), `${name} still offers "Shop"`);
    assert.ok(/Marketplace/.test(text), `${name} offers the Marketplace label`);
  }
  // The full name survives where there is room for it.
  assert.ok(/🛍️ Corporate Marketplace/.test(catalog), 'catalogue header carries the full name');
  // And typing it back reaches the catalogue.
  const { detectIntent } = require('../src/utils/intentDetect');
  assert.strictEqual(detectIntent('marketplace', { phone: null }), 'shop_catalog');
});

// ── Intent shadowing ──────────────────────────────────────────
/**
 * The permanent guard for a bug class that has now recurred twice.
 *
 * intentMap is scanned in order and the first match wins, so a keyword can be
 * listed under one intent while always resolving to another. That is invisible
 * on inspection and only shows up when a customer types the obvious word:
 *
 *   "corporate"     matched shop_catalog  (it contains "rate")
 *   "customer care" matched corporate     (it contains "custom")
 *   "repair status" matched repair        (it contains "repair")
 *   "help me"       matched main_menu     (it contains "help")
 *
 * Reads the real intentMap, so adding a colliding keyword fails here rather
 * than in production.
 */
test('every intent keyword resolves to its own intent (no shadowing)', () => {
  const shadowed = [];
  for (const { intent, keywords } of intentMap) {
    for (const kw of keywords || []) {
      const got = detectIntent(kw, { phone: null });
      if (got !== intent) {
        shadowed.push(`"${kw}" is listed under ${intent} but resolves to ${got}`);
      }
    }
  }
  assert.deepStrictEqual(
    shadowed, [],
    `Shadowed keywords found — these can never be reached:\n  ${shadowed.join('\n  ')}`,
  );
});

test('keyword matching allows suffixes but not mid-word matches', () => {
  // Stems must keep working…
  assert.strictEqual(detectIntent('repairing my bag', { phone: null }), 'repair');
  assert.strictEqual(detectIntent('directions please', { phone: null }), 'store_location');
  assert.strictEqual(detectIntent('conditions', { phone: null }), 'terms');
  // …but a keyword must not match starting mid-word.
  assert.strictEqual(detectIntent('corporate', { phone: null }), 'corporate');
  assert.strictEqual(detectIntent('customer care', { phone: null }), 'escalate');
});

test('valid in-flow button taps do not count as fallbacks', () => {
  // These resolve via their owning flow. Before the two-strike escalation
  // threshold they merely wasted a counter tick; now, counting a correct
  // answer as a failure would escalate someone who is doing fine.
  assert.strictEqual(
    detectIntent('ru_yes', { phone: null, currentFlow: 'repair_updates' }), '__continue_flow__');
  assert.strictEqual(
    detectIntent('ru_no', { phone: null, currentFlow: 'repair_updates' }), '__continue_flow__');
  assert.strictEqual(
    detectIntent('cat_all', { phone: null, currentFlow: 'catalog' }), '__continue_flow__');
});

test('handoff phrases beat the main-menu greeting keywords', () => {
  // 'help' is a main_menu keyword and is checked first, so these have to be
  // caught by the exact-phrase layer above the keyword loop.
  for (const phrase of ['help me', 'i need help', 'need help', 'please help me']) {
    assert.strictEqual(detectIntent(phrase, { phone: null }), 'escalate', `"${phrase}" must reach a human`);
  }
  // A bare greeting still opens the menu.
  assert.strictEqual(detectIntent('hi', { phone: null }), 'main_menu');
  assert.strictEqual(detectIntent('help', { phone: null }), 'main_menu');
});

// ── Sheets HTTP retry (I3) ────────────────────────────────────
test('Sheets retries 429/5xx/timeouts, not 4xx', () => {
  assert.ok(isRetryableSheetsError({ code: 429 }));
  assert.ok(isRetryableSheetsError({ response: { status: 503 } }));
  assert.ok(isRetryableSheetsError({ code: 'ETIMEDOUT', message: 'timeout' }));
  assert.ok(isRetryableSheetsError({ message: 'socket hang up' }));
  assert.ok(!isRetryableSheetsError({ code: 400, message: 'bad request' }));
  assert.ok(!isRetryableSheetsError({ response: { status: 403 } }));
});

test('withSheetsRetry succeeds after a transient miss', async () => {
  let n = 0;
  const out = await withSheetsRetry(async () => {
    n += 1;
    if (n === 1) {
      const err = new Error('rate limited');
      err.code = 429;
      throw err;
    }
    return 'ok';
  });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(n, 2);
});

test('withSheetsRetry does not retry a 400', async () => {
  let n = 0;
  await assert.rejects(async () => {
    await withSheetsRetry(async () => {
      n += 1;
      const err = new Error('bad request');
      err.code = 400;
      throw err;
    });
  }, /bad request/);
  assert.strictEqual(n, 1);
});

// ── Greetings in the customer's own script ────────────────────
/**
 * Found by walking the bot as a Gujarati and a Hindi customer: the greeting
 * keywords were romanized only, so "namaste" opened the menu but "नमस्ते" was
 * answered with "Sorry, I didn't quite get that". For a bot whose premise is
 * Hindi and Gujarati, being greeted in the customer's own script and
 * apologising for not understanding is the worst possible first impression.
 */
test('a greeting in Devanagari or Gujarati opens the menu, like the romanized form', () => {
  const S = () => ({ phone: null });
  for (const g of ['नमस्ते', 'नमस्कार', 'हैलो', 'मेनू']) {
    assert.strictEqual(detectIntent(g, S()), 'main_menu', `Hindi greeting "${g}" must open the menu`);
  }
  for (const g of ['કેમ છો', 'નમસ્તે', 'હેલો', 'મેનુ']) {
    assert.strictEqual(detectIntent(g, S()), 'main_menu', `Gujarati greeting "${g}" must open the menu`);
  }
  // The romanized forms must keep working — people switch scripts mid-chat.
  for (const g of ['namaste', 'kem cho', 'hello']) {
    assert.strictEqual(detectIntent(g, S()), 'main_menu');
  }
});

// ── Spoken short ticket code ──────────────────────────────────
/**
 * "See-Aitch-Ay dash Arr dash two-oh-two-six dash oh-oh-one-three" is not
 * something anyone reads down a phone line correctly. The STORED id is
 * unchanged — this is display and input sugar over the top of it.
 */
test('a stored ticket id yields a sayable short code', () => {
  assert.strictEqual(shortTicketCode('CHA-R-2026-0013'), 'R-13');
  assert.strictEqual(shortTicketCode('CHA-S-2026-0007'), 'S-7');
  assert.strictEqual(shortTicketCode('CHA-S-2026-0142'), 'S-142');
  // Legacy ids carry no store letter, so there is nothing to shorten.
  assert.strictEqual(shortTicketCode('CHA-2026-0042'), null);
  assert.strictEqual(shortTicketCode('nonsense'), null);
});

test('the short code parses back to the full stored id', () => {
  const year = currentISTYear();
  for (const spoken of ['R13', 'R-13', 'r 13', 'r-13']) {
    assert.strictEqual(tryParseTicketId(spoken), `CHA-R-${year}-0013`, `"${spoken}" should resolve`);
  }
  assert.strictEqual(tryParseTicketId('S7'), `CHA-S-${year}-0007`);
  assert.strictEqual(tryParseTicketId('S-142'), `CHA-S-${year}-0142`);
});

test('a bare number is NOT a ticket reference', () => {
  // This is the whole reason the letter prefix is required: 1-5 are feedback
  // ratings, and digits turn up in ordinary conversation constantly.
  for (const notATicket of ['13', '3', '1', '2026', 'R', 'hello', '']) {
    assert.strictEqual(tryParseTicketId(notATicket), null, `"${notATicket}" must not parse`);
  }
});

test('full ticket ids still parse exactly as before', () => {
  assert.strictEqual(tryParseTicketId('CHA-R-2026-0013'), 'CHA-R-2026-0013');
  assert.strictEqual(tryParseTicketId('TRACK cha-s-2026-42'), 'CHA-S-2026-0042');
  assert.strictEqual(tryParseTicketId('CHA–2026–0042'), 'CHA-2026-0042');
});

/**
 * DRAFT VOCABULARY — pending Vedant & Vatsal's review.
 *
 * Before this, 16 of 16 native-script phrases fell to "Sorry, I didn't quite
 * get that": every keyword in the map was romanized, so a customer typing in
 * their own script reached nothing. Buttons were always translated; typed
 * input was not. If the wording changes after review, change it here too —
 * these are the phrases a real customer is expected to send.
 */
test('typed Hindi reaches the right flow', () => {
  const S = () => ({ phone: null });
  const cases = {
    'रिपेयर': 'repair', 'मरम्मत': 'repair', 'बैग टूट गया': 'repair', 'सिलाई': 'repair',
    'ट्रैक': 'track_repair', 'मेरा बैग कहाँ है': 'track_repair', 'कब मिलेगा': 'track_repair',
    'दुकान': 'store_location', 'स्टोर का पता': 'store_location', 'रास्ता': 'store_location',
    'खरीदें': 'shop_catalog', 'कीमत': 'shop_catalog', 'नया बैग': 'shop_catalog',
  };
  for (const [phrase, intent] of Object.entries(cases)) {
    assert.strictEqual(detectIntent(phrase, S()), intent, `"${phrase}" should reach ${intent}`);
  }
});

test('typed Gujarati reaches the right flow', () => {
  const S = () => ({ phone: null });
  const cases = {
    'બેગ રિપેર': 'repair', 'ઝિપ': 'repair', 'તૂટી ગયું': 'repair',
    'ટ્રૅક': 'track_repair', 'બેગ ક્યાં છે': 'track_repair', 'ક્યારે મળશે': 'track_repair',
    'સ્ટોર': 'store_location', 'દુકાન ક્યાં છે': 'store_location', 'સરનામું': 'store_location',
    'ખરીદો': 'shop_catalog', 'કિંમત': 'shop_catalog',
  };
  for (const [phrase, intent] of Object.entries(cases)) {
    assert.strictEqual(detectIntent(phrase, S()), intent, `"${phrase}" should reach ${intent}`);
  }
});

test('"ठीक है" means OK, not "repair it"', () => {
  // The single most dangerous word in the draft: ठीक alone means fine/OK, and
  // "ठीक है" is how people say yes. Only the compound verb form is a keyword,
  // so plain agreement must never be read as a repair request.
  assert.notStrictEqual(detectIntent('ठीक है', { phone: null }), 'repair');
});

test('adding native greetings did not swallow the other native-script commands', () => {
  const S = () => ({ phone: null });
  assert.strictEqual(detectIntent('भाषा', S()), 'change_language');
  assert.strictEqual(detectIntent('ભાષા', S()), 'change_language');
  assert.strictEqual(detectIntent('नियम', S()), 'terms');
  assert.strictEqual(detectIntent('શરતો', S()), 'terms');
  assert.strictEqual(detectIntent('अपडेट बंद', S()), 'repair_updates_off');
  assert.strictEqual(detectIntent('किसी से बात कराओ', S()), 'escalate');
  assert.strictEqual(detectIntent('કોઈ સાથે વાત', S()), 'escalate');
});
