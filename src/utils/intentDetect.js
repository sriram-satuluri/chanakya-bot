// Maps customer messages to intents
// Returns intent string used by handler.js router

const { updateSession } = require('./sessionStore');
const { isTicketLikeMessage } = require('./ticketParse');

const intentMap = [
  {
    intent: 'main_menu',
    // The greeting list was originally romanized only, so "namaste" opened the
    // menu but "नमस्ते" did not — a customer greeting the bot in their own
    // script was answered with "Sorry, I didn't quite get that". For a bot
    // whose whole premise is Hindi and Gujarati, the native-script forms are
    // the LIKELIER spelling, not the fallback. Both are kept: people switch
    // between scripts freely on a phone keyboard.
    keywords: ['hi', 'hello', 'hey', 'start', 'menu', 'main menu',
      'namaste', 'namaskar', 'kem cho', 'kem chho', 'wapas', 'mukhpan',
      'shuruaat', 'home', 'help',
      // Hindi — Devanagari
      'नमस्ते', 'नमस्कार', 'हैलो', 'हाय', 'मेनू', 'मुख्य मेनू', 'वापस',
      // Gujarati
      'કેમ છો', 'કેમ છે', 'નમસ્તે', 'નમસ્કાર', 'હેલો', 'હાય', 'મેનુ', 'મુખ્ય મેનુ'],
    buttonIds: ['btn_main_menu', 'btn_back', 'btn_start_over'],
  },
  /* track_repair MUST be checked before repair. "repair status" contains
   * "repair", so with repair first a customer asking where their bag is was
   * dropped into a brand-new booking and asked for their name. Nothing in
   * track_repair's keywords matches a plain repair request, so putting it
   * first is safe in the other direction. */
  {
    intent: 'track_repair',
    keywords: ['track', 'status', 'meri bag', 'bag kahan', 'kitna time',
      'kab milegi', 'ticket', 'order status', 'repair status', 'cha-',
      // ── DRAFT — PENDING VEDANT & VATSAL REVIEW (see NATIVE_SCRIPT_DRAFT) ──
      'ट्रैक', 'स्थिति', 'बैग कहाँ', 'कब मिलेगा', 'कब तैयार', 'टिकट',
      'ટ્રૅક', 'સ્થિતિ', 'બેગ ક્યાં', 'ક્યારે મળશે', 'ક્યારે તૈયાર', 'ટિકિટ'],
    buttonIds: ['btn_track', 'flow_track'],
    /* Full message or embedded CHA-* / track CHA-* / lowercase / unicode dashes */
    matcher: (t) => isTicketLikeMessage(t),
  },
  {
    intent: 'repair',
    keywords: ['repair', 'fix', 'toot', 'kharab', 'broken', 'damage', 'sudharo',
      'mend', 'zip', 'wheel', 'handle', 'lock', 'stitching', 'cleaning',
      'rampair', 'sudhar', 'tuti', 'bigdi', 'repar',
      // ── DRAFT — PENDING VEDANT & VATSAL REVIEW (see NATIVE_SCRIPT_DRAFT) ──
      // NB: bare 'ठीक' is deliberately NOT here — it means "fine/OK", and
      // "ठीक है" is how people say yes. Only the compound verb form.
      'रिपेयर', 'मरम्मत', 'ठीक करवाना', 'टूट गया', 'खराब हो गया', 'सिलाई',
      'ज़िप', 'चेन', 'पहिया', 'हैंडल',
      'રિપેર', 'સમારકામ', 'તૂટી ગયું', 'ખરાબ થઈ', 'સિલાઈ',
      'ઝિપ', 'ચેઈન', 'વ્હીલ', 'હેન્ડલ'],
    buttonIds: ['btn_repair', 'flow_repair'],
  },
  {
    intent: 'shop_catalog',
    /* 'marketplace' added when the menu button was renamed from Shop — people
     * type back what the button said. 'shop' stays: the word is still what most
     * customers use, and the rename is a label change, not a vocabulary one. */
    keywords: ['shop', 'buy', 'kharidna', 'kharido', 'catalog', 'price',
      'kitna', 'kimat', 'rate', 'how much', 'show bags', 'bags dikhao',
      'luggage', 'backpack', 'trolley', 'handbag', 'marketplace',
      'मार्केटप्लेस', 'માર્કેટપ્લેસ',
      // ── DRAFT — PENDING VEDANT & VATSAL REVIEW (see NATIVE_SCRIPT_DRAFT) ──
      // NB: bare 'बैग' / 'બેગ' deliberately absent — too generic, it appears
      // in repair and tracking messages just as often as in buying ones.
      'खरीदना', 'खरीदें', 'कीमत', 'दाम', 'नया बैग',
      'ખરીદવું', 'ખરીદો', 'કિંમત', 'ભાવ', 'નવી બેગ'],
    buttonIds: ['btn_shop', 'flow_catalog'],
  },
  {
    intent: 'store_location',
    /* 'shop' deliberately absent: shop_catalog claims it first, so listing it
     * here was dead weight that only looked like it did something. */
    keywords: ['store', 'location', 'address', 'kahan hai', 'kahan hain',
      'dukan', 'where', 'direction', 'map', 'alkapuri', 'sursagar',
      'sthaan', 'jaga', 'race course', 'pratap', 'directions',
      // ── DRAFT — PENDING VEDANT & VATSAL REVIEW (see NATIVE_SCRIPT_DRAFT) ──
      // NB: bare 'कहाँ है' / 'ક્યાં છે' deliberately absent — it is equally
      // "where is my bag" (track) and "where is the shop" (store). Both sides
      // are qualified with their noun instead.
      'दुकान', 'स्टोर', 'पता', 'दुकान कहाँ', 'रास्ता', 'नक्शा',
      'દુકાન', 'સ્ટોર', 'સરનામું', 'દુકાન ક્યાં', 'રસ્તો', 'નકશો'],
    // btn_dir_* are here so they resolve from ANY session state. They used to
    // be matched only while the store flow sat on its 'pick_store' step — but
    // that flow clears the session as soon as it answers, so the next tap on a
    // button still sitting in the chat matched nothing and fell to fallback.
    buttonIds: ['btn_location', 'btn_stores', 'btn_dir_alkapuri', 'btn_dir_sursagar'],
  },
  {
    intent: 'corporate',
    /* NOT bare 'custom': suffixes are allowed (so 'repair' reaches
     * "repairing"), which made 'custom' reach "CUSTOMer care" and drop people
     * asking for support into a bulk-order form. These stems mean what they
     * say; "custom printing" is also already covered by 'printing'. */
    /* Non-bag corporate categories added alongside the originals — Chanakya
     * supplies gifting, appliances, helmets and thermoware in bulk, and those
     * buyers previously landed in fallback. Added, never swapped: removing a
     * stem here is what caused the shadowing bugs the test suite now guards. */
    keywords: ['bulk', 'corporate', 'wholesale', 'company', 'school', 'office',
      'quantity', 'units', 'bulk order', 'badi quantity', 'printing',
      'branding', 'customis', 'customiz', 'custom print', 'custom bag',
      'gift', 'large order',
      'gifting', 'helmet', 'thermo', 'appliance', 'merchandise'],
    buttonIds: ['btn_corporate', 'flow_corporate'],
  },
  {
    intent: 'escalate',
    // Note: Avoid generic words like problem/issue/complaint — customers use those mid-repair
    // (“Zip / Chain Issue”) and routing would escalate before the repair flow finishes.
    /* 'help me' lives in HANDOFF_EXACT instead: main_menu's 'help' keyword is
     * checked first and would always claim it here. */
    keywords: ['human', 'agent', 'call me', 'person', 'staff', 'baat karo',
      'insaan', 'manush', 'talk', 'phone karo', 'not working',
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

  if (/^bag_\d+$/i.test(text) || /^prob_\d+$/i.test(text)
      || /^combo_other$/i.test(text) || /^combo_\d+_\d+$/i.test(text)) {
    if (flow === 'repair') {
      resetFb();
      return '__continue_flow__';
    }
  }
  if ((/^cat_\d+$/i.test(text) || /^cat_all$/i.test(text)) && flow === 'catalog') {
    resetFb();
    return '__continue_flow__';
  }
  /* The repair-updates yes/no buttons. Their flow consumes them correctly, but
   * without this they resolved to 'fallback' on the way past and quietly
   * incremented fallbackCount — so a customer answering the question properly
   * was being counted as failing to understand the bot. That matters now the
   * escalation offer triggers after two unresolved messages, not three. */
  if (/^ru_(yes|no)$/i.test(text) && flow === 'repair_updates') {
    resetFb();
    return '__continue_flow__';
  }
  // Skipping the optional "who served you" question is a valid answer, not a
  // failure to understand — it must not count toward the fallback counter.
  if (/^btn_skip_staff$/i.test(text) && flow === 'repair') {
    resetFb();
    return '__continue_flow__';
  }
  // Submitting or restarting at the bulk-order recap is a valid answer, not a
  // failure to understand — same reasoning as the skip button above.
  if (/^btn_lead_(submit|restart)$/i.test(text) && flow === 'corporate') {
    resetFb();
    return '__continue_flow__';
  }
  if ((/^store_alkapuri$/i.test(text) || /^store_sursagar$/i.test(text)) && flow === 'repair') {
    resetFb();
    return '__continue_flow__';
  }
  // btn_dir_* were special-cased here, matched only while flow was
  // 'store_location'. They now live on store_location's buttonIds and resolve
  // from any state, so the guard was removed rather than left as dead weight.

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
    // Matched here rather than as an escalate keyword — main_menu's 'help'
    // is checked earlier and would otherwise swallow it into the menu.
    'help me', 'please help me', 'i need help', 'need help',
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

  /**
   * Does `lower` contain keyword `k` as a WORD, not as a random substring?
   *
   * The old rule applied a word boundary only to keywords of 3 characters or
   * fewer and used a bare `.includes()` for everything else. That produced
   * collisions that were invisible until someone typed the obvious thing:
   *
   *   "corporate"     contains "rate"   -> opened the shop catalogue
   *   "customer care" contains "custom" -> opened the bulk-order lead form
   *
   * The fix is a boundary at the START only. Keywords here are deliberately
   * stems — 'repair' must still match "repairing", 'direction' must match
   * "directions", 'condition' must match "conditions" — so trailing letters
   * stay allowed. What is no longer allowed is a keyword beginning in the
   * middle of a longer word, which is where every one of these bugs came from.
   *
   * Non-Latin keywords (Devanagari / Gujarati) work unchanged: their
   * neighbouring characters are outside [a-z], so both boundaries hold.
   */
  function keywordMatches(lower, k) {
    const kw = String(k).toLowerCase().trim();
    if (!kw) return false;
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-z])${escaped}[a-z]*(?:$|[^a-z])`).test(lower);
  }

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

    // Check keywords. Short ones (hi, hey) must be whole words — otherwise
    // "hi" matches "stitching" / "something" and dumps a booking into the menu.
    if (keywords?.some(k => keywordMatches(lower, k))) {
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

module.exports = {
  detectIntent,
  /** Exported so the shadowing test reads the REAL keyword lists rather than a
   *  copy that would silently drift out of date. Treat as read-only. */
  intentMap,
};
