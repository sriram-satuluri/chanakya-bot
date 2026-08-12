/**
 * Environment-variable parsing helpers.
 *
 * The codebase previously used `Number(process.env.X) || fallback` in several
 * places. That silently ignores an explicit 0 — because 0 is falsy — so
 * PROACTIVE_START_HOUR=0 (midnight) became 10, and OUTBOUND_MAX_PER_MIN=0
 * ("block everything") became 240. An operator setting a deliberate zero and
 * watching it be ignored is exactly the kind of surprise that erodes trust in
 * the config, so parsing is centralised here instead.
 */

/**
 * Integer from env, respecting an explicit 0.
 * Falls back only when the variable is unset, empty, or not a finite number.
 *
 * @param {string} name  env var name
 * @param {number} fallback used when unset/empty/unparseable
 * @param {{min?: number, max?: number}} [opts] inclusive clamp; out-of-range
 *   values fall back (and warn) rather than being silently clamped, so a typo
 *   like PROACTIVE_START_HOUR=99 is visible instead of quietly becoming 23.
 */
function envInt(name, fallback, opts = {}) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;

  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[CONFIG] ${name}="${raw}" is not a number — using default ${fallback}.`);
    return fallback;
  }

  const v = Math.trunc(n);
  if (opts.min !== undefined && v < opts.min) {
    console.warn(`[CONFIG] ${name}=${v} is below the minimum ${opts.min} — using default ${fallback}.`);
    return fallback;
  }
  if (opts.max !== undefined && v > opts.max) {
    console.warn(`[CONFIG] ${name}=${v} is above the maximum ${opts.max} — using default ${fallback}.`);
    return fallback;
  }
  return v;
}

/** Boolean from env: '1' / 'true' / 'yes' (case-insensitive) are true. */
function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  return fallback;
}

module.exports = { envInt, envBool };
