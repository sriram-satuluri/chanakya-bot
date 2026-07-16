const { readTicketRows, extractHttpsUrlFromCell } = require('../services/sheets');
const {
  sendTextMessage, sendImageMessage, sendButtonMessage, sendTemplateMessage,
  isLikelySendablePhone, isOutsideWindowError,
} = require('../services/whatsapp');
const { isServiceWindowOpen } = require('../utils/lastContactCache');
const M = require('../messages/index');
const { DEFAULT_REPAIR_TICKET_STATUS } = require('../constants/repairTicketStatuses');
const {
  loadRepairStatusSnapshot,
  saveRepairStatusSnapshot,
  normalizeStatusCell,
} = require('../utils/repairStatusSnapshotCache');

const KNOWN_POLLER_MSG = {
  'Bag Received':        'status_bag_received',
  'Inspection Done':     'status_inspection_done',
  'Repair In Progress':  'status_repair_in_progress',
  'Repair Complete':     'status_repair_in_progress',
  'Ready for Pickup':    'status_ready_pickup',
  'Cannot Repair':       'status_cannot_repair',
};

/**
 * Reads every repair row, compares column G vs last persisted snapshot,
 * and sends WhatsApp when status text changes — even if updated_at wasn't edited.
 *
 * Bootstrap: first time we see a ticket ID we save its status and skip push
 * so new tickets created by the bot don't ping the customer before staff edit.
 */
/**
 * Which status changes trigger a proactive WhatsApp to the customer:
 *   smart      → DEFAULT. Push any status change while the customer's 24h
 *                service window is open (FREE). Once the window is closed,
 *                only "Ready for Pickup" goes out — via PICKUP_TEMPLATE_NAME
 *                if configured (paid utility template), else attempted
 *                free-form (Meta is the final authority on the window).
 *   off        → never message customers (pure pull model).
 *   ready_only → only "Ready for Pickup" pushes.
 *   all        → every status change regardless of window (needs templates).
 * The snapshot is still updated in every mode, so switching modes never
 * back-fires a backlog of old changes.
 */
function statusPushMode() {
  const m = String(process.env.STATUS_PUSH_MODE || 'smart').trim().toLowerCase();
  return ['smart', 'off', 'ready_only', 'all'].includes(m) ? m : 'smart';
}

async function pollStatusChanges() {
  let rows;
  try {
    rows = await readTicketRows();
  } catch (err) {
    console.error('[POLLER] Sheets read error:', err.message);
    return;
  }

  const pushMode = statusPushMode();

  const prevSnap = loadRepairStatusSnapshot();
  /** Ticket id → trimmed status column (authoritative Sheet state now) */
  const nextSnap = {};

  const parsed = [];

  for (let i = 1; i < rows.length; i++) {
    const ticketId = String(rows[i]?.[0] ?? '').trim();
    if (!ticketId || !/^CHA-/i.test(ticketId)) continue;

    const nu = normalizeStatusCell(rows[i]?.[6]);
    nextSnap[ticketId] = nu;

    parsed.push({
      ticketId,
      phone:           String(rows[i]?.[2] ?? '').trim(),
      status:          nu,
      store:           String(rows[i]?.[5] ?? '').trim(),
      language:        String(rows[i]?.[12] ?? '').trim() || 'english',
      estimatedPickup: String(rows[i]?.[11] ?? '').trim(),
      afterPhotoUrl:   extractHttpsUrlFromCell(rows[i]?.[8]),
    });
  }

  const pending = [];

  for (const row of parsed) {
    const before = prevSnap[row.ticketId];
    // First observation: onboard snapshot only — no outbound message
    if (before === undefined) continue;

    if (before === row.status) continue;

    // Staff marked collected → keep quiet (same behaviour as legacy poller)
    if (row.status === 'Picked Up') {
      console.log(`[POLLER] ${row.ticketId} → Picked Up (silent)`);
      continue;
    }

    // Proactive-notification policy. In every case we still record the new
    // status in the snapshot below (so re-enabling later doesn't blast a
    // backlog); we only decide whether to PUSH.
    if (pushMode === 'off') continue;
    if (pushMode === 'ready_only' && row.status !== 'Ready for Pickup') continue;

    // windowClosed rides along so notifyCustomer can pick free-form vs template.
    row.windowClosed = !isServiceWindowOpen(row.phone);

    if (pushMode === 'smart' && row.windowClosed && row.status !== 'Ready for Pickup') {
      // Window closed → a free-form push would be rejected AND cost money as a
      // template. Not worth it for intermediate statuses: the customer sees
      // them for free via Track whenever they like. Only the pickup message
      // is business-critical enough to send from our side.
      console.log(`[POLLER] ${row.ticketId} → "${row.status}" — customer window closed; non-pickup push skipped (snapshot updated)`);
      continue;
    }

    if (!isLikelySendablePhone(row.phone)) {
      console.warn(`[POLLER] ${row.ticketId} status changed but phone is missing/invalid — skipping push`);
      continue;
    }

    pending.push(row);
  }

  const finalSnap = { ...nextSnap };

  if (pending.length === 0) {
    saveRepairStatusSnapshot(finalSnap);
    console.log(`[POLLER] No customer pushes this run (mode=${pushMode}); snapshot updated.`);
    return;
  }

  console.log(`[POLLER] ${pending.length} status change(s) — sending WhatsApp…`);

  for (const ticket of pending) {
    try {
      await notifyCustomer(ticket);
      await sleep(700);
    } catch (err) {
      const metaCode = err.response?.data?.error?.code;
      if (isOutsideWindowError(metaCode)) {
        // Retrying free-form against a closed window fails identically every
        // 15 min — keep the new status in the snapshot (no retry) and say why.
        console.error(`[POLLER] ${ticket.ticketId}: 24h window closed — push dropped, no retry. `
          + `Set PICKUP_TEMPLATE_NAME (approved utility template) to reach closed-window customers.`);
      } else {
        console.error(`[POLLER] Push failed (${ticket.ticketId}):`, err.message);
        finalSnap[ticket.ticketId] = prevSnap[ticket.ticketId];
      }
    }
  }

  saveRepairStatusSnapshot(finalSnap);
  console.log('[POLLER] Snapshot saved.');
}

/** Locale codes for the pickup template (must match the approved template's languages). */
const TEMPLATE_LANG_CODE = { english: 'en', hindi: 'hi', gujarati: 'gu' };

/**
 * Outbound WhatsApp when sheet status differs from cached value.
 */
async function notifyCustomer(ticket) {
  const lang = ticket.language || 'english';

  // Closed window + Ready for Pickup: free-form would be rejected, so use the
  // approved utility template if configured (template must have exactly two
  // body variables: {{1}}=ticket id, {{2}}=store). Single message — no photo /
  // buttons follow-ups, those are free-form and would bounce too.
  if (ticket.windowClosed && ticket.status === 'Ready for Pickup') {
    const tpl = process.env.PICKUP_TEMPLATE_NAME?.trim();
    if (tpl) {
      await sendTemplateMessage(ticket.phone, tpl, TEMPLATE_LANG_CODE[lang] || 'en', [{
        type: 'body',
        parameters: [
          { type: 'text', text: String(ticket.ticketId) },
          { type: 'text', text: String(ticket.store || '—') },
        ],
      }]);
      console.log(`[POLLER] Pushed pickup TEMPLATE → ***${String(ticket.phone).slice(-4)} — ${ticket.ticketId}`);
      return;
    }
    // No template configured: fall through and attempt free-form. Our window
    // tracking is conservative (unknown = closed), so Meta may still accept;
    // if it is truly closed, the caller drops it without retry.
  }

  let statusMsgKey = KNOWN_POLLER_MSG[ticket.status];
  if (!statusMsgKey) {
    statusMsgKey =
      ticket.status === DEFAULT_REPAIR_TICKET_STATUS
        ? 'status_physical_pending'
        : 'status_poller_generic';
  }

  let afterPhotoText = '';
  if (ticket.status === 'Ready for Pickup' && ticket.afterPhotoUrl) {
    afterPhotoText = lang === 'hindi'
      ? `📸 *मरम्मत के बाद की फोटो:*`
      : lang === 'gujarati'
        ? `📸 *રીપેયર પછીની ફોટો:*`
        : `📸 *After repair photo:*`;
  }

  const msg = M.fill(M.get(statusMsgKey, lang), {
    ticketId:        ticket.ticketId,
    store:           ticket.store || '—',
    estimatedPickup: ticket.estimatedPickup || '—',
    afterPhotoText,
    status:          ticket.status,
  });

  await sendTextMessage(ticket.phone, msg);

  if (ticket.status === 'Ready for Pickup' && ticket.afterPhotoUrl) {
    await sleep(400);
    await sendImageMessage(ticket.phone, ticket.afterPhotoUrl, `After repair — ${ticket.ticketId}`);
  }

  const footer = M.get('interactive_choose_next', lang);
  const actionButtons = {
    english:  [{ id: 'btn_track', title: '📍 Track Repair' },     { id: 'btn_main_menu', title: '🏠 Main Menu' }],
    hindi:    [{ id: 'btn_track', title: '📍 ट्रैक करें' },        { id: 'btn_main_menu', title: '🏠 मुख्य मेनू' }],
    gujarati: [{ id: 'btn_track', title: '📍 રિપેર ટ્રૅક કરો' }, { id: 'btn_main_menu', title: '🏠 મુખ્ય મેનુ' }],
  };
  await sleep(300);
  await sendButtonMessage(ticket.phone, footer, actionButtons[lang] || actionButtons.english);

  console.log(`[POLLER] Pushed → ***${String(ticket.phone).slice(-4)} — ${ticket.ticketId} → "${ticket.status}"`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { pollStatusChanges };
