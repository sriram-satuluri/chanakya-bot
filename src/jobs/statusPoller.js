const {
  getTicketsForProactiveUpdate,
  recordProactiveUpdate,
} = require('../services/sheets');
const {
  sendTemplateMessage, sendTextMessage, isLikelySendablePhone, sanitizeTemplateParam,
} = require('../services/whatsapp');
const { getRecipientsForCorporate } = require('../utils/ownerPhones');
const { envInt, envBool } = require('../utils/env');
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

/** Only message customers between these IST hours (inclusive start, exclusive end).
 *  0 is a legitimate value (midnight), so these go through envInt, not `|| default`. */
const QUIET_START_HOUR = envInt('PROACTIVE_START_HOUR', 10, { min: 0, max: 23 });
const QUIET_END_HOUR = envInt('PROACTIVE_END_HOUR', 19, { min: 0, max: 24 });

/** No status change for this many days → send a "still in progress" nudge. */
const NUDGE_AFTER_DAYS = envInt('REPAIR_UPDATE_NUDGE_DAYS', 3, { min: 0 });

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
  if (envBool('PROACTIVE_LOG_FULL_PHONE', false)) return s;
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
  /** Tickets auto-unsubscribed this run — owners get one summary alert below. */
  const autoUnsubscribed = [];

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

    // Only the SEND lives in this try. A Sheets write failure must never be
    // mistaken for a delivery failure — doing so would increment the
    // consecutive-failure counter (and after 3, silently unsubscribe someone)
    // for messages the customer actually received.
    let sendResult = null;
    let sendError = null;
    try {
      sendResult = await sendTemplateMessage(t.phone, templateName, LANG_CODE[lang], [{
        type: 'body',
        // Every value is sanitized: these originate from customer free-text /
        // staff-typed sheet cells, and Meta rejects params containing newlines,
        // tabs, or 4+ consecutive spaces.
        parameters: [
          { type: 'text', text: sanitizeTemplateParam(t.customerName, 60, 'there') },
          { type: 'text', text: sanitizeTemplateParam(t.ticketId, 40, '—') },
          { type: 'text', text: sanitizeTemplateParam(statusText, 200, '—') },
          { type: 'text', text: sanitizeTemplateParam(t.store, 100, '—') },
        ],
      }]);
    } catch (err) {
      sendError = err;
    }

    // ── Build the state patch from the send outcome ──────────────────
    let patch;
    if (!sendError) {
      const wamid = sendResult?.messages?.[0]?.id || '?';
      // Audit line — one per billable send, greppable as [PROACTIVE].
      console.log(
        `[PROACTIVE] ticket=${t.ticketId} phone=${logPhone(t.phone)} lang=${lang} `
        + `template=${templateName} reason=${decision.reason} status=accepted wamid=${wamid} at=${formatIST(now)}`,
      );
      sent++;
      patch = { statusSent: t.status, sentAt: now, failureCount: 0 };
      if (decision.terminal) {
        // Ready for pickup / cannot repair: this was the final message.
        patch.optedIn = false;
        patch.stopReason = decision.terminal;
        stopped++;
        console.log(`[PROACTIVE] ticket=${t.ticketId} final message sent — stopping (reason=${decision.terminal})`);
      }
    } else {
      failed++;
      const nextFailures = (t.failureCount || 0) + 1;
      const metaErr = sendError.response?.data?.error || {};
      console.error(
        `[PROACTIVE] ticket=${t.ticketId} phone=${logPhone(t.phone)} lang=${lang} `
        + `template=${templateName} reason=${decision.reason} status=failed `
        + `attempt=${nextFailures}/${MAX_CONSECUTIVE_FAILURES} code=${metaErr.code ?? '?'} msg=${sendError.message}`,
      );
      patch = { failureCount: nextFailures };
      if (nextFailures >= MAX_CONSECUTIVE_FAILURES) {
        patch.optedIn = false;
        patch.stopReason = 'delivery_failed';
        stopped++;
        autoUnsubscribed.push({
          ticketId: t.ticketId,
          phone: t.phone,
          lastError: `${metaErr.code ?? '?'}: ${sendError.message}`,
        });
        // Distinct, greppable tag for the OUTCOME (not the cause). Two
        // different bugs have already produced this same silent unsubscribe
        // via different routes, so the outcome itself is what gets alarmed —
        // any future cause we haven't predicted still surfaces here.
        console.error(
          `[AUTO-UNSUBSCRIBE] ticket=${t.ticketId} phone=${logPhone(t.phone)} `
          + `reason=delivery_failed failures=${nextFailures} lastError="${metaErr.code ?? '?'}: ${sendError.message}" `
          + `— customer opted IN but will no longer receive updates. Investigate.`,
        );
      }
    }

    // Persisting state is a separate concern: if THIS fails the message was
    // still delivered (or genuinely failed) — log it and move on rather than
    // corrupting the failure counter.
    await recordProactiveUpdate(t.rowIndex, patch).catch((e) => {
      console.error(
        `[PROACTIVE] ${t.ticketId} state-write FAILED (send outcome was `
        + `${sendError ? 'failed' : 'delivered'}): ${e.message}. `
        + `If the send succeeded, the next run may repeat it.`,
      );
    });

    // Gentle pacing so a backlog can't burst against the outbound rate limit.
    await sleep(700);
  }

  console.log(`[PROACTIVE] Run complete — sent:${sent} failed:${failed} skipped:${skipped} stopped:${stopped}`);

  if (autoUnsubscribed.length) await alertOwnersOfAutoUnsubscribe(autoUnsubscribed);
}

/**
 * Tell the owners when a customer who ASKED for updates has been cut off by
 * repeated delivery failures. This alarms the outcome rather than any single
 * cause: two separate bugs have already produced this exact silent unsubscribe
 * by different routes, so whatever causes it next still surfaces here.
 *
 * One batched message per run (never one per ticket), and failures to alert
 * are logged but never allowed to break the poll.
 */
async function alertOwnersOfAutoUnsubscribe(items) {
  const lines = items.map(
    (i) => `• ${i.ticketId} (${logPhone(i.phone)}) — ${i.lastError}`,
  ).join('\n');
  const msg =
    `⚠️ *Repair updates auto-stopped*\n\n`
    + `${items.length} customer(s) opted IN for repair updates but delivery failed `
    + `${MAX_CONSECUTIVE_FAILURES}x in a row, so updates were switched off for them:\n\n`
    + `${lines}\n\n`
    + `They will hear nothing further until this is looked at. Check the number is `
    + `valid and on WhatsApp, and that the status templates are still approved.`;

  const recipients = getRecipientsForCorporate(); // general owners
  if (!recipients.length) {
    console.warn('[AUTO-UNSUBSCRIBE] No owner numbers configured — alert not sent.');
    return;
  }
  for (const ownerPhone of recipients) {
    await sendTextMessage(ownerPhone, msg).catch((e) =>
      console.error(`[AUTO-UNSUBSCRIBE] Failed to alert owner ${logPhone(ownerPhone)}:`, e.message));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { pollStatusChanges, decideAction, withinSendWindow };
