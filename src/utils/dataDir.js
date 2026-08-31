/**
 * Where state that must survive a redeploy lives.
 *
 * There used to be four separate env vars — DEDUP_CACHE_PATH,
 * SESSION_CACHE_PATH, THROTTLE_CACHE_PATH, HEALTH_CACHE_PATH — one per file.
 * Four chances to typo a path, and three of them being right was indis-
 * tinguishable at a glance from all four being right. Setting DATA_DIR once
 * is a single thing to get correct, and it is the thing a Railway volume
 * mount actually gives you.
 *
 * The old four still work. If one is set it wins for that file and we say so
 * once, so an existing deployment does not silently move its state on upgrade.
 */

const path = require('path');

/** Legacy var -> filename under DATA_DIR. Also the canonical list of state files. */
const STATE_FILES = [
  {
    key: 'dedup',
    legacyEnv: 'DEDUP_CACHE_PATH',
    filename: 'processed_messages.json',
    label: 'webhook dedup store',
    why: 'prevents duplicate repair tickets when Meta retries a webhook after a restart',
  },
  {
    key: 'sessions',
    legacyEnv: 'SESSION_CACHE_PATH',
    filename: 'sessions.json',
    label: 'conversation sessions',
    why: 'keeps in-progress bookings alive across a redeploy instead of silently losing them',
  },
  {
    key: 'throttles',
    legacyEnv: 'THROTTLE_CACHE_PATH',
    filename: 'throttles.json',
    label: 'per-phone throttles',
    why: 'ticket / lead / handoff cooldowns must survive a redeploy or a spammer gets a free window',
  },
  {
    key: 'health',
    legacyEnv: 'HEALTH_CACHE_PATH',
    filename: 'health_state.json',
    label: 'health-check counters',
    why: 'a redeploy must not reset consecutive Meta/Sheets failures and delay the owner alert',
  },
];

/** True when DATA_DIR was explicitly configured (as opposed to falling back). */
function dataDirIsExplicit() {
  return Boolean(process.env.DATA_DIR?.trim());
}

/**
 * The directory state files live in. Falls back to ./data so a fresh clone and
 * the test suite work with no configuration; production requires it to be set
 * explicitly (see utils/persistenceCheck.js).
 */
function dataDir() {
  return process.env.DATA_DIR?.trim() || path.join(process.cwd(), 'data');
}

/** Deprecation notices are per-variable and per-process, not per-call. */
const _warned = new Set();

/**
 * Absolute path for one state file, honouring its legacy override.
 * @param {string} key one of STATE_FILES[].key
 */
function statePath(key) {
  const spec = STATE_FILES.find((f) => f.key === key);
  if (!spec) throw new Error(`Unknown state file key: ${key}`);

  const legacy = process.env[spec.legacyEnv]?.trim();
  if (legacy) {
    if (!_warned.has(spec.legacyEnv)) {
      _warned.add(spec.legacyEnv);
      console.warn(
        `[CONFIG] ${spec.legacyEnv} is deprecated — set DATA_DIR to the directory instead `
        + `and remove this variable. Still honouring ${spec.legacyEnv} for now so an existing `
        + `deployment does not move its ${spec.label} on upgrade.`,
      );
    }
    return legacy;
  }
  return path.join(dataDir(), spec.filename);
}

/** Every state file with its resolved path — used by the boot check. */
function allStatePaths() {
  return STATE_FILES.map((f) => ({ ...f, file: statePath(f.key) }));
}

// STATE_FILES stays private — callers want allStatePaths() or statePath(),
// both of which resolve the legacy overrides. Handing out the raw table would
// invite someone to join a filename onto DATA_DIR themselves and quietly skip
// that resolution, which is exactly the drift this module exists to prevent.
module.exports = { dataDir, dataDirIsExplicit, statePath, allStatePaths };
