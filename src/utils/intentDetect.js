// Maps customer messages to intents
// Returns intent string used by handler.js router

const { updateSession } = require('./sessionStore');
const { isTicketLikeMessage } = require('./ticketParse');

const intentMap = [
  {
    intent: 'main_menu',
    keywords: ['hi', 'hello', 'hey', 'start', 'menu', 'main menu',
      'namaste', 'namaskar', 'kem cho', 'kem chho', 'wapas', 'mukhpan',
      'shuruaat', 'home', 'help'],
    buttonIds: ['btn_main_menu', 'btn_back', 'btn_start_over'],
  },
  {
    intent: 'repair',
    keywords: ['repair', 'fix', 'toot', 'kharab', 'broken', 'damage', 'sudharo',
      'mend', 'zip', 'wheel', 'handle', 'lock', 'stitching', 'cleaning',
      'rampair', 'sudhar', 'tuti', 'bigdi', 'repar'],
    buttonIds: ['btn_repair', 'flow_repair'],
  },
  {
    intent: 'track_repair',
    keywords: ['track', 'status', 'meri bag', 'bag kahan', 'kitna time',
      'kab milegi', 'ticket', 'order status', 'repair status', 'cha-'],
    buttonIds: ['btn_track', 'flow_track'],
    /* Full message or embedded CHA-* / track CHA-* / lowercase / unicode dashes */
    matcher: (t) => isTicketLikeMessage(t),
  },
  {
    intent: 'shop_catalog',
    keywords: ['shop', 'buy', 'kharidna', 'kharido', 'catalog', 'price',
      'kitna', 'kimat', 'rate', 'how much', 'show bags', 'bags dikhao',
      'luggage', 'backpack', 'trolley', 'handbag'],
    buttonIds: ['btn_shop', 'flow_catalog'],
  },
  {
    intent: 'store_location',
    keywords: ['store', 'location', 'address', 'kahan hai', 'kahan hain',
      'shop', 'dukan', 'where', 'direction', 'map', 'alkapuri', 'sursagar',
      'sthaan', 'jaga', 'race course', 'pratap', 'directions'],
    buttonIds: ['btn_location', 'btn_stores'],
  },
  {
    intent: 'corporate',
    keywords: ['bulk', 'corporate', 'wholesale', 'company', 'school', 'office',
      'quantity', 'units', 'bulk order', 'badi quantity', 'printing',
      'branding', 'custom', 'gift', 'large order'],
    buttonIds: ['btn_corporate', 'flow_corporate'],
  },
  {
    intent: 'escalate',
    // Note: Avoid generic words like problem/issue/complaint — customers use those mid-repair
    // (“Zip / Chain Issue”) and routing would escalate before the repair flow finishes.
    keywords: ['human', 'agent', 'call me', 'person', 'staff', 'baat karo',
      'insaan', 'manush', 'talk', 'phone karo', 'not working', 'help me',
      'complaint desk', 'customer care'],
    buttonIds: ['btn_escalate', 'btn_human'],
  },
  {
    intent: 'terms',
    keywords: ['terms', 'condition', 'policy', 'privacy', 't&c', 'tnc',
      'shartein', 'niyam', 'shartoein', 'niyamavali', 'naagrik', 'गोपनीयता',
      'शर्तें', 'नियम', 'નિયમો', 'શરતો', 'ગોપનીયતા'],
    buttonIds: ['btn_terms', 'flow_terms'],
  },
];

function detectIntent(text, session) {
  if (!text || text === '__IMAGE__') {
    // An image mid-flow should continue the flow, not trigger a new intent
    if (session?.currentFlow) return '__continue_flow__';
    return 'main_menu';
  }

  const lower = text.toLowerCase().trim();

  /* WhatsApp sends list row IDs like prob_0, bag_3. main_menu mistakenly had keyword "0", so
   * prob_0/bag_0 matched main_menu ("...0..." includes "0") and wiped the repair session.
   */
  const flow = session?.currentFlow;
  const resetFb = session?.phone
    ? () => updateSession(session.phone, { fallbackCount: 0 })
    : () => {};

  if (/^bag_\d+$/i.test(text) || /^prob_\d+$/i.test(text)) {
    if (flow === 'repair') {
      resetFb();
      return '__continue_flow__';
    }
  }
  if (/^cat_\d+$/i.test(text) && flow === 'catalog') {
    resetFb();
    return '__continue_flow__';
  }
  if ((/^store_alkapuri$/i.test(text) || /^store_sursagar$/i.test(text)) && flow === 'repair') {
    resetFb();
    return '__continue_flow__';
  }
  if ((text === 'btn_dir_alkapuri' || text === 'btn_dir_sursagar') && flow === 'store_location') {
    resetFb();
    return '__continue_flow__';
  }

  // Language picker rows (sent as an interactive list on first contact and
  // whenever the customer asks to switch).
  if (/^lang_(english|hindi|gujarati)$/.test(lower)) return 'language_choice';

  // The 🌐 Language menu button. Must be matched HERE, before the generic
  // button-id handling below: 'btn_language' looks like a button id, so the
  // loop skips keyword matching for it and it fell through to 'fallback',
  // which showed the main menu instead of the language options.
  if (lower === 'btn_language') return 'change_language';

  // "Change my language" — EXACT match, because the bare word "language" could
  // otherwise appear inside an ordinary sentence.
  const CHANGE_LANG_EXACT = new Set([
    'language', 'change language', 'lang', 'bhasha', 'bhasa',
    'भाषा', 'भाषा बदलें', 'भाषा बदलो',
    'ભાષા', 'ભાષા બદલો',
  ]);
  if (CHANGE_LANG_EXACT.has(lower)) return 'change_language';

  // Feedback rating. 'rate_N' is the quick-reply payload from the feedback
  // template; a bare digit 1-5 is accepted too (customers often just type a
  // number). A bare digit only counts as a rating if there is actually an
  // outstanding feedback request — flows/feedback.js checks that and ignores
  // it otherwise, so a stray "3" mid-conversation is never logged as a score.
  if (/^rate_[1-5]$/.test(lower) || /^[1-5]$/.test(lower)) return 'feedback_rating';

  // "Talk to a person" — EXACT match, in the same style as the repair-update
  // phrases below. The pre-existing `escalate` intent further down already
  // catches loose English/romanized words ('human', 'agent', 'baat karo'), but
  // had NO Devanagari or Gujarati script entries at all, so a customer writing
  // naturally in Hindi or Gujarati could not reach a human. These fill that gap.
  // Exact match (not substring) so an ordinary sentence mentioning "team" or
  // "વાત" can't hijack a repair flow mid-way.
  const HANDOFF_EXACT = new Set([
    // English
    'talk to a person', 'talk to person', 'talk to someone', 'talk to a human',
    'speak to someone', 'speak to a person', 'talk to team', 'talk to the team',
    'real person', 'human please', 'agent please', 'connect me', 'call me back',
    // Hindi — Devanagari
    'किसी से बात कराओ', 'किसी से बात करनी है', 'इंसान से बात', 'व्यक्ति से बात',
    'स्टाफ से बात', 'टीम से बात', 'मुझे बात करनी है', 'किसी से बात',
    // Hindi — romanized
    'kisi se baat karao', 'kisi se baat', 'insaan se baat', 'staff se baat',
    'team se baat', 'baat karni hai',
    // Gujarati — Gujarati script
    'કોઈ સાથે વાત', 'કોઈની સાથે વાત', 'વ્યક્તિ સાથે વાત', 'સ્ટાફ સાથે વાત',
    'ટીમ સાથે વાત', 'મારે વાત કરવી છે',
    // Gujarati — romanized
    'koi sathe vaat', 'koi sathe vat', 'staff sathe vaat', 'team sathe vaat',
    'mare vaat karvi che',
  ]);
  if (HANDOFF_EXACT.has(lower)) return 'escalate';

  // Proactive REPAIR-UPDATE opt-out/in. Deliberately a DIFFERENT keyword set
  // from the marketing STOP/RESUME below: bare "stop" stays bound to marketing
  // (WhatsApp convention), while these two-word phrases control transactional
  // repair updates. Checked first so the more specific phrase always wins.
  const REPAIR_OFF_EXACT = new Set([
    'stop updates', 'stop update', 'no updates', 'stop repair updates',
    'अपडेट बंद', 'अपडेट बंद करो', 'update band', 'update band karo',
    'અપડેટ બંધ', 'અપડેટ બંધ કરો',
  ]);
  const REPAIR_ON_EXACT = new Set([
    'resume updates', 'resume update', 'start updates', 'start repair updates',
    'अपडेट चालू', 'अपडेट चालू करो', 'update chalu', 'update chalu karo',
    'અપડેટ ચાલુ', 'અપડેટ ચાલુ કરો',
  ]);
  if (REPAIR_OFF_EXACT.has(lower)) return 'repair_updates_off';
  if (REPAIR_ON_EXACT.has(lower)) return 'repair_updates_on';

  // Broadcast opt-out / opt-in — EXACT match only, so "my zip stopped working"
  // never unsubscribes someone mid-sentence. WhatsApp policy requires honouring STOP.
  const OPT_OUT_EXACT = new Set(['stop', 'unsubscribe', 'opt out', 'optout', 'stop messages', 'band karo', 'message band karo', 'बंद करो', 'બંધ કરો']);
  const OPT_IN_EXACT = new Set(['resume', 'subscribe', 'opt in', 'optin', 'start messages', 'shuru karo', 'शुरू करो', 'શરૂ કરો']);
  if (OPT_OUT_EXACT.has(lower)) return 'opt_out';
  if (OPT_IN_EXACT.has(lower)) return 'opt_in';

  // Single "0" for menu — do NOT use substring "0" (breaks prob_0, bag_0, cat_0, etc.)
  if (lower === '0') return 'main_menu';
  // Avoid keyword "back" (substring matches words like fallback, backbone)
  if (lower === 'back' || lower === 'go back') return 'main_menu';

  // Button identifiers (btn_*, flow_*) MUST match exactly via buttonIds — never via
  // keyword substring. Otherwise we get nasty collisions like:
  //   'btn_corporate' contains substring 'rate' -> matched shop_catalog (had 'rate' as kw)
  //   'btn_human' contains substring 'human'    -> would match escalate by keyword (fine
  //     here because escalate's buttonIds already cover it, but the principle holds).
  const isButtonId = /^(btn_|flow_)[a-z_]+$/i.test(text);

  for (const { intent, keywords, buttonIds, pattern, matcher } of intentMap) {
    // Check exact button IDs first (most reliable)
    if (buttonIds?.includes(text)) {
      if (session?.phone) updateSession(session.phone, { fallbackCount: 0 });
      return intent;
    }

    // For btn_*/flow_* identifiers we ONLY accept exact-match buttonIds — never
    // fall through to pattern or keyword matching.
    if (isButtonId) continue;

    const patternMatch =
      matcher != null
        ? matcher(text)
        : pattern != null
          ? pattern.test(text)
          : false;

    // Regex or custom matchers (e.g., ticket IDs in free text)
    if (patternMatch) {
      if (session?.phone) updateSession(session.phone, { fallbackCount: 0 });
      return intent;
    }

    // Check keywords
    if (keywords.some(k => lower.includes(k))) {
      if (session?.phone) updateSession(session.phone, { fallbackCount: 0 });
      return intent;
    }
  }

  // Increment fallback counter (persisted so escalation logic is reliable)
  if (session?.phone) {
    const next = (session.fallbackCount || 0) + 1;
    updateSession(session.phone, { fallbackCount: next });
  }
  return 'fallback';
}

module.exports = { detectIntent };
