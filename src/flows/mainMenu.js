const { sendButtonMessage, sendListMessage } = require('../services/whatsapp');
const { addOrUpdateContact } = require('../services/sheets');
const { getSession, updateSession } = require('../utils/sessionStore');
const M = require('../messages/index');

// Redact phone to last-4 for logs. Same idea as webhook/handler.js — keeps logs
// useful for correlating a session without persisting full PII on hosted log tails.
const _rd = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/**
 * "Marketplace", not "Corporate Marketplace": WhatsApp caps button titles at 20
 * characters and sendButtonMessage truncates silently, so the full phrase would
 * ship as "🛍️ Corporate Marketp". The full name is used in the catalogue header
 * the moment they tap through, which is where there is room for it.
 */
const MENU_BUTTONS = {
  english: [
    { id: 'btn_repair', title: '🔧 Repair My Bag' },
    { id: 'btn_track',  title: '📍 Track My Repair' },
    { id: 'btn_shop',   title: '🛍️ Marketplace' },
  ],
  hindi: [
    { id: 'btn_repair', title: '🔧 बैग रिपेयर करें' },
    { id: 'btn_track',  title: '📍 रिपेयर ट्रैक करें' },
    { id: 'btn_shop',   title: '🛍️ मार्केटप्लेस' },
  ],
  gujarati: [
    { id: 'btn_repair', title: '🔧 બેગ રિપેર કરો' },
    { id: 'btn_track',  title: '📍 રિપેર ટ્રૅક કરો' },
    { id: 'btn_shop',   title: '🛍️ માર્કેટપ્લેસ' },
  ],
};

/**
 * The second row is a LIST, not buttons.
 *
 * WhatsApp caps interactive buttons at 3, and this row was already full —
 * which is why Change Language and Terms existed as handled-but-unreachable
 * ids: there was physically nowhere to put them. A list allows 10 rows in a
 * single message, so both become tappable at no extra message cost, and
 * "type *language*" stops being the only way to switch.
 *
 * Row titles are capped at 24 chars and descriptions at 72 by WhatsApp; the
 * substring() calls below enforce that rather than letting Meta truncate
 * mid-word.
 */
const MENU_LIST_ROWS = {
  english: [
    { id: 'btn_human',     title: '👤 Talk to a Person',  description: 'Reach our team directly' },
    { id: 'btn_location',  title: '🗺️ Store Locations',   description: 'Addresses and directions' },
    { id: 'btn_corporate', title: '🤝 Bulk / Corporate',  description: 'Bulk orders and custom printing' },
    { id: 'btn_language',  title: '🌐 Change Language',   description: 'English / हिंदी / ગુજરાતી' },
    { id: 'btn_terms',     title: '📜 Terms & Conditions', description: 'Read our full terms' },
  ],
  hindi: [
    { id: 'btn_human',     title: '👤 स्टाफ से बात करें', description: 'सीधे हमारी टीम से संपर्क' },
    { id: 'btn_location',  title: '🗺️ स्टोर का पता',      description: 'पता और रास्ता' },
    { id: 'btn_corporate', title: '🤝 बल्क/कॉर्पोरेट',    description: 'बल्क ऑर्डर और कस्टम प्रिंटिंग' },
    { id: 'btn_language',  title: '🌐 भाषा बदलें',        description: 'English / हिंदी / ગુજરાતી' },
    { id: 'btn_terms',     title: '📜 नियम और शर्तें',     description: 'पूरी Terms पढ़ें' },
  ],
  gujarati: [
    { id: 'btn_human',     title: '👤 સ્ટાફ સાથે વાત',    description: 'સીધો અમારી ટીમનો સંપર્ક' },
    { id: 'btn_location',  title: '🗺️ સ્ટોરનું સ્થળ',      description: 'સરનામું અને રસ્તો' },
    { id: 'btn_corporate', title: '🤝 બલ્ક / કૉર્પોરેટ',  description: 'બલ્ક ઓર્ડર અને કસ્ટમ પ્રિન્ટિંગ' },
    { id: 'btn_language',  title: '🌐 ભાષા બદલો',        description: 'English / हिंदी / ગુજરાતી' },
    { id: 'btn_terms',     title: '📜 નિયમો અને શરતો',   description: 'પૂરી Terms વાંચો' },
  ],
};

/** Build the WhatsApp list payload for the options row. */
function optionsListSection(lang) {
  const rows = (MENU_LIST_ROWS[lang] || MENU_LIST_ROWS.english).map((r) => ({
    id: r.id,
    title: r.title.substring(0, 24),
    description: r.description.substring(0, 72),
  }));
  return [{ title: M.get('menu_list_section', lang).substring(0, 24), rows }];
}

async function showMainMenu(phone, lang = 'english') {
  console.log(`[MENU] showMainMenu called for ${_rd(phone)} lang=${lang}`);
  // Register contact for broadcasts
  addOrUpdateContact(phone, lang).catch(() => {});

  // Prepend a random casual greeting the FIRST time we show the menu in this session.
  // After that, just show the constant welcome block so it doesn't get repetitive.
  const session = getSession(phone);
  let welcomeText = M.get('welcome', lang);
  const isFirstMenuOfSession = !session.greeted;
  if (isFirstMenuOfSession) {
    const greeting = M.randomGreeting(lang);
    welcomeText = `${greeting}\n\n${welcomeText}`;
    updateSession(phone, { greeted: true });
    console.log(`[MENU] First greeting for ${_rd(phone)}: "${greeting}"`);
  }

  const buttons1 = MENU_BUTTONS[lang] || MENU_BUTTONS.english;

  await sendButtonMessage(phone, welcomeText, buttons1);
  await sendOptionsList(phone, lang);

  console.log(`[MENU] showMainMenu done for ${_rd(phone)}`);
}

/**
 * The options row on its own — no welcome, no greeting.
 *
 * Used when the customer is already mid-conversation and simply needs the
 * choices again (an unrecognised message, or a flow that has just finished).
 * Replaying "Welcome to Chanakya – The Bag Studio, Vadodara's #1 Bag Store
 * since 1996" at someone who booked a repair ninety seconds ago reads like the
 * bot has forgotten them.
 */
async function showQuickMenu(phone, lang = 'english') {
  const buttons1 = MENU_BUTTONS[lang] || MENU_BUTTONS.english;
  await sendButtonMessage(phone, M.get('menu_quick_prompt', lang), buttons1);
  await sendOptionsList(phone, lang);
  console.log(`[MENU] showQuickMenu done for ${_rd(phone)}`);
}

/** The list-message options row, with the T&C link appended to the disclaimer. */
async function sendOptionsList(phone, lang) {
  // The disclaimer carries a real link to the T&Cs, not just "type *terms*".
  // termsLinkLine() is empty when no TERMS_URL/TERMS_DOC_URL is set, in which
  // case the message renders exactly as it did before.
  const termsLine = M.termsLinkLine(lang);
  const bodyText = M.fill(M.get('menu_more_options', lang), {
    terms_link_line: termsLine ? `\n\n${termsLine}` : '',
  });

  return sendListMessage(
    phone,
    M.get('menu_list_header', lang),
    bodyText,
    M.get('menu_list_button', lang),
    optionsListSection(lang),
  );
}

module.exports = { showMainMenu, showQuickMenu };
