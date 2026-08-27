/**
 * Approved WhatsApp template names.
 *
 * Jobs used to fall back to hardcoded names (repair_status_update_en, …).
 * Those names are what we *will* submit to Meta — they are not approved yet.
 * Calling Graph with an unapproved name fails, and the status poller treats
 * three failures as "unsubscribe this customer". So we only send when the
 * operator has explicitly set the env vars after Meta shows APPROVED.
 */

const { envStr } = require('./env');

const LANG_CODE = { english: 'en', hindi: 'hi', gujarati: 'gu' };

const REPAIR_ENV = {
  english:  'REPAIR_UPDATE_TEMPLATE_EN',
  hindi:    'REPAIR_UPDATE_TEMPLATE_HI',
  gujarati: 'REPAIR_UPDATE_TEMPLATE_GU',
};

const FEEDBACK_ENV = {
  english:  'FEEDBACK_TEMPLATE_EN',
  hindi:    'FEEDBACK_TEMPLATE_HI',
  gujarati: 'FEEDBACK_TEMPLATE_GU',
};

function named(envMap, lang) {
  const key = envMap[lang] || envMap.english;
  const name = envStr(key);
  if (name) return { name, langCode: LANG_CODE[lang] || 'en' };
  const en = envStr(envMap.english);
  if (en) return { name: en, langCode: 'en' };
  return null;
}

function repairUpdatesReady() {
  return Object.values(REPAIR_ENV).some((k) => envStr(k));
}

function feedbackTemplatesReady() {
  return Object.values(FEEDBACK_ENV).some((k) => envStr(k));
}

function resolveRepairUpdateTemplate(lang) {
  return named(REPAIR_ENV, lang);
}

function resolveFeedbackTemplate(lang) {
  return named(FEEDBACK_ENV, lang);
}

/** Missing env var names — for the boot warning. */
function missingTemplateEnv() {
  const missing = [];
  for (const k of Object.values(REPAIR_ENV)) if (!envStr(k)) missing.push(k);
  for (const k of Object.values(FEEDBACK_ENV)) if (!envStr(k)) missing.push(k);
  return missing;
}

module.exports = {
  LANG_CODE,
  repairUpdatesReady,
  feedbackTemplatesReady,
  resolveRepairUpdateTemplate,
  resolveFeedbackTemplate,
  missingTemplateEnv,
};
