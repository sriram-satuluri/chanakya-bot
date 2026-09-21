const {
  getTicketsForProactiveUpdate,
  recordProactiveUpdate,
} = require('../services/sheets');
const {
  sendTemplateMessage, sendTextMessage, isLikelySendablePhone, sanitizeTemplateParam,
  isOutsideWindowError,
} = require('../services/whatsapp');
const { getRecipientsForCorporate } = require('../utils/ownerPhones');
const { notifyOwners } = require('../utils/ownerAlert');
const { envInt, envBool } = require('../utils/env');
const {
  repairUpdatesReady, resolveRepairUpdateTemplate,
} = require('../utils/metaTemplates');
const M = require('../messages/index');
const {
  canonicalStatus, terminalStopReason, DEFAULT_REPAIR_TICKET_STATUS,
  isMandatoryCustomerNotifyStatus, isWaitingForPickup,
} = require('../constants/repairTicketStatuses');
const { istHour, formatIST } = require('../utils/istTime');

/**
 * Proactive repair-status updates.
 *
 * Prefer an approved WhatsApp Utility template (works after the 24h customer
 * window). Until REPAIR_UPDATE_TEMPLATE_EN/HI/GU are set, a column-G change
 * is sent as in-session free-form text — that only delivers if the customer
 * messaged us in the last 24 hours. Periodic nudges stay off until templates
 * exist (they almost always miss that window).
 *
 * Per-ticket state lives in repair_tickets Q-U (opted_in, last_status_sent,
 * last_update_sent_at, stop_reason, consecutive_failure_count) — the sheet is
 * the single source of truth, so this survives a redeploy with no local
 * snapshot file to keep in sync.
 *
 * Progress reminders: every column-G change WhatsApps. The daily "still in
 * progress" nudge is opted-in only. Ready for Pickup: first message on the
 * status change, then the same weekday/time every 7 days for 4 weeks
 * (28-day inventory hold), then stop.
 *
 * Quiet hours (default 10:00–19:00 IST) apply to the daily in-progress nudge
 * only. A staff status change and the weekly collect reminder keep the clock
 * time of the original send.
 *
 * EXTERNAL SETUP: three Utility templates in Meta Business Manager (en/hi/gu),
 * four body variables: {{1}} name · {{2}} ticket id · {{3}} status · {{4}} store
 * Names: REPAIR_UPDATE_TEMPLATE_EN/HI/GU.
 */

/** Only message customers between these IST hours (inclusive start, exclusive end).
 *  0 is a legitimate value (midnight), so these go through envInt, not `|| default`. */
const QUIET_START_HOUR = envInt('PROACTIVE_START_HOUR', 10, { min: 0, max: 23 });
const QUIET_END_HOUR = envInt('PROACTIVE_END_HOUR', 19, { min: 0, max: 24 });

/** No status change for this many hours → send a "still in progress" nudge
 *  (opted-in tickets only, never while waiting for pickup). 0 disables. */
const NUDGE_AFTER_HOURS = envInt('REPAIR_UPDATE_NUDGE_HOURS', 24, { min: 0 });

/** Days between "please collect" pings while status is Ready for Pickup.
 *  First ping is the status-change message; repeats are weekly. 0 disables repeats. */
const PICKUP_REMIND_DAYS = envInt('REPAIR_PICKUP_REMIND_DAYS', 7, { min: 0 });
/** Stop collect-reminders this many days after the bag was marked ready (inventory hold). */
const PICKUP_HOLD_DAYS = envInt('REPAIR_PICKUP_HOLD_DAYS', 28, { min: 1 });

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

const HOUR_MS = 60 * 60 * 1000;

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

function isPeriodicUpdateReason(reason) {
  return reason === 'nudge' || reason === 'pickup_reminder';
}

/** Daily in-progress nudges wait for 10:00–19:00 IST. Status changes and the
 *  weekly collect reminder do not — they keep the original clock time. */
function shouldDeferForQuietHours(reason, inWindow) {
  return reason === 'nudge' && !inWindow;
}

const FREEFORM_STATUS_KEY = {
  'Bag Received':        'status_bag_received',
  'Inspection Done':     'status_inspection_done',
  'Repair In Progress':  'status_repair_in_progress',
  'Repair Complete':     'status_repair_complete',
  'Ready for Pickup':    'status_ready_pickup',
  'Cannot Repair':       'status_cannot_repair',
  'Picked Up':           'status_picked_up',
};

function freeformStatusBody(t, lang) {
  const status = canonicalStatus(t.status);
  const key = FREEFORM_STATUS_KEY[status]
    || (status === canonicalStatus(DEFAULT_REPAIR_TICKET_STATUS)
      ? 'status_physical_pending'
      : 'status_poller_generic');
  return M.fill(M.get(key, lang), {
    ticketId: t.ticketId,
    store: t.store || '—',
    status: M.statusLabel(status, lang),
    afterPhotoText: '',
    estimatedPickup: '—',
  });
}

function hoursElapsed(since, nowMs) {
  const sinceMs = since && typeof since.getTime === 'function' ? since.getTime() : null;
  if (sinceMs == null) return null;
  return (nowMs - sinceMs) / HOUR_MS;
}

/**
 * Decide whether this ticket is due for a send right now.
 * @returns {{send: boolean, reason?: string, skip?: string, terminal?: string|null, stopReason?: string, baselineStatus?: string}}
 */
function decideAction(t, now) {
  const status = canonicalStatus(t.status);
  const lastSent = canonicalStatus(t.lastStatusSent);
  const statusChanged = Boolean(status) && status !== lastSent;
  const terminal = terminalStopReason(status);
  const optedIn = t.optedIn !== false;
  const mandatory = isMandatoryCustomerNotifyStatus(status);
  const waitingPickup = isWaitingForPickup(status);

  // Already told them about THIS closed status (collected / cannot-repair).
  if (terminal && lastSent === status) {
    return {
      send: false,
      skip: status === 'Picked Up' ? 'picked_up' : 'already_final',
      stopReason: terminal,
    };
  }

  // Bootstrap: nothing sent yet AND the ticket is still at its creation
  // default. The customer got a confirmation message moments ago, so a paid
  // template restating "awaiting drop-off" adds nothing. Record the baseline
  // silently so the FIRST genuine status change is what reaches them.
  if (!t.lastStatusSent && status === canonicalStatus(DEFAULT_REPAIR_TICKET_STATUS)) {
    return { send: false, skip: 'bootstrap', baselineStatus: status };
  }

  // A real column-G change always WhatsApps — including Bag Received /
  // Inspection / In Progress, and including customers who declined the
  // daily reminder. Opt-in only controls the 24h "still in progress" nudge.
  if (statusChanged) {
    return {
      send: true,
      reason: (!optedIn && mandatory) ? 'mandatory' : 'status_change',
      terminal,
    };
  }

  // Same status we already sent: don't retry for a few minutes (cron overlap /
  // sheet write lag). A *new* status above is never blocked by this.
  if (t.lastUpdateSentAt && (now - t.lastUpdateSentAt.getTime()) < MIN_RESEND_GAP_MS) {
    return { send: false, skip: 'recently_sent' };
  }

  // Ready for pickup, already notified — weekly collect reminder until the
  // 28-day hold ends. Same weekday/time as the first ready message.
  if (waitingPickup) {
    const readyAt = t.readyForPickupAt || t.lastUpdateSentAt || t.createdAt;
    const heldHrs = hoursElapsed(readyAt, now);
    if (PICKUP_HOLD_DAYS > 0 && heldHrs != null && heldHrs > PICKUP_HOLD_DAYS * 24) {
      return { send: false, skip: 'holding_expired', stopReason: 'holding_expired' };
    }
    if (PICKUP_REMIND_DAYS > 0) {
      const sinceLast = hoursElapsed(t.lastUpdateSentAt || readyAt, now);
      if (sinceLast != null && sinceLast >= PICKUP_REMIND_DAYS * 24) {
        return { send: true, reason: 'pickup_reminder', terminal: null };
      }
    }
    return { send: false, skip: 'waiting_pickup' };
  }

  // No change — periodic reassurance for opted-in in-progress tickets only.
  if (optedIn && !terminal && NUDGE_AFTER_HOURS > 0) {
    const elapsed = hoursElapsed(t.lastUpdateSentAt || t.createdAt, now);
    if (elapsed != null && elapsed >= NUDGE_AFTER_HOURS) {
      return { send: true, reason: 'nudge', terminal: null };
    }
  }

  return { send: false, skip: optedIn ? 'no_change' : 'not_opted_in' };
}

async function pollStatusChanges() {
  const now = new Date();
  const inWindow = withinSendWindow(now);
  const templatesReady = repairUpdatesReady();

  if (!templatesReady) {
    console.log('[PROACTIVE] REPAIR_UPDATE_TEMPLATE_EN/HI/GU unset — status changes use in-session text (fails after 24h of silence). Periodic nudges stay off until Meta approves those Utility templates.');
  }

  if (!inWindow) {
    console.log(`[PROACTIVE] Outside quiet hours (${QUIET_START_HOUR}:00-${QUIET_END_HOUR}:00 IST, now ${istHour(now)}:xx) — status-change messages still send; daily nudges wait.`);
  }

  let tickets;
  try {
    tickets = await getTicketsForProactiveUpdate();
  } catch (err) {
    console.error('[PROACTIVE] Sheets read error:', err.message);
    return;
  }

  if (tickets.length === 0) {
    console.log('[PROACTIVE] No tickets to consider.');
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

    if (shouldDeferForQuietHours(decision.reason, inWindow)) {
      skipped++;
      continue;
    }

    if (isPeriodicUpdateReason(decision.reason) && !templatesReady) {
      skipped++;
      continue;
    }

    if (!isLikelySendablePhone(t.phone)) {
      console.warn(`[PROACTIVE] ticket=${t.ticketId} has missing/invalid phone — skipping`);
      skipped++;
      continue;
    }

    const lang = t.language === 'hindi' || t.language === 'gujarati' ? t.language : 'english';
    const resolved = resolveRepairUpdateTemplate(lang);
    const useTemplate = Boolean(resolved);
    if (!useTemplate && isPeriodicUpdateReason(decision.reason)) {
      skipped++;
      continue;
    }
    const templateName = useTemplate ? resolved.name : 'freeform';
    const langCode = useTemplate ? resolved.langCode : lang;

    // Only the SEND lives in this try. A Sheets write failure must never be
    // mistaken for a delivery failure — doing so would increment the
    // consecutive-failure counter (and after 3, silently unsubscribe someone)
    // for messages the customer actually received.
    let sendResult = null;
    let sendError = null;
    try {
      if (useTemplate) {
        const statusText = M.statusLabel(t.status, lang);
        sendResult = await sendTemplateMessage(t.phone, templateName, langCode, [{
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
      } else {
        sendResult = await sendTextMessage(t.phone, freeformStatusBody(t, lang));
      }
    } catch (err) {
      const metaCode = err.response?.data?.error?.code;
      if (!useTemplate && isOutsideWindowError(metaCode)) {
        console.warn(
          `[PROACTIVE] ticket=${t.ticketId} phone=${logPhone(t.phone)} `
          + `free-form blocked (Meta ${metaCode} — 24h window closed). `
          + `Set approved REPAIR_UPDATE_TEMPLATE_* to reach them. Not counting as a delivery failure.`,
        );
        skipped++;
        continue;
      }
      sendError = err;
    }

    // ── Build the state patch from the send outcome ──────────────────
    let patch;
    if (!sendError) {
      const wamid = sendResult?.messages?.[0]?.id || '?';
      // Audit line — one per billable send, greppable as [PROACTIVE].
      console.log(
        `[PROACTIVE] ticket=${t.ticketId} phone=${logPhone(t.phone)} lang=${lang} `
        + `channel=${useTemplate ? 'template' : 'freeform'} template=${templateName} `
        + `reason=${decision.reason} status=accepted wamid=${wamid} at=${formatIST(now)}`,
      );
      sent++;
      patch = { statusSent: t.status, sentAt: now, failureCount: 0 };
      if (isWaitingForPickup(t.status) && !t.readyForPickupAt) {
        patch.readyForPickupAt = now;
      }
      if (decision.terminal) {
        // Picked up / cannot repair: this was the final message.
        patch.optedIn = false;
        patch.stopReason = decision.terminal;
        stopped++;
        console.log(`[PROACTIVE] ticket=${t.ticketId} final message sent — stopping (reason=${decision.terminal})`);
      }
    } else {
      failed++;
      // A new status deserves a fresh attempt budget — leftover failures from
      // a previous status must not immediately auto-unsubscribe this one.
      const newStatusAttempt = canonicalStatus(t.lastStatusSent) !== canonicalStatus(t.status);
      const nextFailures = newStatusAttempt ? 1 : (t.failureCount || 0) + 1;
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
        // Record the status as handled so a mandatory ticket doesn't retry
        // the same undeliverable send forever. A later status change still
        // notifies (lastStatusSent !== new status).
        patch.statusSent = t.status;
        stopped++;
        autoUnsubscribed.push({
          ticketId: t.ticketId,
          phone: t.phone,
          lastError: `${metaErr.code ?? '?'}: ${sendError.message}`,
        });
        console.error(
          `[AUTO-UNSUBSCRIBE] ticket=${t.ticketId} phone=${logPhone(t.phone)} `
          + `reason=delivery_failed failures=${nextFailures} lastError="${metaErr.code ?? '?'}: ${sendError.message}" `
          + `— this status will not be retried. Investigate.`,
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

  await notifyOwners(getRecipientsForCorporate(), msg, {
    kind: 'auto_unsubscribe',
    ref: items.map((i) => i.ticketId).join(','),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  pollStatusChanges, decideAction, withinSendWindow, shouldDeferForQuietHours,
};
