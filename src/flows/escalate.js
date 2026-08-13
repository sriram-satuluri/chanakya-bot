const { sendTextMessage, sendButtonMessage } = require('../services/whatsapp');
const { updateSession, clearSession } = require('../utils/sessionStore');
const { getOpenTicketsForPhone } = require('../services/sheets');
const { getRecipientsForStore } = require('../utils/ownerPhones');
const { envInt } = require('../utils/env');
const M = require('../messages/index');

const _rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/**
 * Owner-alert cooldown for handoffs.
 *
 * Worth having: the customer-facing reply is cheap and idempotent, but each
 * handoff pings up to THREE people's personal phones. Someone frustrated
 * enough to ask for a human twice is likely to type it several times in a
 * row, and three owners getting five buzzes each is how alerts start being
 * ignored — which defeats the point of the feature.
 *
 * Deliberately throttles ONLY the owner alert. The customer still gets the
 * contact details every single time, so nobody is ever left hanging by a
 * rate limit they can't see.
 */
const HANDOFF_ALERT_COOLDOWN_MS = envInt('HANDOFF_ALERT_COOLDOWN_MINUTES', 30, { min: 0 }) * 60 * 1000;
const _lastHandoffAlertAt = new Map(); // phone -> timestamp
setInterval(() => {
  const cutoff = Date.now() - HANDOFF_ALERT_COOLDOWN_MS * 2;
  for (const [p, ts] of _lastHandoffAlertAt) if (ts < cutoff) _lastHandoffAlertAt.delete(p);
}, 15 * 60 * 1000).unref();

/**
 * Customer asked for a human.
 *
 * Two things happen: the customer gets contact details and the bot steps back
 * (unchanged behaviour), and — new — the right owners are told, with enough
 * context to actually act rather than just a "someone wants you" ping.
 *
 * @param {string} phone
 * @param {string} lang
 * @param {string} [triggerText] the message that asked for a human, for context
 */
async function handleEscalation(phone, lang = 'english', triggerText = '') {
  // Pause bot for this number until the customer sends something else. Handler
  // auto-resumes on the next inbound message so the pause is a soft nudge, not a
  // hard block. See routeMessage in webhook/handler.js.
  updateSession(phone, {
    currentFlow: 'paused',
    flowStep: null,
    fallbackCount: 0,
    lastActivity: Date.now(),
  });

  await sendTextMessage(phone, M.get('escalate_message', lang));
  console.log(`[ESCALATE] Bot paused for ${_rp(phone)}`);

  // Owner notification is best-effort: the customer has already been served,
  // so a failure here must never surface to them or throw.
  notifyOwnersOfHandoff(phone, lang, triggerText).catch((e) =>
    console.error(`[HANDOFF] Owner alert failed for ${_rp(phone)}:`, e.message));
}

/**
 * Tell the right owners that a customer wants a human, with context.
 *
 * Routing (via the shared utils/ownerPhones.getRecipientsForStore helper):
 *   - general owners always
 *   - the branch owner ONLY when this conversation is tied to their branch
 *   - no store context at all -> general owners only, never a guess
 */
async function notifyOwnersOfHandoff(phone, lang, triggerText) {
  // Cooldown check first so a repeat-typer can't buzz three phones repeatedly.
  const last = _lastHandoffAlertAt.get(phone) || 0;
  if (HANDOFF_ALERT_COOLDOWN_MS > 0 && Date.now() - last < HANDOFF_ALERT_COOLDOWN_MS) {
    console.log(`[HANDOFF] Owner alert suppressed for ${_rp(phone)} (cooldown active) — customer still got contact details.`);
    return;
  }

  // Store context comes from an open ticket in this conversation, if any.
  let ticket = null;
  try {
    const open = await getOpenTicketsForPhone(phone);
    // Most recently created open ticket is the one they're most likely calling about.
    ticket = open.length ? open[open.length - 1] : null;
  } catch (e) {
    console.warn(`[HANDOFF] Ticket lookup failed for ${_rp(phone)} (alerting general owners only):`, e.message);
  }

  const recipients = getRecipientsForStore(ticket?.store);
  if (!recipients.length) {
    console.warn('[HANDOFF] No owner numbers configured — nobody was alerted.');
    return;
  }

  const lines = [
    '🙋 *Customer wants to talk to a person*',
    '',
    `📞 *Phone:* ${phone}`,
  ];
  if (ticket?.customerName) lines.push(`👤 *Name:* ${ticket.customerName}`);
  if (ticket?.ticketId) lines.push(`🎫 *Ticket:* ${ticket.ticketId} (${ticket.status || 'status unknown'})`);
  if (ticket?.store) lines.push(`🏪 *Store:* ${ticket.store}`);
  if (!ticket) lines.push('🎫 *Ticket:* none open — general enquiry');
  lines.push(`🌐 *Language:* ${lang}`);
  if (triggerText && triggerText !== '__IMAGE__') {
    lines.push('', `💬 *They said:* "${String(triggerText).replace(/\s+/g, ' ').trim().slice(0, 300)}"`);
  }
  lines.push('', '_The bot has paused for this customer and shared your contact details._');
  const msg = lines.join('\n');

  _lastHandoffAlertAt.set(phone, Date.now());
  for (const ownerPhone of recipients) {
    await sendTextMessage(ownerPhone, msg).catch((e) =>
      console.error(`[HANDOFF] Failed to alert owner ${_rp(ownerPhone)}:`, e.message));
  }
  console.log(
    `[HANDOFF] Alerted ${recipients.length} owner(s) for ${_rp(phone)} `
    + `(store=${ticket?.store || 'none'}, ticket=${ticket?.ticketId || 'none'})`,
  );
}

async function handleFallback(phone, lang = 'english', fallbackCount = 1) {
  if (fallbackCount >= 3) {
    // Offer human after 3 failed attempts, then reset the counter so tapping
    // "Menu" and coming back doesn't insta-trigger the same escalation offer.
    updateSession(phone, { fallbackCount: 0 });
    const msg = M.get('fallback_offer_human', lang);
    const buttons = {
      english:  [{ id: 'btn_human', title: '👤 Talk to Team' },     { id: 'btn_main_menu', title: '🏠 Menu' }],
      hindi:    [{ id: 'btn_human', title: '👤 टीम से बात करें' },   { id: 'btn_main_menu', title: '🏠 मेनू' }],
      gujarati: [{ id: 'btn_human', title: '👤 ટીમ સાથે વાત' }, { id: 'btn_main_menu', title: '🏠 મેનુ' }],
    };
    return sendButtonMessage(phone, msg, buttons[lang] || buttons.english);
  }

  // Show main menu with gentle message
  const msg = M.get('fallback_once', lang);
  const { showMainMenu } = require('./mainMenu');
  await sendTextMessage(phone, msg);
  return showMainMenu(phone, lang);
}

module.exports = { handleEscalation, handleFallback, notifyOwnersOfHandoff };
