import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Root for all persisted scraper sessions (cookies / auth-state). */
export const SESSION_DIR =
  String(process.env.SESSION_DIR || '').trim() || path.join(process.cwd(), 'sessions');

/** Legacy flat directory used before SESSION_DIR standardization. */
const LEGACY_DATA_DIR =
  String(process.env.LEGACY_SESSION_DIR || '').trim() || path.join(process.cwd(), 'data');

/**
 * Profiles map 1:1 to subdirectories under SESSION_DIR.
 * Keep auth filenames stable so env overrides stay simple.
 */
export const SESSION_PROFILES = {
  bank: { dir: 'bank', file: 'auth-state.json', envKey: 'AUTH_STATE_PATH', legacy: 'auth-state.json' },
  'visa-cal': {
    dir: 'visa-cal',
    file: 'auth-token.txt',
    envKey: 'CAL_AUTH_STATE_PATH',
    legacy: 'cal-auth-token.txt',
  },
  'harel-meni': {
    dir: 'harel-meni',
    file: 'auth-state.json',
    envKey: 'HAREL_AUTH_STATE_PATH',
    legacy: 'harel-auth-state.json',
  },
  'harel-efrat': {
    dir: 'harel-efrat',
    file: 'auth-state.json',
    envKey: 'EFRAT_HAREL_AUTH_STATE_PATH',
    legacy: 'efrat-harel-auth-state.json',
  },
  'meitav-pension': {
    dir: 'meitav-pension',
    file: 'auth-state.json',
    envKey: 'MEITAV_PENSION_AUTH_STATE_PATH',
    legacy: 'meitav-pension-auth-state.json',
  },
  phoenix: {
    dir: 'phoenix',
    file: 'auth-state.json',
    envKey: 'PHOENIX_AUTH_STATE_PATH',
    legacy: 'phoenix-auth-state.json',
  },
};

export function ensureSessionRoot() {
  mkdirSync(SESSION_DIR, { recursive: true });
  for (const profile of Object.values(SESSION_PROFILES)) {
    mkdirSync(path.join(SESSION_DIR, profile.dir), { recursive: true });
  }
  return SESSION_DIR;
}

/**
 * Resolve the on-disk path for a provider profile.
 * Explicit env overrides (e.g. HAREL_AUTH_STATE_PATH) win over SESSION_DIR defaults.
 */
export function getSessionPath(profileKey) {
  const profile = SESSION_PROFILES[profileKey];
  if (!profile) {
    throw new Error(`Unknown session profile: ${profileKey}`);
  }
  const override = profile.envKey ? String(process.env[profile.envKey] || '').trim() : '';
  if (override) return override;

  const dir = path.join(SESSION_DIR, profile.dir);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, profile.file);
}

/**
 * One-time copy from legacy /app/data flat files into /app/sessions/<profile>/…
 * Never overwrites an existing session file at the new location.
 */
export async function migrateLegacySessions() {
  ensureSessionRoot();
  const results = [];

  for (const [key, profile] of Object.entries(SESSION_PROFILES)) {
    const dest = getSessionPath(key);
    if (existsSync(dest)) {
      results.push({ key, status: 'exists' });
      continue;
    }

    const legacyCandidates = [
      path.join(LEGACY_DATA_DIR, profile.legacy),
      // Older docker layout sometimes wrote directly under /app/data with env paths.
      path.join('/app/data', profile.legacy),
    ];

    let copied = false;
    for (const src of legacyCandidates) {
      if (!existsSync(src) || src === dest) continue;
      try {
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(src, dest);
        console.info(`session migrate ${key}: ${src} → ${dest}`);
        results.push({ key, status: 'migrated', from: src });
        copied = true;
        break;
      } catch (error) {
        console.info(
          `session migrate ${key} failed ${String(error.message || '').slice(0, 100)}`,
        );
      }
    }
    if (!copied) results.push({ key, status: 'missing' });
  }

  return results;
}
