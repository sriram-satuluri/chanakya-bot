const { getUncollectedTickets } = require('../services/sheets');
const { sendTextMessage, isLikelySendablePhone } = require('../services/whatsapp');
const M = require('../messages/index');

/** Opt-in flag: 7-day pickup reminders cost money (out-of-window template). Off by default. */
function pickupReminderEnabled() {
  const v = String(process.env.PICKUP_REMINDER_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function sendPickupReminders() {
  if (!pickupReminderEnabled()) {
    console.log('[REMINDER] Disabled (set PICKUP_REMINDER_ENABLED=true to turn on) — skipping.');
    return;
  }
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
