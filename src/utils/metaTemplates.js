/**
 * WhatsApp template names for repair-status updates.
 *
 * REPAIR_UPDATE_TEMPLATE_EN/HI/GU override the built-in names
 * (repair_status_update_en/hi/gu) once Meta shows those templates APPROVED.
 * Until then the poller still tries the built-in name. A "template does not
 * exist" or payment-method error is retried later — it does not unsubscribe
 * the customer. Feedback templates stay off until their env vars are set.
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

/** Used when REPAIR_UPDATE_TEMPLATE_* is unset. Meta must show these APPROVED. */
const DEFAULT_REPAIR_TEMPLATE = {
  english:  'repair_status_update_en',
  hindi:    'repair_status_update_hi',
  gujarati: 'repair_status_update_gu',
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
  return true;
}

function repairTemplateEnvSet() {
  return Object.values(REPAIR_ENV).some((k) => envStr(k));
}

function feedbackTemplatesReady() {
  return Object.values(FEEDBACK_ENV).some((k) => envStr(k));
}

function resolveRepairUpdateTemplate(lang) {
  const fromEnv = named(REPAIR_ENV, lang);
  if (fromEnv) return fromEnv;
  const key = DEFAULT_REPAIR_TEMPLATE[lang] ? lang : 'english';
  return { name: DEFAULT_REPAIR_TEMPLATE[key], langCode: LANG_CODE[key] || 'en' };
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
  DEFAULT_REPAIR_TEMPLATE,
  repairUpdatesReady,
  repairTemplateEnvSet,
  feedbackTemplatesReady,
  resolveRepairUpdateTemplate,
  resolveFeedbackTemplate,
  missingTemplateEnv,
};
