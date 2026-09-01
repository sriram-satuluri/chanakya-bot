const { sendTextMessage, sendLocationMessage, sendButtonMessage } = require('../services/whatsapp');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { googleMapsDrivingDirectionsUrl } = require('../utils/mapsUrls');
const { handleEscalation } = require('./escalate');
const {
  directoryWithEmailForBranch,
  directoryWithEmailAndWebForBranch,
} = require('../constants/publicContact');
const M = require('../messages/index');

const FLOW = 'store_location';

/** Same coordinates as repair pick-up stores; button ids are unique to this flow. */
const STORES_BY_BUTTON = {
  btn_dir_alkapuri: {
    name:    'Chanakya Bag Studio — Alkapuri',
    short:   'Alkapuri',
    address: 'Near Race Course Circle, Race Course Road, Vadodara',
    lat:     22.3122,
    lng:     73.1647,
  },
  btn_dir_sursagar: {
    name:    'Chanakya Bag Studio — Sursagar',
    short:   'Sursagar',
    address: 'Opp. Pratap Talkies, Opp. Sursagar Lake (East), Vadodara 390001',
    lat:     22.3013,
    lng:     73.2045,
  },
};

const DIR_BUTTONS = {
  english:  [
    { id: 'btn_dir_alkapuri', title: '📍 Alkapuri' },
    { id: 'btn_dir_sursagar', title: '📍 Sursagar' },
  ],
  hindi:    [
    { id: 'btn_dir_alkapuri', title: '📍 Alkapuri' },
    { id: 'btn_dir_sursagar', title: '📍 Sursagar' },
  ],
  gujarati: [
    { id: 'btn_dir_alkapuri', title: '📍 Alkapuri' },
    { id: 'btn_dir_sursagar', title: '📍 Sursagar' },
  ],
};

/** @param {'alkapuri'|'sursagar'} slug */
function contactBlock(lang, slug) {
  if (lang === 'english') {
    return `📞 *Contact:*\n${directoryWithEmailAndWebForBranch(slug)}`;
  }
  return `📞 *Contact:*\n${directoryWithEmailForBranch(slug)}`;
}

async function sendStorePicker(phone, lang) {
  updateSession(phone, { currentFlow: FLOW, flowStep: 'pick_store', collectedData: {} });
  await sendTextMessage(phone, M.get('store_intro', lang));
  const buttons = DIR_BUTTONS[lang] || DIR_BUTTONS.english;
  return sendButtonMessage(phone, M.get('store_pick_directions', lang), buttons);
}

/**
 * @param {string} phone
 * @param {string} text
 * @param {object} session
 * @param {string | null} [intent]
 */
/** True for the two store-direction payloads. */
function isDirectionButton(text) {
  return text === 'btn_dir_alkapuri' || text === 'btn_dir_sursagar';
}

/**
 * Send one store's address, map pin and contacts. A STATELESS lookup — it
 * reads nothing and writes nothing about the customer.
 *
 * This used to be reachable only while the session sat on
 * flowStep 'pick_store'. But the flow calls clearSession() the moment it
 * answers, so the very next tap — even on the SAME store — arrived with no
 * flow at all, matched nothing, and the customer got "It seems I'm having
 * trouble understanding" for pressing a button the bot had just sent them.
 * These buttons stay visible in the chat forever, so they must work forever.
 */
async function sendStoreInfo(phone, buttonId, lang) {
  const store = STORES_BY_BUTTON[buttonId];
  if (!store) return sendStorePicker(phone, lang);

  const branchSlug = buttonId === 'btn_dir_sursagar' ? 'sursagar' : 'alkapuri';
  const url = googleMapsDrivingDirectionsUrl(store.lat, store.lng);

  await sendTextMessage(phone, M.fill(M.get('store_directions_cta', lang), {
    storeName: store.short,
    url,
  }));
  await sendLocationMessage(phone, store.lat, store.lng, store.name, store.address);
  await sendTextMessage(phone, contactBlock(lang, branchSlug));

  const backButtons = {
    english:  [{ id: 'btn_main_menu', title: '🏠 Main Menu' },    { id: 'btn_repair', title: '🔧 Repair My Bag' }],
    hindi:    [{ id: 'btn_main_menu', title: '🏠 मुख्य मेनू' },    { id: 'btn_repair', title: '🔧 बैग रिपेयर' }],
    gujarati: [{ id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' }, { id: 'btn_repair', title: '🔧 બેગ રિપેર' }],
  };
  return sendButtonMessage(phone, M.get('interactive_choose_next', lang), backButtons[lang] || backButtons.english);
}

/**
 * @param {string} phone
 * @param {string} text
 * @param {object} session
 * @param {string | null} [intent]
 */
async function handleStoreLocations(phone, text, session, intent = null) {
  const lang = session.language || 'english';

  // Asking for a human outranks the store picker. Without this, "talk to a
  // person" typed while choosing a store just re-sent the two direction
  // buttons — the request was silently discarded. Matches the guard the
  // repair / track / catalog / corporate flows already have.
  if (intent === 'escalate') return handleEscalation(phone, lang, text);

  // A direction tap is answered wherever it arrives.
  if (isDirectionButton(text)) {
    await sendStoreInfo(phone, text, lang);
    // Only tidy up the session if THIS flow owned it. A customer who tapped a
    // direction button while half-way through booking a repair must find that
    // booking exactly where they left it.
    if (session.currentFlow === FLOW) clearSession(phone);
    return;
  }

  const inPick = session.currentFlow === FLOW && session.flowStep === 'pick_store';
  if (!inPick) return sendStorePicker(phone, lang);

  // Still choosing: explicit store intent or “Locations” again → refresh picker
  if (text === 'btn_location' || intent === 'store_location') {
    return sendStorePicker(phone, lang);
  }

  return sendButtonMessage(
    phone,
    M.get('store_pick_directions', lang),
    DIR_BUTTONS[lang] || DIR_BUTTONS.english,
  );
}

module.exports = { handleStoreLocations };
