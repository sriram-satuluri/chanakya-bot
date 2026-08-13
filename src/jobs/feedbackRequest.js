const {
  getTicketsForFeedback,
  recordFeedbackState,
} = require('../services/sheets');
const {
  sendTemplateMessage, isLikelySendablePhone, sanitizeTemplateParam,
} = require('../services/whatsapp');
const { withinSendWindow } = require('./statusPoller');
const { envInt } = require('../utils/env');
const { formatIST } = require('../utils/istTime');

/**
 * Post-service feedback request.
 *
 * Triggered by the 'Picked Up' status — NOT 'Ready for Pickup' — because the
 * customer has only actually experienced the finished repair once they've
 * collected the bag and had a look at it.
 *
 * Delay: we don't message the moment they walk out of the shop. The default
 * gives them a day to actually use the bag and notice whether the repair
 * holds, which is what makes the rating worth collecting.
 *
 * "Picked up" time is taken from when the poller/this job FIRST observed the
 * status (recorded in column V), not from any staff-entered timestamp, so it
 * can't be thrown off by someone back-dating a cell. First observation only
 * records the baseline — it never sends immediately.
 *
 * EXTERNAL SETUP: needs a fourth approved Utility template with quick-reply
 * buttons (FEEDBACK_TEMPLATE_EN/HI/GU). See LAUNCH_CHECKLIST.md.
 */

const FEEDBACK_DELAY_HOURS = envInt('FEEDBACK_DELAY_HOURS', 24, { min: 0 });
const HOUR_MS = 60 * 60 * 1000;

const TEMPLATE_BY_LANG = {
  english:  () => process.env.FEEDBACK_TEMPLATE_EN?.trim() || 'repair_feedback_en',
  hindi:    () => process.env.FEEDBACK_TEMPLATE_HI?.trim() || 'repair_feedback_hi',
  gujarati: () => process.env.FEEDBACK_TEMPLATE_GU?.trim() || 'repair_feedback_gu',
};
const LANG_CODE = { english: 'en', hindi: 'hi', gujarati: 'gu' };

function logPhone(p) {
  const s = String(p ?? '');
  return s.length > 4 ? '***' + s.slice(-4) : '***';
}

async function sendFeedbackRequests() {
  const now = new Date();

  // Same courtesy window as the status updates — never message at 11pm.
  if (!withinSendWindow(now)) {
    console.log('[FEEDBACK] Outside send window — skipping.');
    return;
  }

  let tickets;
  try {
    tickets = await getTicketsForFeedback();
  } catch (err) {
    console.error('[FEEDBACK] Sheets read error:', err.message);
    return;
  }
  if (!tickets.length) {
    console.log('[FEEDBACK] No collected tickets awaiting feedback.');
    return;
  }

  let sent = 0, baselined = 0, skipped = 0, failed = 0;

  for (const t of tickets) {
    // Already asked → waiting on their reply, nothing to do.
    if (t.feedbackRequestedAt) { skipped++; continue; }

    // First time we've seen this ticket as collected: record when, don't send.
    if (!t.pickedUpSeenAt) {
      await recordFeedbackState(t.rowIndex, { pickedUpSeenAt: now })
        .catch((e) => console.error(`[FEEDBACK] ${t.ticketId} baseline write failed:`, e.message));
      baselined++;
      continue;
    }

    // Not long enough since collection yet.
    if (now.getTime() - t.pickedUpSeenAt.getTime() < FEEDBACK_DELAY_HOURS * HOUR_MS) {
      skipped++;
      continue;
    }

    if (!isLikelySendablePhone(t.phone)) {
      console.warn(`[FEEDBACK] ${t.ticketId} has missing/invalid phone — skipping`);
      skipped++;
      continue;
    }

    const lang = LANG_CODE[t.language] ? t.language : 'english';
    const templateName = TEMPLATE_BY_LANG[lang]();

    try {
      const res = await sendTemplateMessage(t.phone, templateName, LANG_CODE[lang], [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: sanitizeTemplateParam(t.customerName, 60, 'there') },
            { type: 'text', text: sanitizeTemplateParam(t.ticketId, 40, '-') },
          ],
        },
        // Quick-reply payloads come back to us as message.button.payload and are
        // matched by the 'feedback_rating' intent. Meta caps quick replies at 3,
        // so these map onto the 1-5 scale at its meaningful points.
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'rate_1' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'rate_3' }] },
        { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: 'rate_5' }] },
      ]);

      await recordFeedbackState(t.rowIndex, { feedbackRequestedAt: now })
        .catch((e) => console.error(`[FEEDBACK] ${t.ticketId} state write failed:`, e.message));

      console.log(
        `[FEEDBACK] ticket=${t.ticketId} phone=${logPhone(t.phone)} lang=${lang} `
        + `template=${templateName} status=accepted wamid=${res?.messages?.[0]?.id || '?'} at=${formatIST(now)}`,
      );
      sent++;
    } catch (err) {
      failed++;
      const code = err.response?.data?.error?.code ?? '?';
      console.error(
        `[FEEDBACK] ticket=${t.ticketId} phone=${logPhone(t.phone)} template=${templateName} `
        + `status=failed code=${code} msg=${err.message}`,
      );
      // Deliberately NOT marked as requested — it will be retried next run.
      // A feedback request is low-stakes; unlike a status update there is no
      // duplicate-spam risk here because the send didn't reach anyone.
    }
    await sleep(700);
  }

  console.log(`[FEEDBACK] Run complete — sent:${sent} baselined:${baselined} skipped:${skipped} failed:${failed}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { sendFeedbackRequests };
