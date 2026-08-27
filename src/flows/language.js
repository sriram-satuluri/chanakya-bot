const { sendButtonMessage, sendTextMessage } = require('../services/whatsapp');
const { setCustomerLanguage } = require('../services/sheets');
const { getSession, updateSession } = require('../utils/sessionStore');
const { setCachedLanguage } = require('../utils/languagePref');
const M = require('../messages/index');

const _rd = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/** Button ids are stable and language-independent; only the labels differ. */
const LANGUAGE_BUTTONS = [
  { id: 'lang_english',  title: 'English' },
  { id: 'lang_hindi',    title: 'हिंदी' },
  { id: 'lang_gujarati', title: 'ગુજરાતી' },
];

/**
 * Ask the customer to pick a language. Shown automatically on first contact
 * (before anything else), and on demand whenever they type "language".
 * The prompt itself is trilingual since we can't yet know what they read.
 */
async function sendLanguagePicker(phone, lang = 'english') {
  updateSession(phone, { currentFlow: 'language', flowStep: 'pick' });
  return sendButtonMessage(phone, M.get('language_pick', lang), LANGUAGE_BUTTONS);
}

/**
 * Handle a tap on the picker (or a typed language name routed here as the
 * 'language_choice' intent). Persists to Sheets so the choice survives
 * restarts, then drops the customer into the normal main menu.
 *
 * @param {string} text the raw button id, e.g. 'lang_hindi'
 * @returns {Promise<string|null>} the chosen language, or null if unrecognised
 */
async function handleLanguageChoice(phone, text) {
  const m = String(text || '').toLowerCase().match(/^lang_(english|hindi|gujarati)$/);
  if (!m) return null;
  const chosen = m[1];

  // Capture BEFORE we clear the flag — first pick skips the extra "saved" line.
  const wasFirstPick = Boolean(getSession(phone).needsLanguagePick);

  // Session first so any follow-up is already in the new language
  // even if the Sheets write is slow or fails.
  updateSession(phone, {
    language: chosen, currentFlow: null, flowStep: null,
    greeted: false, needsLanguagePick: false,
  });
  setCachedLanguage(phone, chosen);

  try {
    await setCustomerLanguage(phone, chosen);
    console.log(`[LANG] ${_rd(phone)} chose ${chosen} (persisted)`);
  } catch (e) {
    console.error(`[LANG] Failed to persist language for ${_rd(phone)}:`, e.message);
  }

  // First-ever pick: the main menu in their language is the confirmation.
  // Later changes (typed "language") still get an explicit "saved" line.
  if (!wasFirstPick) {
    await sendTextMessage(phone, M.get('language_saved', chosen));
  }
  return chosen;
}

module.exports = { sendLanguagePicker, handleLanguageChoice, LANGUAGE_BUTTONS };
