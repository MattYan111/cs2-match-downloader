import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MatchSource } from './provider/perfectworld.js';

export const STEAM_ID64_RE = /^\d{17}$/;

export interface PlayerSourceWatermark {
  lastMatchId: string;
  lastStartTime: string | null;
  updatedAt: string;
}

export interface SavedPlayerProfile {
  steamId: string;
  note: string;
  enabled: boolean;
  watermarks: Partial<Record<MatchSource, PlayerSourceWatermark>>;
}

interface StoredPlayersFile {
  version: 1;
  players: SavedPlayerProfile[];
}

export function resolveDefaultPlayersStorePath(): string {
  const custom = process.env.PW_PLAYERS_STORE_PATH?.trim();
  if (custom) {
    return path.resolve(custom);
  }
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'pw-match-downloader', 'players.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'pw-match-downloader', 'players.json');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return path.join(xdgConfig, 'pw-match-downloader', 'players.json');
}

export function parsePwTimeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{10}$/.test(trimmed)) return Number(trimmed) * 1000;
  if (/^\d{13}$/.test(trimmed)) return Number(trimmed);

  const normalizedYmdHm = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed}:00`
    : trimmed;
  const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(normalizedYmdHm);
  const iso = local ? `${normalizedYmdHm.replace(' ', 'T')}+08:00` : normalizedYmdHm;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldStopAtWatermark(
  item: { matchId: string; startTime: string | null },
  watermark: PlayerSourceWatermark | undefined
): boolean {
  if (!watermark) return false;
  if (item.matchId === watermark.lastMatchId) return true;
  const itemMs = parsePwTimeMs(item.startTime);
  const watermarkMs = parsePwTimeMs(watermark.lastStartTime);
  if (itemMs !== null && watermarkMs !== null) {
    return itemMs <= watermarkMs;
  }
  return false;
}

export function parsePlayerInputLines(text: string): Array<{ steamId: string; note: string }> {
  const lines = text.split(/\r?\n/);
  const result: Array<{ steamId: string; note: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith('#')) continue;

    const match = /\b(\d{17})\b/.exec(rawLine);
    if (!match) {
      throw new Error(`第 ${i + 1} 行未包含有效的 17 位 SteamID64：${rawLine}`);
    }
    const steamId = match[1];
    if (seen.has(steamId)) continue;
    seen.add(steamId);

    const before = rawLine.slice(0, match.index).trim();
    const after = rawLine.slice(match.index + steamId.length).trim();
    const rawNote = (after || before)
      .replace(/^[,，|#\s]+/, '')
      .replace(/^#\s*/, '')
      .trim()
      .slice(0, 60);

    result.push({ steamId, note: rawNote });
  }

  return result;
}

function sanitizeWatermark(raw: unknown): PlayerSourceWatermark | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const lastMatchId = typeof obj.lastMatchId === 'string' ? obj.lastMatchId.trim() : '';
  if (!lastMatchId) return undefined;
  const lastStartTime = typeof obj.lastStartTime === 'string' && obj.lastStartTime.trim()
    ? obj.lastStartTime.trim()
    : null;
  const updatedAt = typeof obj.updatedAt === 'string' && obj.updatedAt.trim()
    ? obj.updatedAt.trim()
    : new Date().toISOString();
  return { lastMatchId, lastStartTime, updatedAt };
}

function sanitizeProfile(raw: unknown): SavedPlayerProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const steamId = typeof obj.steamId === 'string' ? obj.steamId.trim() : '';
  if (!STEAM_ID64_RE.test(steamId)) return null;

  const note = typeof obj.note === 'string' ? obj.note.trim().slice(0, 60) : '';
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true;

  const watermarks: Partial<Record<MatchSource, PlayerSourceWatermark>> = {};
  if (obj.watermarks && typeof obj.watermarks === 'object') {
    const wm = obj.watermarks as Record<string, unknown>;
    const official = sanitizeWatermark(wm.official);
    const perfectworld = sanitizeWatermark(wm.perfectworld);
    if (official) watermarks.official = official;
    if (perfectworld) watermarks.perfectworld = perfectworld;
  }

  return { steamId, note, enabled, watermarks };
}

function cloneProfile(profile: SavedPlayerProfile): SavedPlayerProfile {
  return {
    steamId: profile.steamId,
    note: profile.note,
    enabled: profile.enabled,
    watermarks: {
      ...(profile.watermarks.official ? { official: { ...profile.watermarks.official } } : {}),
      ...(profile.watermarks.perfectworld
        ? { perfectworld: { ...profile.watermarks.perfectworld } }
        : {})
    }
  };
}

export class PlayersStore {
  readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(customFilePath?: string) {
    this.filePath = customFilePath ? path.resolve(customFilePath) : resolveDefaultPlayersStorePath();
  }

  async getAll(): Promise<SavedPlayerProfile[]> {
    const profiles = await this.readProfilesFromDisk();
    return profiles.map(cloneProfile);
  }

  async upsertMany(
    entries: Array<{ steamId: string; note?: string; enabled?: boolean }>
  ): Promise<SavedPlayerProfile[]> {
    return this.enqueue(async () => {
      const profiles = await this.readProfilesFromDisk();
      for (const entry of entries) {
        const steamId = entry.steamId.trim();
        if (!STEAM_ID64_RE.test(steamId)) {
          throw new Error(`无效的 SteamID64（需为 17 位数字）：${steamId}`);
        }
        const note = entry.note !== undefined ? entry.note.trim().slice(0, 60) : undefined;
        const existing = profiles.find((p) => p.steamId === steamId);
        if (existing) {
          if (note !== undefined && note !== '') {
            existing.note = note;
          }
          if (entry.enabled !== undefined) {
            existing.enabled = entry.enabled;
          }
        } else {
          profiles.push({
            steamId,
            note: note ?? '',
            enabled: entry.enabled ?? true,
            watermarks: {}
          });
        }
      }
      await this.writeProfilesToDisk(profiles);
      return profiles.map(cloneProfile);
    });
  }

  async updatePlayer(
    steamId: string,
    patch: {
      note?: string;
      enabled?: boolean;
      resetWatermarks?: boolean;
      clearSource?: MatchSource;
    }
  ): Promise<SavedPlayerProfile[]> {
    return this.enqueue(async () => {
      const targetId = steamId.trim();
      const profiles = await this.readProfilesFromDisk();
      const target = profiles.find((p) => p.steamId === targetId);
      if (!target) {
        throw new Error(`未找到已保存的玩家：${targetId}`);
      }
      if (patch.note !== undefined) {
        target.note = patch.note.trim().slice(0, 60);
      }
      if (patch.enabled !== undefined) {
        target.enabled = patch.enabled;
      }
      if (patch.resetWatermarks) {
        target.watermarks = {};
      } else if (patch.clearSource) {
        delete target.watermarks[patch.clearSource];
      }
      await this.writeProfilesToDisk(profiles);
      return profiles.map(cloneProfile);
    });
  }

  async removePlayer(steamId: string): Promise<SavedPlayerProfile[]> {
    return this.enqueue(async () => {
      const targetId = steamId.trim();
      const profiles = await this.readProfilesFromDisk();
      const next = profiles.filter((p) => p.steamId !== targetId);
      await this.writeProfilesToDisk(next);
      return next.map(cloneProfile);
    });
  }

  async advanceWatermark(
    steamId: string,
    source: MatchSource,
    candidate: { matchId: string; startTime: string | null }
  ): Promise<void> {
    const targetId = steamId.trim();
    const matchId = candidate.matchId.trim();
    if (!STEAM_ID64_RE.test(targetId) || !matchId) return;

    await this.enqueue(async () => {
      const profiles = await this.readProfilesFromDisk();
      const target = profiles.find((p) => p.steamId === targetId);
      if (!target) return;

      const existing = target.watermarks[source];
      if (existing) {
        const candidateMs = parsePwTimeMs(candidate.startTime);
        const existingMs = parsePwTimeMs(existing.lastStartTime);
        if (candidateMs !== null && existingMs !== null && candidateMs < existingMs) {
          return;
        }
      }

      target.watermarks[source] = {
        lastMatchId: matchId,
        lastStartTime: candidate.startTime?.trim() || null,
        updatedAt: new Date().toISOString()
      };
      await this.writeProfilesToDisk(profiles);
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async readProfilesFromDisk(): Promise<SavedPlayerProfile[]> {
    let rawText: string;
    try {
      rawText = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== 'object') return [];
    const list = (parsed as { players?: unknown }).players;
    if (!Array.isArray(list)) return [];

    const profiles: SavedPlayerProfile[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      const sanitized = sanitizeProfile(item);
      if (sanitized && !seen.has(sanitized.steamId)) {
        seen.add(sanitized.steamId);
        profiles.push(sanitized);
      }
    }
    return profiles;
  }

  private async writeProfilesToDisk(profiles: SavedPlayerProfile[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const payload: StoredPlayersFile = {
      version: 1,
      players: profiles
    };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
  }
}
