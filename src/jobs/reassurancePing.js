const {
  getTicketsNeedingReassurance,
  setTicketReassuranceTime,
} = require('../services/sheets');
const { sendTextMessage, sendButtonMessage, isLikelySendablePhone } = require('../services/whatsapp');
const M = require('../messages/index');

/**
 * Daily ping: if repair_tickets row has not been updated (updated_at) for 24h+,
 * send a gentle reassurance with current status. Column O (last_reassurance_at)
 * throttles to about one ping per REASSURANCE_MIN_HOURS (default 20h) so daily cron can run cleanly.
 */
/** Opt-in flag: reassurance pings cost money (out-of-window template). Off by default. */
function reassuranceEnabled() {
  const v = String(process.env.REASSURANCE_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function sendStaleTicketReassurance() {
  if (!reassuranceEnabled()) {
    console.log('[REASSURE] Disabled (set REASSURANCE_ENABLED=true to turn on) — skipping.');
    return;
  }
  let tickets;
  try {
    tickets = await getTicketsNeedingReassurance();
  } catch (err) {
    console.error('[REASSURE] Sheets read error:', err.message);
    return;
  }

  if (tickets.length === 0) {
    console.log('[REASSURE] No tickets need a reassurance ping.');
    return;
  }

  console.log(`[REASSURE] Sending ${tickets.length} reassurance message(s)...`);

  for (const t of tickets) {
    try {
      if (!isLikelySendablePhone(t.phone)) {
        console.warn(`[REASSURE] ${t.ticketId} has missing/invalid phone — skipping`);
        continue;
      }
      const lang = t.language || 'english';
      const msg = M.fill(M.get('status_no_change_reassurance', lang), {
        ticketId: t.ticketId,
        status: t.status || '—',
        store: t.store || '—',
        estimatedPickup: t.estimatedPickup || '—',
      });
      await sendTextMessage(t.phone, msg);

      const buttons = {
        english:  [{ id: 'btn_track', title: '📍 Track repair' },  { id: 'btn_main_menu', title: '🏠 Main Menu' }],
        hindi:    [{ id: 'btn_track', title: '📍 ट्रैक करें' },     { id: 'btn_main_menu', title: '🏠 मुख्य मेनू' }],
        gujarati: [{ id: 'btn_track', title: '📍 ટ્રૅક કરો' }, { id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' }],
      };
      await sleep(400);
      await sendButtonMessage(t.phone, M.get('interactive_choose_next', lang), buttons[lang] || buttons.english);

      await setTicketReassuranceTime(t.rowIndex);
      console.log(`[REASSURE] Sent to ***${String(t.phone).slice(-4)} for ${t.ticketId}`);
      await sleep(600);
    } catch (err) {
      console.error(`[REASSURE] Failed for ${t.ticketId}:`, err.message);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { sendStaleTicketReassurance };
