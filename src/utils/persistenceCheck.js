/**
 * Boot-time persistence check.
 *
 * Some state has to survive a redeploy. Right now that is the webhook dedup
 * store (utils/dedupStore.js), which remembers processed message ids for 7
 * days so that Meta retrying a webhook after a restart cannot create a
 * DUPLICATE repair ticket. If that file lives on an ephemeral container
 * filesystem instead of a mounted volume, every redeploy silently resets the
 * window and the protection quietly stops working — with no error, because
 * writing to an ephemeral disk succeeds perfectly well.
 *
 * That silent-failure shape is exactly why this check exists: it makes the
 * condition visible in the boot logs rather than something you discover from
 * a duplicate ticket weeks later. It never blocks startup — a bot that refuses
 * to boot is worse than one running without dedup persistence.
 *
 * Detection is necessarily heuristic (a process cannot definitively ask "am I
 * on a mounted volume?"), so it combines three signals:
 *   1. Is the directory actually writable? (real write probe, not fs.access)
 *   2. Did a marker file we wrote on a previous boot survive?
 *   3. Is the path inside the app directory? On Railway/Render a real volume
 *      mounts at an absolute path OUTSIDE the deployed code.
 */

const fs = require('fs');
const path = require('path');

const MARKER_NAME = '.persistence_marker.json';

/**
 * Files that must survive a redeploy. Add future ones here — the check is
 * written against this list, not against any single file.
 */
function persistentPaths() {
  return [
    {
      label: 'webhook dedup store',
      why: 'prevents duplicate repair tickets when Meta retries a webhook after a restart',
      file: process.env.DEDUP_CACHE_PATH?.trim()
        || path.join(process.cwd(), 'data', 'processed_messages.json'),
    },
  ];
}

function banner(lines) {
  const width = Math.max(...lines.map((l) => l.length), 60);
  const bar = '═'.repeat(width + 2);
  console.error(`\n╔${bar}╗`);
  for (const l of lines) console.error(`║ ${l.padEnd(width)} ║`);
  console.error(`╚${bar}╝\n`);
}

/** Real write probe — fs.access can disagree with reality in containers. */
function isWritable(dir) {
  const probe = path.join(dir, `.write_probe_${process.pid}`);
  try {
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER_NAME), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(dir, prev) {
  const now = new Date().toISOString();
  const marker = {
    bootCount: (prev?.bootCount || 0) + 1,
    firstBootAt: prev?.firstBootAt || now,
    lastBootAt: now,
  };
  try {
    fs.writeFileSync(path.join(dir, MARKER_NAME), JSON.stringify(marker, null, 2), 'utf8');
  } catch (e) {
    console.warn('[PERSISTENCE] Could not write marker file:', e.message);
  }
  return marker;
}

function humanAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Run the check and log the outcome. Never throws, never blocks startup.
 * @returns {{ok: boolean, warnings: string[]}}
 */
function checkPersistence() {
  const isProd = process.env.NODE_ENV === 'production';
  const warnings = [];

  for (const target of persistentPaths()) {
    const dir = path.dirname(path.resolve(target.file));

    // 1. Directory exists (or can be created)?
    let existedBefore = fs.existsSync(dir);
    if (!existedBefore) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        warnings.push(`${target.label}: cannot create ${dir} — ${e.message}`);
        banner([
          'PERSISTENCE PROBLEM — DIRECTORY NOT CREATABLE',
          '',
          `Path : ${dir}`,
          `For  : ${target.label}`,
          `Why  : ${target.why}`,
          '',
          'State will be lost on every restart, not just redeploys.',
        ]);
        continue;
      }
    }

    // 2. Actually writable?
    if (!isWritable(dir)) {
      warnings.push(`${target.label}: ${dir} is not writable`);
      banner([
        'PERSISTENCE PROBLEM — DIRECTORY NOT WRITABLE',
        '',
        `Path : ${dir}`,
        `For  : ${target.label}`,
        `Why  : ${target.why}`,
        '',
        'The bot will keep running, but this state cannot be saved at all.',
      ]);
      continue;
    }

    // 3. Did a previous boot's marker survive?
    const prev = readMarker(dir);
    const marker = writeMarker(dir, prev);

    // 4. Is the path inside the deployed app directory? On Railway/Render a
    //    real volume mounts at an absolute path outside the code checkout, so
    //    a data dir under cwd in production is a strong ephemerality signal.
    const insideAppDir = path.resolve(dir).startsWith(path.resolve(process.cwd()));

    if (!prev && isProd) {
      warnings.push(`${target.label}: no marker from a previous boot`);
      banner([
        'WARNING — PERSISTENCE MAY NOT SURVIVE REDEPLOYS',
        '',
        `Path : ${dir}`,
        `For  : ${target.label}`,
        `Why  : ${target.why}`,
        '',
        'No marker from a previous boot was found. Either this is the very',
        'first deploy (fine — this message should NOT appear next time), or',
        'the filesystem is ephemeral and last deploy\'s data was discarded.',
        '',
        'If you see this on EVERY boot, the volume is not mounted.',
        insideAppDir
          ? 'The path is inside the app directory, which on Railway/Render is'
          : 'Confirm the mount path matches this directory.',
        insideAppDir
          ? 'ephemeral. Mount a volume and point DEDUP_CACHE_PATH at it.'
          : '',
      ].filter(Boolean));
    } else if (insideAppDir && isProd) {
      warnings.push(`${target.label}: data dir is inside the app directory`);
      banner([
        'WARNING — DATA DIRECTORY LOOKS EPHEMERAL',
        '',
        `Path : ${dir}`,
        `For  : ${target.label}`,
        '',
        'This path sits inside the deployed application directory. On Railway',
        'and Render that filesystem is wiped on every redeploy; mounted',
        'volumes live at an absolute path outside the code.',
        '',
        'Mount a volume and set DEDUP_CACHE_PATH to a path on it.',
        '',
        `(Marker survived ${marker.bootCount - 1} previous boot(s), so this may`,
        'be a false alarm on a host that keeps the directory. Verify once.)',
      ]);
    } else if (prev) {
      console.log(
        `[PERSISTENCE] OK — ${target.label}: data directory retained state from a previous boot `
        + `(boot #${marker.bootCount}, last boot ${humanAge(prev.lastBootAt)}, dir: ${dir})`,
      );
    } else {
      console.log(
        `[PERSISTENCE] ${target.label}: first boot in ${dir} (no previous marker — expected on a fresh setup).`,
      );
    }
  }

  return { ok: warnings.length === 0, warnings };
}

module.exports = { checkPersistence, persistentPaths };
