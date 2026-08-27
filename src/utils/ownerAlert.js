/**
 * The single path for every owner-facing alert.
 *
 * WHY THIS EXISTS: owner alerts are free-form WhatsApp messages, which Meta
 * only delivers inside the 24-hour customer-service window. If an owner has
 * not messaged the bot in 24h, Meta rejects the send with 131047 and the alert
 * is simply gone — no ticket notification, no low-rating warning, no "the bot
 * is down" page. Every call site used to swallow that into a generic
 * `.catch(e => console.error(...))`, so the single most consequential failure
 * mode in the system looked identical to a typo in a phone number.
 *
 * Six places send owner alerts (new ticket, new corporate lead, human handoff,
 * low rating, health check, auto-unsubscribe). Rather than repeat the same
 * error branch six times, they all come through here, and a window failure is
 * logged under one distinctive tag:
 *
 *   [OWNER-ALERT-LOST]
 *
 * Grep for that and you have every alert that never reached a human, with the
 * kind of alert and which owner missed it. That is also the natural place to
 * hang a retry queue or an approved-template fallback later — one change here
 * rather than six.
 */

const { sendTextMessage, isOutsideWindowError } = require('../services/whatsapp');

/** Redact to last-4 — hosted log tails must not accumulate full numbers. */
const _rp = (p) => (p && String(p).length > 4) ? '***' + String(p).slice(-4) : '***';

/**
 * Send one owner alert. Never throws — alerting is best-effort by definition,
 * and the customer-facing work that triggered it has already happened.
 *
 * @param {string} ownerPhone
 * @param {string} message
 * @param {{kind: string, ref?: string}} context
 *   kind — what sort of alert this is ('new_ticket', 'low_rating', …). Appears
 *          in the log line so a lost alert names itself.
 *   ref  — optional ticket / lead id for correlation.
 * @returns {Promise<boolean>} whether it was accepted by Meta
 */
async function notifyOwner(ownerPhone, message, context = {}) {
  const kind = context.kind || 'alert';
  const ref = context.ref ? ` ref=${context.ref}` : '';
  try {
    await sendTextMessage(ownerPhone, message);
    return true;
  } catch (err) {
    const code = err.response?.data?.error?.code;
    if (isOutsideWindowError(code)) {
      // The important case: this is NOT a bug, and NOT retryable as free-form
      // text. The owner simply hasn't messaged the bot in 24h. Say so in terms
      // that make the fix obvious to whoever reads the log.
      console.error(
        `[OWNER-ALERT-LOST] kind=${kind}${ref} owner=${_rp(ownerPhone)} code=${code} `
        + `— NOT DELIVERED. The 24-hour window for this owner is closed, so this alert `
        + `reached nobody. They must send this WhatsApp number any message to reopen it, `
        + `or this alert type needs an approved Utility template.`,
      );
    } else {
      console.error(
        `[OWNER-ALERT] kind=${kind}${ref} owner=${_rp(ownerPhone)} failed: ${err.message}`,
      );
    }
    return false;
  }
}

/**
 * Send the same alert to several owners, sequentially.
 * @returns {Promise<{sent: number, lost: number}>}
 */
async function notifyOwners(ownerPhones, message, context = {}) {
  const list = Array.isArray(ownerPhones) ? ownerPhones : [];
  if (!list.length) {
    console.warn(`[OWNER-ALERT] kind=${context.kind || 'alert'} — no owner numbers configured, nobody was alerted.`);
    return { sent: 0, lost: 0 };
  }
  let sent = 0;
  for (const p of list) {
    if (await notifyOwner(p, message, context)) sent++;
  }
  const lost = list.length - sent;
  if (lost > 0) {
    console.error(
      `[OWNER-ALERT-LOST] kind=${context.kind || 'alert'}${context.ref ? ` ref=${context.ref}` : ''} `
      + `— ${lost} of ${list.length} owner(s) did not receive this alert.`,
    );
  }
  return { sent, lost };
}

module.exports = { notifyOwner, notifyOwners };
