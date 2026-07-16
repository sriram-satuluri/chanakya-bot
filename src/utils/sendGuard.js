/**
 * Outbound circuit breaker — the single most important cost/reputation guard.
 *
 * Every real WhatsApp message costs money and counts against Meta's spam/quality
 * signals. A bug (a routing loop, a runaway cron), a compromised or fat-fingered
 * Google Sheet, or a retry storm could otherwise make the bot fire thousands of
 * sends — a large bill AND a fast path to getting the business number banned.
 *
 * This module enforces two fixed-window caps (per-minute and per-day) plus a
 * hard kill switch. It is deliberately generous: normal operation (a 500 ms-spaced
 * broadcast peaks ~120/min) never trips it, but a no-delay loop hits the per-minute
 * ceiling in under a second and is stopped cold.
 *
 * Tunables (all optional; safe defaults):
 *   OUTBOUND_KILL_SWITCH=1        → block ALL outbound sends immediately (panic stop)
 *   OUTBOUND_MAX_PER_MIN=240      → per-minute ceiling
 *   OUTBOUND_MAX_PER_DAY=20000    → per-day ceiling
 *
 * No new dependencies; state is two integer counters. Read receipts are NOT
 * counted (they are free and not spam-relevant).
 */

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function killSwitchOn() {
  const v = String(process.env.OUTBOUND_KILL_SWITCH || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const WINDOW_MIN_MS = 60 * 1000;
const WINDOW_DAY_MS = 24 * 60 * 60 * 1000;

let minute = { count: 0, resetAt: 0, breached: false };
let day = { count: 0, resetAt: 0, breached: false };

class OutboundBlockedError extends Error {
  constructor(reason) {
    super(`Outbound send blocked: ${reason}`);
    this.name = 'OutboundBlockedError';
    this.blockedReason = reason;
  }
}

/**
 * Call once immediately before each real outbound message. Throws
 * OutboundBlockedError if a cap is hit or the kill switch is on — the caller's
 * existing try/catch then logs it and moves on (customer reply is dropped, which
 * is the intended fail-safe when we're in a runaway/abuse state).
 */
function assertCanSend() {
  if (killSwitchOn()) {
    throw new OutboundBlockedError('OUTBOUND_KILL_SWITCH is set');
  }

  const now = Date.now();
  const maxMin = envInt('OUTBOUND_MAX_PER_MIN', 240);
  const maxDay = envInt('OUTBOUND_MAX_PER_DAY', 20000);

  if (now >= minute.resetAt) minute = { count: 0, resetAt: now + WINDOW_MIN_MS, breached: false };
  if (now >= day.resetAt) day = { count: 0, resetAt: now + WINDOW_DAY_MS, breached: false };

  if (minute.count >= maxMin) {
    // Log once per window so a runaway doesn't also flood the logs.
    if (!minute.breached) {
      minute.breached = true;
      console.error(`[SEND-GUARD] 🚨 Per-minute outbound cap hit (${maxMin}/min). `
        + `Blocking further sends until the window resets. Likely a loop or abuse — investigate. `
        + `Raise OUTBOUND_MAX_PER_MIN only if this is a legitimate large campaign.`);
    }
    throw new OutboundBlockedError(`per-minute cap ${maxMin} reached`);
  }

  if (day.count >= maxDay) {
    if (!day.breached) {
      day.breached = true;
      console.error(`[SEND-GUARD] 🚨 Per-DAY outbound cap hit (${maxDay}/day). `
        + `Blocking further sends until midnight-of-window. Raise OUTBOUND_MAX_PER_DAY if intended.`);
    }
    throw new OutboundBlockedError(`per-day cap ${maxDay} reached`);
  }

  minute.count++;
  day.count++;
}

/** For diagnostics / tests. */
function snapshot() {
  return { minute: { ...minute }, day: { ...day }, killSwitch: killSwitchOn() };
}

module.exports = { assertCanSend, OutboundBlockedError, snapshot };
