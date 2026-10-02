const { sendButtonMessage, sendTextMessage } = require('../services/whatsapp');
const { setRepairUpdatesOptIn, getOpenTicketsForPhone } = require('../services/sheets');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { handleEscalation } = require('./escalate');
const { isRepairUpdatesAnswer } = require('../utils/intentDetect');
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
  // Always ask. Status changes go out as in-session text until Utility
  // templates are approved; skipping this question made it look like the
  // bot had no reminder option at all.
  updateSession(phone, {
    currentFlow: 'repair_updates',
    flowStep: 'ask_optin',
    collectedData: { ticketId },
  });
  const buttons = OPTIN_BUTTONS[lang] || OPTIN_BUTTONS.english;
  return sendButtonMessage(phone, M.get('repair_updates_ask', lang), buttons);
}

/**
 * Handle the yes/no answer to the question above.
 *
 * A typed "yes" / "no" (and the Hindi and Gujarati equivalents) counts. Anything
 * else is NOT an answer: the session is released and the router is told to keep
 * going, so "track" or "menu" after booking actually happens. The old code
 * treated every other message as a silent decline and sent nothing back.
 *
 * @returns {Promise<false|*>} false means "I did not consume this — route it"
 */
async function handleRepairUpdatesAnswer(phone, text, session, intent = null) {
  const lang = session.language || 'english';
  const ticketId = session.collectedData?.ticketId || null;

  // "Talk to a person" is not an answer to the opt-in question. Before this
  // guard it fell into the treat-anything-as-"no" branch below: the customer
  // asked for a human and had a consent decision recorded for them by a
  // message that was never a reply to the question.
  //
  // Deliberately records NOTHING about the opt-in — the ticket keeps its
  // as-created FALSE and the question simply goes unanswered, which is honest.
  // handleEscalation pauses the session, so the customer isn't left mid-flow.
  if (intent === 'escalate') {
    console.log(`[REPAIR-UPDATES] ${_rd(phone)} asked for a human at the opt-in question — handing off, no preference recorded.`);
    return handleEscalation(phone, lang, text);
  }

  const answer = isRepairUpdatesAnswer(text);

  if (answer === 'yes') {
    try {
      await setRepairUpdatesOptIn(phone, true, { ticketId });
      console.log(`[REPAIR-UPDATES] ${_rd(phone)} opted IN for ${ticketId || '(all open)'}`);
    } catch (e) {
      // Leave the question up so they can tap again. Confirming "Done" here
      // was a consent we had not actually stored.
      console.error(`[REPAIR-UPDATES] Failed to opt in ${_rd(phone)}:`, e.message);
      return sendTextMessage(phone, M.get('preference_save_failed', lang));
    }
    clearSession(phone);
    return sendTextMessage(phone, M.get('repair_updates_on_confirm', lang))
      .catch((e) => console.error('[REPAIR-UPDATES] Opt-in confirm failed:', e.message));
  }

  if (answer === 'no') {
    clearSession(phone);
    console.log(`[REPAIR-UPDATES] ${_rd(phone)} declined updates for ${ticketId || '(none)'}`);
    return sendTextMessage(phone, M.get('repair_updates_declined', lang))
      .catch((e) => console.error('[REPAIR-UPDATES] Decline confirm failed:', e.message));
  }

  // Not an answer. Stay opted out (the privacy-safe default) and let the
  // router do what they actually asked — track, repair, the menu, or the
  // ordinary "I didn't get that" prompt. Silence was the bug.
  console.log(`[REPAIR-UPDATES] ${_rd(phone)} left reminders unanswered for ${ticketId || '(none)'}`);
  updateSession(phone, { currentFlow: null, flowStep: null, collectedData: {} });
  session.currentFlow = null;
  session.flowStep = null;
  session.collectedData = {};
  return false;
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
    return sendTextMessage(phone, M.get('preference_save_failed', lang));
  }

  return sendTextMessage(phone,
    M.get(turnOn ? 'repair_updates_on_confirm' : 'repair_updates_off_confirm', lang));
}

module.exports = {
  askRepairUpdatesOptIn,
  handleRepairUpdatesAnswer,
  handleRepairUpdatesCommand,
};
