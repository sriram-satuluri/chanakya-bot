const {
  getTicketsForProactiveUpdate,
  recordProactiveUpdate,
} = require('../services/sheets');
const { sendTemplateMessage, isLikelySendablePhone } = require('../services/whatsapp');
const M = require('../messages/index');
const {
  canonicalStatus, terminalStopReason, DEFAULT_REPAIR_TICKET_STATUS,
} = require('../constants/repairTicketStatuses');
const { istHour, formatIST } = require('../utils/istTime');

/**
 * Proactive repair-status updates.
 *
 * Sends ALWAYS go out as an approved WhatsApp Utility template — we no longer
 * try to detect whether a free 24h service window is open, because Meta's
 * 1 Oct 2026 pricing change bills in-window replies too, so the old
 * free-vs-paid branch bought nothing but complexity and two code paths.
 *
 * Per-ticket state lives in repair_tickets Q-U (opted_in, last_status_sent,
 * last_update_sent_at, stop_reason, consecutive_failure_count) — the sheet is
 * the single source of truth, so this survives a redeploy with no local
 * snapshot file to keep in sync.
 *
 * EXTERNAL SETUP REQUIRED: three Utility templates must exist and be approved
 * in Meta Business Manager (en/hi/gu), each taking four body variables:
 *   {{1}} customer name · {{2}} ticket id · {{3}} current status · {{4}} store
 * Names are configurable via REPAIR_UPDATE_TEMPLATE_EN/HI/GU.
 */

/** Only message customers between these IST hours (inclusive start, exclusive end). */
const QUIET_START_HOUR = Number(process.env.PROACTIVE_START_HOUR) || 10;
const QUIET_END_HOUR = Number(process.env.PROACTIVE_END_HOUR) || 19;

/** No status change for this many days → send a "still in progress" nudge. */
const NUDGE_AFTER_DAYS = Number(process.env.REPAIR_UPDATE_NUDGE_DAYS) || 3;

/** Consecutive send failures for a number before we stop trying for that ticket. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Idempotency guard: never send twice for the same ticket inside this window,
 * even if the status looks changed. Protects against the cron restarting
 * immediately after a successful send (the sheet write may not have landed).
 * Shorter than the poll interval's practical effect, so genuine changes are
 * not meaningfully delayed.
 */
const MIN_RESEND_GAP_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

const TEMPLATE_BY_LANG = {
  english:  () => process.env.REPAIR_UPDATE_TEMPLATE_EN?.trim() || 'repair_status_update_en',
  hindi:    () => process.env.REPAIR_UPDATE_TEMPLATE_HI?.trim() || 'repair_status_update_hi',
  gujarati: () => process.env.REPAIR_UPDATE_TEMPLATE_GU?.trim() || 'repair_status_update_gu',
};
const LANG_CODE = { english: 'en', hindi: 'hi', gujarati: 'gu' };

/** Redacted by default; set PROACTIVE_LOG_FULL_PHONE=true if you need raw
 *  numbers in logs for billing reconciliation. The wamid is logged either way
 *  and is the key Meta's own reports are keyed on. */
function logPhone(p) {
  const s = String(p ?? '');
  const full = String(process.env.PROACTIVE_LOG_FULL_PHONE || '').toLowerCase();
  if (full === '1' || full === 'true') return s;
  return s.length > 4 ? '***' + s.slice(-4) : '***';
}

function withinSendWindow(now = new Date()) {
  const h = istHour(now);
  return h >= QUIET_START_HOUR && h < QUIET_END_HOUR;
}

/**
 * Decide whether this ticket is due for a send right now.
 * @returns {{send: boolean, reason?: string, skip?: string}}
 */
function decideAction(t, now) {
  const status = canonicalStatus(t.status);
  const lastSent = canonicalStatus(t.lastStatusSent);
  const statusChanged = Boolean(status) && status !== lastSent;
  const terminal = terminalStopReason(status);

  // Already collected — nothing useful left to say; close the ticket quietly.
  // (A "your bag is ready" message here would be wrong, they already have it.)
  if (terminal === 'completed' && status === 'Picked Up') {
    return { send: false, skip: 'picked_up', stopReason: 'completed' };
  }

  // Idempotency: recently sent, regardless of what the status looks like.
  if (t.lastUpdateSentAt && (now - t.lastUpdateSentAt.getTime()) < MIN_RESEND_GAP_MS) {
    return { send: false, skip: 'recently_sent' };
  }

  // Bootstrap: nothing sent yet AND the ticket is still at its creation
  // default. The customer got a confirmation message moments ago, so a paid
  // template restating "awaiting drop-off" adds nothing. Record the baseline
  // silently so the FIRST genuine status change is what reaches them.
  // (If they opted in later, when the repair had already progressed, status
  // won't be the default and they correctly get a catch-up message.)
  if (!t.lastStatusSent && status === canonicalStatus(DEFAULT_REPAIR_TICKET_STATUS)) {
    return { send: false, skip: 'bootstrap', baselineStatus: status };
  }

  if (statusChanged) return { send: true, reason: 'status_change', terminal };

  // No change — is it time for a periodic reassurance nudge? Never nudge a
  // ticket that has already reached a terminal status.
  if (!terminal) {
    const since = t.lastUpdateSentAt ? t.lastUpdateSentAt.getTime() : null;
    if (since && (now - since) >= NUDGE_AFTER_DAYS * DAY_MS) {
      return { send: true, reason: 'nudge', terminal: null };
    }
    // Never sent anything yet and status hasn't moved from what staff set at
    // creation: wait for the first real change rather than pinging immediately.
  }

  return { send: false, skip: 'no_change' };
}

async function pollStatusChanges() {
  const now = new Date();

  if (!withinSendWindow(now)) {
    console.log(`[PROACTIVE] Outside send window (${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00 IST, now ${istHour(now)}:xx) — skipping.`);
    return;
  }

  let tickets;
  try {
    tickets = await getTicketsForProactiveUpdate();
  } catch (err) {
    console.error('[PROACTIVE] Sheets read error:', err.message);
    return;
  }

  if (tickets.length === 0) {
    console.log('[PROACTIVE] No opted-in tickets to consider.');
    return;
  }

  let sent = 0, failed = 0, skipped = 0, stopped = 0;

  for (const t of tickets) {
    const decision = decideAction(t, now.getTime());

    // Terminal-but-silent (already picked up): just close it out.
    if (!decision.send && decision.stopReason) {
      await recordProactiveUpdate(t.rowIndex, {
        optedIn: false,
        stopReason: decision.stopReason,
        statusSent: t.status,
      }).catch((e) => console.error(`[PROACTIVE] ${t.ticketId} stop-write failed:`, e.message));
      console.log(`[PROACTIVE] ticket=${t.ticketId} stopped reason=${decision.stopReason} (no message needed)`);
      stopped++;
      continue;
    }

    // Bootstrap: record the baseline so the next real change is the first send.
    if (!decision.send && decision.baselineStatus) {
      await recordProactiveUpdate(t.rowIndex, { statusSent: decision.baselineStatus })
        .catch((e) => console.error(`[PROACTIVE] ${t.ticketId} baseline-write failed:`, e.message));
      skipped++;
      continue;
    }

    if (!decision.send) { skipped++; continue; }

    if (!isLikelySendablePhone(t.phone)) {
      console.warn(`[PROACTIVE] ticket=${t.ticketId} has missing/invalid phone — skipping`);
      skipped++;
      continue;
    }

    const lang = LANG_CODE[t.language] ? t.language : 'english';
    const templateName = TEMPLATE_BY_LANG[lang]();
    const statusText = M.statusLabel(t.status, lang);

    try {
      const res = await sendTemplateMessage(t.phone, templateName, LANG_CODE[lang], [{
        type: 'body',
        parameters: [
          { type: 'text', text: String(t.customerName || 'there').slice(0, 60) },
          { type: 'text', text: String(t.ticketId) },
          { type: 'text', text: String(statusText).slice(0, 200) },
          { type: 'text', text: String(t.store || '—').slice(0, 100) },
        ],
      }]);

      const wamid = res?.messages?.[0]?.id || '?';
      // Audit line — one per billable send, greppable as [PROACTIVE].
      console.log(
        `[PROACTIVE] ticket=${t.ticketId} phone=${logPhone(t.phone)} lang=${lang} `
        + `template=${templateName} reason=${decision.reason} status=accepted wamid=${wamid} at=${formatIST(now)}`,
      );
      sent++;

      const patch = { statusSent: t.status, sentAt: now, failureCount: 0 };
      if (decision.terminal) {
        // Ready for pickup / cannot repair: this was the final message.
        patch.optedIn = false;
        patch.stopReason = decision.terminal;
        stopped++;
        console.log(`[PROACTIVE] ticket=${t.ticketId} final message sent — stopping (reason=${decision.terminal})`);
      }
      await recordProactiveUpdate(t.rowIndex, patch);
    } catch (err) {
      failed++;
      const nextFailures = (t.failureCount || 0) + 1;
      const metaErr = err.response?.data?.error || {};
      console.error(
        `[PROACTIVE] ticket=${t.ticketId} phone=${logPhone(t.phone)} lang=${lang} `
        + `template=${templateName} reason=${decision.reason} status=failed `
        + `attempt=${nextFailures}/${MAX_CONSECUTIVE_FAILURES} code=${metaErr.code ?? '?'} msg=${err.message}`,
      );

      const patch = { failureCount: nextFailures };
      if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
        patch.optedIn = false;
        patch.stopReason = 'delivery_failed';
        stopped++;
        console.error(
          `[PROACTIVE] ticket=${t.ticketId} hit ${MAX_CONSECUTIVE_FAILURES} consecutive failures — `
          + `updates stopped for this ticket (stop_reason=delivery_failed). Investigate the number.`,
        );
      }
      await recordProactiveUpdate(t.rowIndex, patch)
        .catch((e) => console.error(`[PROACTIVE] ${t.ticketId} failure-write failed:`, e.message));
    }

    // Gentle pacing so a backlog can't burst against the outbound rate limit.
    await sleep(700);
  }

  console.log(`[PROACTIVE] Run complete — sent:${sent} failed:${failed} skipped:${skipped} stopped:${stopped}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { pollStatusChanges, decideAction, withinSendWindow };
