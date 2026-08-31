/**
 * Where state that must survive a redeploy is stored, and when a missing
 * volume is fatal.
 *
 * The bug this guards: four separate *_CACHE_PATH vars meant three of them
 * being right looked identical to all four being right, and a Railway deploy
 * with none of them set silently dropped in-progress bookings on every push
 * while logging only a warning nobody read.
 *
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const dataDirPath = require.resolve('../src/utils/dataDir');
const persistencePath = require.resolve('../src/utils/persistenceCheck');

/** Run fn with a clean env for the vars we care about, then restore. */
function withEnv(vars, fn) {
  const keys = ['DATA_DIR', 'NODE_ENV', 'DEDUP_CACHE_PATH', 'SESSION_CACHE_PATH',
    'THROTTLE_CACHE_PATH', 'HEALTH_CACHE_PATH'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  // Fresh module state so deprecation warnings and caches do not leak between cases.
  delete require.cache[dataDirPath];
  delete require.cache[persistencePath];
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    delete require.cache[dataDirPath];
    delete require.cache[persistencePath];
  }
}

// ── DATA_DIR resolution ───────────────────────────────────────
test('all four state files live under DATA_DIR when it is set', () => {
  withEnv({ DATA_DIR: path.join(os.tmpdir(), 'chanakya-vol-test') }, () => {
    const { allStatePaths } = require('../src/utils/dataDir');
    const files = allStatePaths();
    assert.strictEqual(files.length, 4, 'four files must be covered');
    const names = files.map((f) => path.basename(f.file)).sort();
    assert.deepStrictEqual(names, [
      'health_state.json', 'processed_messages.json', 'sessions.json', 'throttles.json',
    ]);
    for (const f of files) {
      assert.strictEqual(
        path.dirname(path.resolve(f.file)),
        path.resolve(process.env.DATA_DIR),
        `${f.key} must sit directly under DATA_DIR`,
      );
    }
  });
});

test('without DATA_DIR the files fall back to ./data so a fresh clone runs', () => {
  withEnv({}, () => {
    const { allStatePaths } = require('../src/utils/dataDir');
    for (const f of allStatePaths()) {
      assert.strictEqual(path.basename(path.dirname(f.file)), 'data');
    }
  });
});

// ── Backward compatibility ────────────────────────────────────
test('a legacy per-file var still wins, so an upgrade does not move state', () => {
  const legacy = path.join(os.tmpdir(), 'legacy-sessions.json');
  withEnv({ DATA_DIR: os.tmpdir(), SESSION_CACHE_PATH: legacy }, () => {
    const { statePath } = require('../src/utils/dataDir');
    assert.strictEqual(statePath('sessions'), legacy, 'legacy override must be honoured');
    // …but only for the file it names.
    assert.strictEqual(path.basename(statePath('dedup')), 'processed_messages.json');
    assert.strictEqual(path.dirname(path.resolve(statePath('dedup'))), path.resolve(os.tmpdir()));
  });
});

test('the deprecation warning fires once per variable, not once per call', () => {
  withEnv({ SESSION_CACHE_PATH: path.join(os.tmpdir(), 'x.json') }, () => {
    const { statePath } = require('../src/utils/dataDir');
    const seen = [];
    const orig = console.warn;
    console.warn = (...a) => seen.push(a.join(' '));
    try {
      statePath('sessions'); statePath('sessions'); statePath('sessions');
    } finally { console.warn = orig; }
    const deprecations = seen.filter((l) => l.includes('SESSION_CACHE_PATH is deprecated'));
    assert.strictEqual(deprecations.length, 1, 'must warn exactly once');
    assert.ok(deprecations[0].includes('DATA_DIR'), 'warning must point at the replacement');
  });
});

// ── Fail fast, but only in production ─────────────────────────
test('production refuses to boot without DATA_DIR', () => {
  withEnv({ NODE_ENV: 'production' }, () => {
    const { fatalPersistenceProblems } = require('../src/utils/persistenceCheck');
    const reasons = fatalPersistenceProblems();
    assert.strictEqual(reasons.length, 1);
    assert.ok(reasons[0].includes('DATA_DIR'), 'reason must name the variable to set');
  });
});

test('production refuses to boot when DATA_DIR cannot be written', () => {
  withEnv({ NODE_ENV: 'production', DATA_DIR: path.join('Z:', 'definitely', 'not', 'here') }, () => {
    const { fatalPersistenceProblems } = require('../src/utils/persistenceCheck');
    assert.strictEqual(fatalPersistenceProblems().length, 1);
  });
});

test('production boots when DATA_DIR is set and writable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-vol-'));
  withEnv({ NODE_ENV: 'production', DATA_DIR: dir }, () => {
    const { fatalPersistenceProblems } = require('../src/utils/persistenceCheck');
    assert.deepStrictEqual(fatalPersistenceProblems(), []);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('development and staging warn only — a laptop must not need a volume', () => {
  for (const env of ['development', 'test', undefined]) {
    withEnv(env ? { NODE_ENV: env } : {}, () => {
      const { fatalPersistenceProblems } = require('../src/utils/persistenceCheck');
      assert.deepStrictEqual(
        fatalPersistenceProblems(), [],
        `NODE_ENV=${env} must never be fatal`,
      );
    });
  }
});
