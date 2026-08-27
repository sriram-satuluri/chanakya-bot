const { getUncollectedTickets } = require('../services/sheets');
const { sendTextMessage, isLikelySendablePhone } = require('../services/whatsapp');
const { envBool } = require('../utils/env');
const { withinSendWindow } = require('./statusPoller');
const M = require('../messages/index');

/**
 * 7-day "please collect your bag" reminder. Off by default.
 *
 * Still free-form (sendTextMessage). That only delivers inside WhatsApp's 24h
 * customer-service window, which a bag sitting for 7 days almost never has.
 * Do not enable until a Utility template exists and this job is switched to
 * sendTemplateMessage. Until then, turning this on just produces 131047 logs.
 */
function pickupReminderEnabled() {
  return envBool('PICKUP_REMINDER_ENABLED', false);
}

async function sendPickupReminders() {
  if (!pickupReminderEnabled()) {
    console.log('[REMINDER] Disabled (set PICKUP_REMINDER_ENABLED=true to turn on) — skipping.');
    return;
  }
  if (!withinSendWindow()) {
    console.log('[REMINDER] Outside send window — skipping.');
    return;
  }
  console.warn(
    '[REMINDER] Sending free-form text. Bags uncollected for 7 days are almost always outside the 24h window — expect Meta 131047 until this job uses an approved Utility template.',
  );
  let tickets;
  try {
    tickets = await getUncollectedTickets(7); // 7 days threshold
  } catch (err) {
    console.error('[REMINDER] Failed to read tickets:', err.message);
    return;
  }

  if (tickets.length === 0) {
    console.log('[REMINDER] No overdue pickup tickets.');
    return;
  }

  console.log(`[REMINDER] Sending reminders for ${tickets.length} uncollected bag(s)...`);

  for (const ticket of tickets) {
    try {
      if (!isLikelySendablePhone(ticket.phone)) {
        console.warn(`[REMINDER] ${ticket.ticketId} has missing/invalid phone — skipping`);
        continue;
      }
      const lang = ticket.language || 'english';
      const msg = M.fill(M.get('pickup_reminder', lang), {
        ticketId: ticket.ticketId,
        store:    ticket.store,
        days:     String(ticket.daysWaiting),
      });
      await sendTextMessage(ticket.phone, msg);
      console.log(`[REMINDER] Sent to ***${String(ticket.phone).slice(-4)} for ${ticket.ticketId} (${ticket.daysWaiting} days waiting)`);
      await sleep(600);
    } catch (err) {
      console.error(`[REMINDER] Failed for ${ticket.ticketId}:`, err.message);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { sendPickupReminders };
