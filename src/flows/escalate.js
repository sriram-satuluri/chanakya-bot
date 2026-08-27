const { sendTextMessage, sendButtonMessage } = require('../services/whatsapp');
const { updateSession } = require('../utils/sessionStore');
const { getOpenTicketsForPhone } = require('../services/sheets');
const { getRecipientsForStore, branchSlugFromStoreHint } = require('../utils/ownerPhones');
const { notifyOwners } = require('../utils/ownerAlert');
const { directoryWithEmail, directoryWithEmailForBranch } = require('../constants/publicContact');
const { envInt } = require('../utils/env');
const { getTimestamp, setTimestamp } = require('../utils/throttleStore');
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

/**
 * How long the customer-facing reply will wait on Sheets to find out WHICH
 * branch this handoff belongs to.
 *
 * Knowing the branch lets us show the right people (Sursagar's directory
 * includes Nilesh; Alkapuri's does not). But someone who has just asked for a
 * human is the last person who should be made to wait on a spreadsheet, and
 * the pre-existing contract of this function was that the customer is served
 * immediately. So the lookup RACES this timeout: win and they get the precise
 * branch directory, lose and they get the general one — which is exactly what
 * this message showed before. Never an error, never a delay worth noticing.
 *
 * Set 0 to skip the lookup entirely and always use the general directory.
 */
const HANDOFF_BRANCH_LOOKUP_MS = envInt('HANDOFF_BRANCH_LOOKUP_MS', 1500, { min: 0 });

/** Resolve `promise` or give up after ms. Never rejects. */
function raceTimeout(promise, ms) {
  return Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref?.(); }),
  ]);
}

/**
 * Which branch should this customer's handoff show contacts for?
 * Their most recent open ticket decides. No ticket, a slow sheet, or an
 * unrecognised store name all fall back to null → general directory.
 * @returns {Promise<'alkapuri'|'sursagar'|null>}
 */
async function branchForHandoff(phone) {
  if (HANDOFF_BRANCH_LOOKUP_MS <= 0) return null;
  // noRetry: the Sheets retry sleeps 450ms + 900ms of backoff before its third
  // attempt, which on its own outlasts this budget. Retrying here would not
  // rescue a single lookup — it would just guarantee the timeout fires and the
  // customer silently loses their branch's contacts (Nilesh, for Sursagar)
  // precisely when Sheets is struggling. One clean attempt, then fall back.
  const open = await raceTimeout(
    getOpenTicketsForPhone(phone, { noRetry: true }),
    HANDOFF_BRANCH_LOOKUP_MS,
  );
  if (!open) {
    console.warn(`[HANDOFF] Branch lookup for ${_rp(phone)} timed out or failed — using general contacts.`);
    return null;
  }
  const ticket = open.length ? open[open.length - 1] : null;
  return branchSlugFromStoreHint(ticket?.store);
}

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

  // Show the RIGHT people: a Sursagar customer needs Nilesh's number, an
  // Alkapuri one does not. Time-boxed — see HANDOFF_BRANCH_LOOKUP_MS.
  const branchSlug = await branchForHandoff(phone);
  const contactBlock = branchSlug
    ? directoryWithEmailForBranch(branchSlug)
    : directoryWithEmail();

  await sendTextMessage(phone, M.fill(M.get('escalate_message', lang), { contactBlock }));
  console.log(`[ESCALATE] Bot paused for ${_rp(phone)} (contacts: ${branchSlug || 'general'})`);

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
  const last = getTimestamp('handoff', phone);
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

  setTimestamp('handoff', phone);
  const { sent } = await notifyOwners(recipients, msg, {
    kind: 'human_handoff',
    ref: ticket?.ticketId || 'no-ticket',
  });
  console.log(
    `[HANDOFF] Reached ${sent}/${recipients.length} owner(s) for ${_rp(phone)} `
    + `(store=${ticket?.store || 'none'}, ticket=${ticket?.ticketId || 'none'})`,
  );
}

/**
 * Consecutive unresolved messages before we stop apologising and offer a human.
 *
 * Two, not three. Repeating "Sorry, I didn't quite get that" a third time is
 * the point at which a person concludes the bot is useless and leaves — and
 * the third apology has never once been the message that unblocked anyone.
 * Note this only counts genuinely unresolved input: valid button taps that
 * happen to route through the fallback intent no longer increment it (see the
 * flow-owned id checks in utils/intentDetect.js).
 */
const FALLBACK_BEFORE_HUMAN = envInt('FALLBACK_BEFORE_HUMAN', 2, { min: 1 });

async function handleFallback(phone, lang = 'english', fallbackCount = 1) {
  const { showQuickMenu } = require('./mainMenu');

  if (fallbackCount >= FALLBACK_BEFORE_HUMAN) {
    // Reset so tapping "Menu" and coming back doesn't insta-trigger this again.
    updateSession(phone, { fallbackCount: 0 });
    // Talk to a Person leads — at this point it is the useful option, not the
    // afterthought, so it should not be the second button.
    const buttons = {
      english:  [{ id: 'btn_human', title: '👤 Talk to a Person' }, { id: 'btn_main_menu', title: '🏠 Menu' }],
      hindi:    [{ id: 'btn_human', title: '👤 स्टाफ से बात करें' },  { id: 'btn_main_menu', title: '🏠 मेनू' }],
      gujarati: [{ id: 'btn_human', title: '👤 સ્ટાફ સાથે વાત' },   { id: 'btn_main_menu', title: '🏠 મેનુ' }],
    };
    return sendButtonMessage(phone, M.get('fallback_offer_human', lang), buttons[lang] || buttons.english);
  }

  // First miss: quick menu only. showQuickMenu deliberately skips the welcome
  // block — someone who has been chatting for five minutes should not be
  // re-introduced to the shop because they typed something we didn't parse.
  await sendTextMessage(phone, M.get('fallback_once', lang));
  return showQuickMenu(phone, lang);
}

module.exports = { handleEscalation, handleFallback, notifyOwnersOfHandoff };
