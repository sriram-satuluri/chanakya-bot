const fs = require('fs');
const path = require('path');
const { verifyMetaWhatsAppCredentials } = require('../services/whatsapp');
const { readTicketRows } = require('../services/sheets');
const { getRecipientsForCorporate } = require('../utils/ownerPhones');
const { notifyOwners } = require('../utils/ownerAlert');
const { envInt } = require('../utils/env');
const { formatIST } = require('../utils/istTime');
const { statePath } = require('../utils/dataDir');

/**
 * Periodic health check with owner alerting.
 *
 * Probes Meta + Sheets and WhatsApps the owners when one stays broken.
 * Alerts on the Nth consecutive failure (default 2), and once again on recovery.
 *
 * Failure counts are written to disk so a redeploy cannot reset the counter
 * and delay an alert that was already one tick away.
 */

const FAILURES_BEFORE_ALERT = envInt('HEALTH_FAILURES_BEFORE_ALERT', 2, { min: 1 });

function resolvePath() {
  return statePath('health');
}

function emptyState() {
  return {
    meta:   { failures: 0, alerted: false },
    sheets: { failures: 0, alerted: false },
  };
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(resolvePath(), 'utf8'));
    const out = emptyState();
    for (const key of ['meta', 'sheets']) {
      if (raw && raw[key]) {
        out[key].failures = Number(raw[key].failures) || 0;
        out[key].alerted = Boolean(raw[key].alerted);
      }
    }
    return out;
  } catch {
    return emptyState();
  }
}

function saveState() {
  try {
    const fp = resolvePath();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[HEALTH] persist failed:', e.message);
  }
}

/** subsystem -> { failures, alerted } */
const state = loadState();

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
  await readTicketRows();
}

async function alertOwners(text, kind) {
  // A health alert that itself fails silently is the worst case in the system —
  // the bot is down AND nobody is told. notifyOwners logs [OWNER-ALERT-LOST]
  // when the 24h window is the reason.
  await notifyOwners(getRecipientsForCorporate(), text, { kind });
}

async function checkOne(key, probe) {
  const s = state[key];
  try {
    await probe();
    if (s.alerted) {
      console.log(`[HEALTH] ${LABELS[key]} recovered.`);
      await alertOwners(
        `✅ *Chanakya bot recovered*\n\n${LABELS[key]} is responding again as of ${formatIST(new Date())}.\n\n`
        + `_Normal service has resumed._`,
        `health_recovered_${key}`,
      );
    }
    s.failures = 0;
    s.alerted = false;
    saveState();
    return true;
  } catch (e) {
    s.failures += 1;
    console.error(`[HEALTH] ${LABELS[key]} check FAILED (${s.failures}x): ${e.message}`);
    if (s.failures >= FAILURES_BEFORE_ALERT && !s.alerted) {
      s.alerted = true;
      await alertOwners(
        `🚨 *Chanakya bot is not working*\n\n`
        + `*${LABELS[key]}* has failed ${s.failures} checks in a row.\n\n`
        + `_Error:_ ${String(e.message).slice(0, 200)}\n\n`
        + `${HINTS[key]}\n\n`
        + `_Detected ${formatIST(new Date())}. You will get one more message when it recovers._`,
        `health_down_${key}`,
      );
    }
    saveState();
    return false;
  }
}

async function runHealthCheck() {
  const metaOk = await checkOne('meta', probeMeta);
  const sheetsOk = await checkOne('sheets', probeSheets);
  if (metaOk && sheetsOk) console.log('[HEALTH] OK — Meta and Sheets both responding.');
}

module.exports = { runHealthCheck };
