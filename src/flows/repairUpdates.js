const { sendButtonMessage, sendTextMessage } = require('../services/whatsapp');
const { setRepairUpdatesOptIn, getOpenTicketsForPhone } = require('../services/sheets');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { repairUpdatesReady } = require('../utils/metaTemplates');
const { handleEscalation } = require('./escalate');
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
  // Don't promise WhatsApp updates we cannot send (unapproved templates would
  // fail 3× and silently unsubscribe them).
  if (!repairUpdatesReady()) {
    return askForPhoto(phone, lang);
  }
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
async function handleRepairUpdatesAnswer(phone, text, session, intent = null) {
  const lang = session.language || 'english';
  const ticketId = session.collectedData?.ticketId || null;
  const choice = String(text || '').toLowerCase();

  // "Talk to a person" is not an answer to the opt-in question. Before this
  // guard it fell into the treat-anything-as-"no" branch below: the customer
  // asked for a human, got a photo request, and had a consent decision
  // recorded for them by a message that was never a reply to the question.
  //
  // Deliberately records NOTHING about the opt-in — the ticket keeps its
  // as-created FALSE and the question simply goes unanswered, which is honest.
  // handleEscalation pauses the session, so the customer isn't left mid-flow.
  if (intent === 'escalate') {
    console.log(`[REPAIR-UPDATES] ${_rd(phone)} asked for a human at the opt-in question — handing off, no preference recorded.`);
    return handleEscalation(phone, lang, text);
  }

  clearSession(phone);

  if (choice === 'ru_yes') {
    try {
      await setRepairUpdatesOptIn(phone, true, { ticketId });
      console.log(`[REPAIR-UPDATES] ${_rd(phone)} opted IN for ${ticketId || '(all open)'}`);
    } catch (e) {
      console.error(`[REPAIR-UPDATES] Failed to opt in ${_rd(phone)}:`, e.message);
    }
    await sendTextMessage(phone, M.get('repair_updates_on_confirm', lang));
    return askForPhoto(phone, lang);
  }

  // Explicit "no", or any other reply — leave opted_in FALSE (as created).
  console.log(`[REPAIR-UPDATES] ${_rd(phone)} declined updates for ${ticketId || '(none)'}`);
  return askForPhoto(phone, lang);
}

/**
 * Ask for the before-photo — the LAST thing in the booking, after the ticket
 * already exists. Deliberately does NOT park the session: the photo is
 * optional and may arrive days later, so it is picked up by the late-photo
 * handler in webhook/handler.js instead of a flow step that could trap the
 * customer or be lost on restart.
 */
async function askForPhoto(phone, lang) {
  return sendTextMessage(phone, M.get('photo_request_after_ticket', lang))
    .catch((e) => console.error('[REPAIR-UPDATES] Photo request failed:', e.message));
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
