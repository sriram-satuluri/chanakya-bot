const { sendButtonMessage, sendTextMessage } = require('../services/whatsapp');
const { setRepairUpdatesOptIn, getOpenTicketsForPhone } = require('../services/sheets');
const { updateSession, clearSession } = require('../utils/sessionStore');
const M = require('../messages/index');

const _rd = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

const OPTIN_BUTTONS = {
  english:  [{ id: 'ru_yes', title: '🔔 Yes, update me' }, { id: 'ru_no', title: "🙅 No, I'll check" }],
  hindi:    [{ id: 'ru_yes', title: '🔔 हाँ, अपडेट भेजें' }, { id: 'ru_no', title: '🙅 नहीं, खुद देखूंगा' }],
  gujarati: [{ id: 'ru_yes', title: '🔔 હા, અપડેટ મોકલો' }, { id: 'ru_no', title: '🙅 ના, જાતે જોઈશ' }],
};

/**
 * Asked once, right after a repair ticket is created: does this customer want
 * proactive WhatsApp updates, or would they rather check themselves?
 * Parks the session on 'repair_updates' so the reply routes back here.
 */
async function askRepairUpdatesOptIn(phone, lang, ticketId) {
  updateSession(phone, {
    currentFlow: 'repair_updates',
    flowStep: 'ask_optin',
    collectedData: { ticketId },
  });
  const buttons = OPTIN_BUTTONS[lang] || OPTIN_BUTTONS.english;
  return sendButtonMessage(phone, M.get('repair_updates_ask', lang), buttons);
}

/**
 * Handle the yes/no answer to the question above. Anything unrecognised is
 * treated as "no" and the session is released, so a customer who ignores the
 * question and types something else is never trapped in this flow — they just
 * don't get opted in (the privacy-safe default).
 */
async function handleRepairUpdatesAnswer(phone, text, session) {
  const lang = session.language || 'english';
  const ticketId = session.collectedData?.ticketId || null;
  const choice = String(text || '').toLowerCase();

  clearSession(phone);

  if (choice === 'ru_yes') {
    try {
      await setRepairUpdatesOptIn(phone, true, { ticketId });
      console.log(`[REPAIR-UPDATES] ${_rd(phone)} opted IN for ${ticketId || '(all open)'}`);
    } catch (e) {
      console.error(`[REPAIR-UPDATES] Failed to opt in ${_rd(phone)}:`, e.message);
    }
    return sendTextMessage(phone, M.get('repair_updates_on_confirm', lang));
  }

  // Explicit "no", or any other reply — leave opted_in FALSE (as created).
  console.log(`[REPAIR-UPDATES] ${_rd(phone)} declined updates for ${ticketId || '(none)'}`);
  return null;
}

/**
 * Standing "stop updates" / "resume updates" command, available at any time and
 * independent of ticket creation. Applies to every open ticket on the number.
 * @param {boolean} turnOn
 */
async function handleRepairUpdatesCommand(phone, lang, turnOn) {
  let open = [];
  try {
    open = await getOpenTicketsForPhone(phone);
  } catch (e) {
    console.error(`[REPAIR-UPDATES] Lookup failed for ${_rd(phone)}:`, e.message);
    return sendTextMessage(phone, M.get('repair_updates_none_open', lang));
  }

  if (open.length === 0) {
    return sendTextMessage(phone, M.get('repair_updates_none_open', lang));
  }

  try {
    const changed = await setRepairUpdatesOptIn(phone, turnOn, { stopReason: 'opted_out' });
    console.log(`[REPAIR-UPDATES] ${_rd(phone)} turned updates ${turnOn ? 'ON' : 'OFF'} for ${changed} ticket(s)`);
  } catch (e) {
    // Don't claim success we didn't achieve — this is a consent action.
    console.error(`[REPAIR-UPDATES] Failed to toggle for ${_rd(phone)}:`, e.message);
    return sendTextMessage(phone,
      'Sorry, we could not update your preference right now. Please send this again in a few minutes.');
  }

  return sendTextMessage(phone,
    M.get(turnOn ? 'repair_updates_on_confirm' : 'repair_updates_off_confirm', lang));
}

module.exports = {
  askRepairUpdatesOptIn,
  handleRepairUpdatesAnswer,
  handleRepairUpdatesCommand,
};
