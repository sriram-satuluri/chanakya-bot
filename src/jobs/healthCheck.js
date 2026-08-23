const { verifyMetaWhatsAppCredentials, sendTextMessage } = require('../services/whatsapp');
const { readTicketRows } = require('../services/sheets');
const { getRecipientsForCorporate } = require('../utils/ownerPhones');
const { envInt } = require('../utils/env');
const { formatIST } = require('../utils/istTime');

/**
 * Periodic health check with owner alerting.
 *
 * Until now, logs went to stdout and nowhere else. If the Meta token expired
 * or the Sheets credentials broke at 2am, the first anyone knew was a
 * customer complaining — the bot fails SILENTLY, staying up and answering
 * health checks while being unable to do anything useful.
 *
 * This probes the two things the bot cannot function without and messages the
 * owners when one stays broken. Deliberately alerts on the SECOND consecutive
 * failure, not the first: a single transient blip at 3am is not worth waking
 * anyone for, but two in a row is a real outage.
 *
 * Recovery is announced too — otherwise the only way to know it's fixed is to
 * notice the absence of further alerts, which nobody does.
 */

const FAILURES_BEFORE_ALERT = envInt('HEALTH_FAILURES_BEFORE_ALERT', 2, { min: 1 });

/** subsystem -> { failures, alerted } */
const state = {
  meta:   { failures: 0, alerted: false },
  sheets: { failures: 0, alerted: false },
};

const LABELS = {
  meta:   'WhatsApp / Meta API',
  sheets: 'Google Sheets',
};

const HINTS = {
  meta: 'The access token has most likely expired or been revoked. '
      + 'Generate a new permanent System User token and redeploy. '
      + 'Until then the bot cannot send ANY message.',
  sheets: 'The service-account credentials or sheet permissions are failing. '
        + 'Until then the bot cannot create or look up tickets.',
};

async function probeMeta() {
  const r = await verifyMetaWhatsAppCredentials();
  if (!r.ok) throw new Error(r.message || r.reason || 'credential check failed');
}

async function probeSheets() {
  // Cheapest meaningful read — also exercises auth, which is what usually breaks.
  await readTicketRows();
}

async function alertOwners(text) {
  const recipients = getRecipientsForCorporate();
  if (!recipients.length) {
    console.warn('[HEALTH] No owner numbers configured — alert not sent.');
    return;
  }
  for (const p of recipients) {
    // Deliberately NOT .catch(() => {}) silently — if we can't even alert,
    // that itself is worth a log line.
    await sendTextMessage(p, text).catch((e) =>
      console.error('[HEALTH] Failed to alert owner:', e.message));
  }
}

async function checkOne(key, probe) {
  const s = state[key];
  try {
    await probe();
    if (s.alerted) {
      // Recovered — say so, then reset.
      console.log(`[HEALTH] ${LABELS[key]} recovered.`);
      await alertOwners(
        `✅ *Chanakya bot recovered*\n\n${LABELS[key]} is responding again as of ${formatIST(new Date())}.\n\n`
        + `_Normal service has resumed._`,
      );
    }
    s.failures = 0;
    s.alerted = false;
    return true;
  } catch (e) {
    s.failures += 1;
    console.error(`[HEALTH] ${LABELS[key]} check FAILED (${s.failures}x): ${e.message}`);
    if (s.failures >= FAILURES_BEFORE_ALERT && !s.alerted) {
      s.alerted = true; // one alert per outage, not one per tick
      await alertOwners(
        `🚨 *Chanakya bot is not working*\n\n`
        + `*${LABELS[key]}* has failed ${s.failures} checks in a row.\n\n`
        + `_Error:_ ${String(e.message).slice(0, 200)}\n\n`
        + `${HINTS[key]}\n\n`
        + `_Detected ${formatIST(new Date())}. You will get one more message when it recovers._`,
      );
    }
    return false;
  }
}

async function runHealthCheck() {
  const metaOk = await checkOne('meta', probeMeta);
  const sheetsOk = await checkOne('sheets', probeSheets);
  if (metaOk && sheetsOk) console.log('[HEALTH] OK — Meta and Sheets both responding.');
}

module.exports = { runHealthCheck, _state: state };
