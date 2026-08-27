const { sendTextMessage } = require('../services/whatsapp');
const { findTicketAwaitingRating, recordFeedbackState } = require('../services/sheets');
const { getRecipientsForStore } = require('../utils/ownerPhones');
const { notifyOwners } = require('../utils/ownerAlert');
const { envInt } = require('../utils/env');
const M = require('../messages/index');

const _rp = (p) => (p && p.length > 4) ? '***' + p.slice(-4) : '***';

/**
 * At or below this rating, owners are alerted immediately so a bad experience
 * has a chance of same-day recovery. 2 on a 1-5 scale: 1 and 2 are the two
 * unambiguously-unhappy points, 3 is lukewarm and doesn't warrant waking
 * three people up.
 */
const LOW_RATING_THRESHOLD = envInt('LOW_RATING_THRESHOLD', 2, { min: 1, max: 5 });

/**
 * Record a 1-5 rating and, if it's low, alert the right owners.
 *
 * The rating is stored either way — good ratings are the baseline that makes
 * the bad ones meaningful, and they're worth having as a record even when
 * they trigger nothing.
 *
 * @param {number} rating 1-5
 * @returns {Promise<boolean>} whether a rating was actually recorded
 */
async function handleRatingReply(phone, rating, lang = 'english') {
  const value = Number(rating);
  if (!Number.isInteger(value) || value < 1 || value > 5) return false;

  let ticket;
  try {
    ticket = await findTicketAwaitingRating(phone);
  } catch (e) {
    console.error(`[FEEDBACK] Lookup failed for ${_rp(phone)}:`, e.message);
    return false;
  }
  // No outstanding request → this wasn't a rating, just a stray number.
  if (!ticket) return false;

  try {
    await recordFeedbackState(ticket.rowIndex, { rating: value, ratingAt: new Date() });
  } catch (e) {
    // Don't thank them for feedback we failed to store.
    console.error(`[FEEDBACK] Failed to store rating for ${ticket.ticketId}:`, e.message);
    return false;
  }

  console.log(`[FEEDBACK] ticket=${ticket.ticketId} phone=${_rp(phone)} rating=${value}/5 stored`);

  const isLow = value <= LOW_RATING_THRESHOLD;
  await sendTextMessage(phone, M.get(isLow ? 'feedback_thanks_low' : 'feedback_thanks', lang))
    .catch((e) => console.error('[FEEDBACK] Thank-you send failed:', e.message));

  if (isLow) await alertOwnersOfLowRating(ticket, value).catch((e) =>
    console.error(`[FEEDBACK] Low-rating alert failed for ${ticket.ticketId}:`, e.message));

  return true;
}

/**
 * Same routing as the handoff alert (utils/ownerPhones.getRecipientsForStore):
 * general owners always, branch owner only when the ticket's store is theirs.
 */
async function alertOwnersOfLowRating(ticket, rating) {
  const recipients = getRecipientsForStore(ticket.store);
  if (!recipients.length) {
    console.warn('[FEEDBACK] No owner numbers configured — low rating not escalated.');
    return;
  }
  const msg = [
    `⚠️ *Low feedback rating — ${rating}/5*`,
    '',
    `🎫 *Ticket:* ${ticket.ticketId}`,
    ticket.customerName ? `👤 *Customer:* ${ticket.customerName}` : null,
    `📞 *Phone:* ${ticket.phone}`,
    ticket.store ? `🏪 *Store:* ${ticket.store}` : null,
    '',
    '_Bag was collected and the customer is unhappy. Worth a call today while it can still be put right._',
  ].filter(Boolean).join('\n');

  const { sent } = await notifyOwners(recipients, msg, {
    kind: 'low_rating',
    ref: ticket.ticketId,
  });
  console.log(
    `[LOW-RATING] ticket=${ticket.ticketId} rating=${rating}/5 store=${ticket.store || 'unknown'} `
    + `— reached ${sent}/${recipients.length} owner(s)`,
  );
}

module.exports = { handleRatingReply, LOW_RATING_THRESHOLD };
