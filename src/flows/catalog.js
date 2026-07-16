const { sendTextMessage, sendButtonMessage, sendListMessage } = require('../services/whatsapp');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { handleEscalation } = require('./escalate');
const { defaultCallLine } = require('../constants/publicContact');
const { CATEGORIES, categoryUrl, browseAllUrl, CATALOG_SITE } = require('../constants/catalogCategories');
const M = require('../messages/index');

// We deep-link customers to the website rather than try to render 100+ products
// inside WhatsApp — the website is the live source of truth (front.chanakyacorporate.com).

async function handleCatalogFlow(phone, text, session, intent = null) {
  const lang = session.language || 'english';

  if (intent === 'escalate') return handleEscalation(phone, lang);

  // Start of catalog flow — show category picker
  if (!session.currentFlow || session.currentFlow !== 'catalog') {
    updateSession(phone, { currentFlow: 'catalog', flowStep: 'ask_category', collectedData: {} });
    return sendCategoryMenu(phone, lang);
  }

  const step = session.flowStep;

  switch (step) {
    case 'ask_category': {
      // Browse-all shortcut
      if (text === 'cat_all') {
        return sendBrowseAll(phone, lang);
      }
      const cat = resolveCategory(text, lang);
      if (!cat) {
        // Bad input → re-prompt
        return sendCategoryMenu(phone, lang);
      }
      return sendCategoryLink(phone, lang, cat);
    }

    default:
      clearSession(phone);
      const { showMainMenu } = require('./mainMenu');
      return showMainMenu(phone, lang);
  }
}

/* ---------- category picker ---------- */

const SECTION_TITLES = {
  english:  { bags: '🎒 Bags & Travel',   gifts: '🎁 Gifts & Lifestyle', home:  '🏠 Home & Seasonal' },
  hindi:    { bags: '🎒 बैग और ट्रॅवल',     gifts: '🎁 गिफ्ट और लाइफस्टाइल', home:  '🏠 होम और सीज़नल' },
  gujarati: { bags: '🎒 બેગ અને ટ્રાવેલ', gifts: '🎁 ગિફ્ટ અને લાઇફસ્ટાઇલ', home:  '🏠 હોમ અને સીઝનલ' },
};

const HEADER = {
  english:  '🛍️ Shop at Chanakya',
  hindi:    '🛍️ Chanakya पर खरीदें',
  gujarati: '🛍️ Chanakya પર ખરીદો',
};

const BODY = {
  english:  `Pick a category — we'll open it on our website so you can browse the full range with photos and prices.\n\n_Online se Sasta Offline Store! 🏆_`,
  hindi:    `कोई category चुनिए — हम आपको हमारी website पर पूरी range फोटो और कीमत के साथ दिखाएंगे।\n\n_Online se Sasta Offline Store! 🏆_`,
  gujarati: `કોઈ category પસંદ કરો — અમે તમને અમારી website પર આખી range ફોટો અને કિંમત સાથે બતાવીશું.\n\n_Online se Sasta Offline Store! 🏆_`,
};

const PICKER_BTN = { english: 'Select Category', hindi: 'श्रेणी चुनें', gujarati: 'Category પસંદ કરો' };

async function sendCategoryMenu(phone, lang) {
  // WhatsApp interactive lists allow a *total* of 10 rows across all sections —
  // not 10 per section. We pick the 8 most popular bag-store categories plus a
  // "Browse All" link to the website for everything else.
  const bags  = ['Travelling Bags', 'Backpack', 'Office Bags', 'Helmet'];
  const gifts = ['Accessories', 'Corporate Gift Articles', 'Birthday Gifts', 'Electronic'];

  const rowsFor = (apiNames) =>
    apiNames
      .map(apiName => CATEGORIES.find(c => c.apiName === apiName))
      .filter(Boolean)
      .map((cat) => {
        const display = cat[lang] || cat.english;
        return {
          id:    `cat_${CATEGORIES.indexOf(cat)}`,
          title: display.substring(0, 24),
        };
      });

  const titles = SECTION_TITLES[lang] || SECTION_TITLES.english;
  const browseTitle = {
    english:  '🌐 Browse All Online',
    hindi:    '🌐 सभी देखें (Online)',
    gujarati: '🌐 બધું જુઓ (Online)',
  };
  const moreTitle = {
    english:  '🌐 More',
    hindi:    '🌐 अधिक',
    gujarati: '🌐 વધુ',
  };

  // 4 + 4 + 1 = 9 rows total (WhatsApp max is 10)
  const sections = [
    { title: titles.bags,  rows: rowsFor(bags)  },
    { title: titles.gifts, rows: rowsFor(gifts) },
    { title: moreTitle[lang] || moreTitle.english, rows: [
      { id: 'cat_all', title: (browseTitle[lang] || browseTitle.english).substring(0, 24) },
    ] },
  ];

  return sendListMessage(
    phone,
    HEADER[lang] || HEADER.english,
    BODY[lang]   || BODY.english,
    PICKER_BTN[lang] || PICKER_BTN.english,
    sections,
  );
}

/* ---------- category link-out ---------- */

async function sendCategoryLink(phone, lang, cat) {
  const url = categoryUrl(cat);
  const display = cat[lang] || cat.english;

  const body = {
    english:
      `Here's our full range of *${display}* — tap the link to browse on our website:\n\n${url}\n\n` +
      `💡 *Online se Sasta Offline Store!*\nVisit our stores to see them in person:\n` +
      `⏰ 10 AM – 9 PM (Mon – Sun)\n${defaultCallLine()}`,
    hindi:
      `यहाँ है *${display}* की पूरी range — link पर tap करके website पर देखिए:\n\n${url}\n\n` +
      `💡 *Online से सस्ता Offline Store!*\nखुद देखने स्टोर पर आइए:\n` +
      `⏰ सुबह 10 – रात 9 (सोम–रवि)\n${defaultCallLine()}`,
    gujarati:
      `અહીં છે *${display}* ની આખી range — link પર tap કરીને website પર જુઓ:\n\n${url}\n\n` +
      `💡 *Online થી સસ્તું Offline Store!*\nરૂબરૂ જોવા સ્ટોર પર આવો:\n` +
      `⏰ સવારે 10 – રાત 9 (સોમ–રવિ)\n${defaultCallLine()}`,
  };
  await sendTextMessage(phone, body[lang] || body.english);

  const backButtons = {
    english:  [
      { id: 'btn_shop',      title: '🛍️ Other Category' },
      { id: 'btn_location',  title: '🗺️ Directions' },
      { id: 'btn_main_menu', title: '🏠 Main Menu' },
    ],
    hindi:    [
      { id: 'btn_shop',      title: '🛍️ अन्य श्रेणी' },
      { id: 'btn_location',  title: '🗺️ रास्ता' },
      { id: 'btn_main_menu', title: '🏠 मेनू' },
    ],
    gujarati: [
      { id: 'btn_shop',      title: '🛍️ બીજી category' },
      { id: 'btn_location',  title: '🗺️ રસ્તો' },
      { id: 'btn_main_menu', title: '🏠 મેનુ' },
    ],
  };

  clearSession(phone);
  return sendButtonMessage(phone, M.get('interactive_choose_next', lang), backButtons[lang] || backButtons.english);
}

async function sendBrowseAll(phone, lang) {
  const url = browseAllUrl();
  const msg = {
    english:
      `🛍️ Our *full catalogue* is online — browse hundreds of products with photos and prices:\n\n${url}\n\n` +
      `💡 *Online se Sasta Offline Store!*\nVisit our stores: 10 AM – 9 PM\n${defaultCallLine()}`,
    hindi:
      `🛍️ हमारा *पूरा catalogue* online है — सैकड़ों products फोटो और कीमत के साथ:\n\n${url}\n\n` +
      `💡 *Online से सस्ता Offline Store!*\nस्टोर: सुबह 10 – रात 9\n${defaultCallLine()}`,
    gujarati:
      `🛍️ અમારું *આખું catalogue* online છે — સેંકડો products ફોટો અને કિંમત સાથે:\n\n${url}\n\n` +
      `💡 *Online થી સસ્તું Offline Store!*\nStore: સવારે 10 – રાત 9\n${defaultCallLine()}`,
  };
  await sendTextMessage(phone, msg[lang] || msg.english);

  const backButtons = {
    english:  [
      { id: 'btn_shop',      title: '🛍️ By Category' },
      { id: 'btn_location',  title: '🗺️ Directions' },
      { id: 'btn_main_menu', title: '🏠 Main Menu' },
    ],
    hindi:    [
      { id: 'btn_shop',      title: '🛍️ श्रेणी से' },
      { id: 'btn_location',  title: '🗺️ रास्ता' },
      { id: 'btn_main_menu', title: '🏠 मेनू' },
    ],
    gujarati: [
      { id: 'btn_shop',      title: '🛍️ category થી' },
      { id: 'btn_location',  title: '🗺️ રસ્તો' },
      { id: 'btn_main_menu', title: '🏠 મેનુ' },
    ],
  };

  clearSession(phone);
  return sendButtonMessage(phone, M.get('interactive_choose_next', lang), backButtons[lang] || backButtons.english);
}

/* ---------- resolution helpers ---------- */

function resolveCategory(text, lang) {
  if (!text) return null;
  // cat_<index> from list_reply
  const match = text.match(/^cat_(\d+)$/);
  if (match) {
    const idx = parseInt(match[1], 10);
    return CATEGORIES[idx] || null;
  }
  // Text fallback — accept any of the display names (any language) or the API name
  const t = text.toLowerCase().trim();
  return CATEGORIES.find(c =>
    c.apiName.toLowerCase() === t
    || stripEmoji(c.english).toLowerCase().trim() === t
    || stripEmoji(c.hindi).toLowerCase().trim() === t
    || stripEmoji(c.gujarati).toLowerCase().trim() === t
  ) || null;
}

function stripEmoji(s) {
  // Strip leading emoji characters so "🎒 Backpacks" matches "Backpacks"
  return String(s || '').replace(/^[^\p{L}\p{N}]+/u, '');
}

module.exports = { handleCatalogFlow };
