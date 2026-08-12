const { getPendingBroadcasts, setBroadcastStatus, getOptInContacts } = require('../services/sheets');
const {
  sendTemplateMessage, isLikelySendablePhone, sanitizeTemplateParam,
} = require('../services/whatsapp');
const { envInt } = require('../utils/env');

const LANG_CODE = { english: 'en', hindi: 'hi', gujarati: 'gu' };

async function runBroadcastQueue() {
  let pending;
  try {
    pending = await getPendingBroadcasts();
  } catch (err) {
    console.error('[BROADCAST] Failed to read queue:', err.message);
    return;
  }

  if (pending.length === 0) {
    console.log('[BROADCAST] No pending broadcasts.');
    return;
  }

  console.log(`[BROADCAST] Processing ${pending.length} broadcast(s)...`);

  for (const broadcast of pending) {
    try {
      // Claim the row BEFORE sending. If we crash mid-send, the row stays
      // 'sending' and is never re-picked — losing the tail of one campaign is
      // far better than re-messaging the entire opt-in list next hour.
      await setBroadcastStatus(broadcast.rowIndex, 'sending');
      await runBroadcast(broadcast);
      await setBroadcastStatus(broadcast.rowIndex, 'sent');
    } catch (err) {
      console.error(`[BROADCAST] Failed campaign "${broadcast.campaignName}":`, err.message);
      // Mark failed so staff see it in the sheet instead of a silently stuck 'sending'.
      await setBroadcastStatus(broadcast.rowIndex, 'failed').catch(() => {});
    }
  }
}

// Hard ceiling on recipients per broadcast. A single bad/compromised queue row
// must never be able to message an unbounded audience. A local bag store's
// opt-in list won't approach this; raise BROADCAST_MAX_RECIPIENTS deliberately
// if a genuine campaign ever needs to.
function broadcastRecipientCap() {
  // min: 0 — an explicit 0 disables broadcasts entirely, which is meaningful.
  return envInt('BROADCAST_MAX_RECIPIENTS', 5000, { min: 0 });
}

async function runBroadcast(broadcast) {
  const allContacts = await getOptInContacts(broadcast.audienceFilter);
  const cap = broadcastRecipientCap();
  let contacts = allContacts;
  if (allContacts.length > cap) {
    console.error(`[BROADCAST] 🚨 "${broadcast.campaignName}" resolved ${allContacts.length} recipients — `
      + `over the safety cap of ${cap}. Sending to the first ${cap} only. `
      + `If this is intended, raise BROADCAST_MAX_RECIPIENTS.`);
    contacts = allContacts.slice(0, cap);
  }
  const langCode = LANG_CODE[broadcast.language] || 'en';

  let variables = {};
  try {
    variables = JSON.parse(broadcast.variablesJson || '{}');
  } catch { /* use empty */ }

  // Build template components from variables
  const components = [];
  // Sanitized for the same reason as the status-update templates: Meta rejects
  // parameters containing newlines/tabs/4+ spaces, and these come from a
  // hand-edited JSON cell in the broadcast_queue sheet.
  const bodyParams = Object.values(variables).map(v => ({
    type: 'text', text: sanitizeTemplateParam(v, 300, '—'),
  }));
  if (bodyParams.length > 0) {
    components.push({ type: 'body', parameters: bodyParams });
  }

  console.log(`[BROADCAST] "${broadcast.campaignName}" → ${contacts.length} contacts`);

  let sent = 0, failed = 0, skipped = 0;
  for (const contact of contacts) {
    if (!isLikelySendablePhone(contact.phone)) {
      skipped++;
      continue;
    }
    try {
      await sendTemplateMessage(contact.phone, broadcast.templateName, langCode, components);
      sent++;
      // Rate limit: 500ms between sends
      await sleep(500);
    } catch (err) {
      failed++;
      console.error(`[BROADCAST] Failed to send to ***${String(contact.phone).slice(-4)}:`, err.message);
    }
  }

  console.log(`[BROADCAST] Done. Sent: ${sent}, Failed: ${failed}, Skipped(bad number): ${skipped}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { runBroadcastQueue };
