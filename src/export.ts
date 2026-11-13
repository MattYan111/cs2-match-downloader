import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { type MatchSource, SOURCE_CONFIG } from './provider/perfectworld.js';

export const TOOL_NAME = 'pw-match-downloader';
export const TOOL_VERSION = '0.1.0';
export const EXPORT_FORMAT_VERSION = 1;

const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilenameSegment(input: string): string {
  let cleaned = input
    .replaceAll('@', '-')
    .replace(/[<>:"/\\|?*\x00-\x1f\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.\s-]+$/g, '');

  if (!cleaned) {
    cleaned = 'match';
  }
  if (WINDOWS_RESERVED_RE.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  return cleaned;
}

export function formatLocalTimestampForFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}`;
}

export function createMatchBaseFilename(
  source: MatchSource,
  matchId: string,
  usedNames: Set<string>
): string {
  const prefix = SOURCE_CONFIG[source].filePrefix;
  const safeId = sanitizeFilenameSegment(matchId);
  let candidate = `${prefix}-${safeId}.json`;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${prefix}-${safeId}-${counter}.json`;
    counter++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export interface ExportedMatchEntry {
  matchId: string;
  filename: string;
  cleanJsonText: string;
  rawBody?: string;
}

export interface ExportRawListPage {
  pageIndex: number;
  rawBody: string;
}

export interface ExportFailureEntry {
  matchId: string;
  reason: string;
}

export interface ExportManifest {
  toolName: string;
  toolVersion: string;
  exportFormatVersion: number;
  exportedAt: string;
  targetSteamId: string;
  source: MatchSource;
  sourceLabel: string;
  dataSource: number;
  includeRawResponses: boolean;
  requestedCount: number;
  actualCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  files: Array<{
    matchId: string;
    file: string;
    rawFile?: string;
  }>;
  rawListFiles?: string[];
  failures: ExportFailureEntry[];
}

export interface BuiltExportArtifact {
  kind: 'json' | 'zip';
  downloadFilename: string;
  contentType: string;
  filePath: string;
  manifest: ExportManifest;
}

export async function createTempExportRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'pw-match-dl-'));
}

export async function removeTempDirSafe(dirPath: string | null): Promise<void> {
  if (!dirPath) return;
  try {
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on shutdown
  }
}

export async function buildExportArtifact(params: {
  workDir: string;
  source: MatchSource;
  targetSteamId: string;
  includeRaw: boolean;
  singleMatchRequested: boolean;
  requestedCount: number;
  actualCount: number;
  cancelledCount: number;
  matches: ExportedMatchEntry[];
  rawListPages: ExportRawListPage[];
  failures: ExportFailureEntry[];
  now?: Date;
}): Promise<BuiltExportArtifact> {
  if (params.matches.length === 0) {
    throw new Error('没有已成功导出的比赛结果可供生成文件');
  }

  const now = params.now ?? new Date();
  const sourceCfg = SOURCE_CONFIG[params.source];
  await mkdir(params.workDir, { recursive: true });

  const manifestFiles: ExportManifest['files'] = params.matches.map((item) => ({
    matchId: item.matchId,
    file: `matches/${item.filename}`,
    ...(params.includeRaw && item.rawBody !== undefined
      ? { rawFile: `raw/matches/${item.filename}` }
      : {})
  }));

  const rawListFiles =
    params.includeRaw && params.rawListPages.length > 0
      ? params.rawListPages.map((p) => `raw/list/page-${String(p.pageIndex).padStart(3, '0')}.json`)
      : undefined;

  const manifest: ExportManifest = {
    toolName: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    targetSteamId: params.targetSteamId,
    source: params.source,
    sourceLabel: sourceCfg.label,
    dataSource: sourceCfg.dataSource,
    includeRawResponses: params.includeRaw,
    requestedCount: params.requestedCount,
    actualCount: params.actualCount,
    succeededCount: params.matches.length,
    failedCount: params.failures.length,
    cancelledCount: params.cancelledCount,
    files: manifestFiles,
    ...(rawListFiles ? { rawListFiles } : {}),
    failures: params.failures
  };

  // Single match without raw responses => direct JSON download
  if (
    params.singleMatchRequested &&
    !params.includeRaw &&
    params.matches.length === 1 &&
    params.failures.length === 0 &&
    params.cancelledCount === 0
  ) {
    const onlyMatch = params.matches[0];
    const filePath = path.join(params.workDir, onlyMatch.filename);
    await writeFile(filePath, onlyMatch.cleanJsonText, { encoding: 'utf8', mode: 0o600 });
    return {
      kind: 'json',
      downloadFilename: onlyMatch.filename,
      contentType: 'application/json; charset=utf-8',
      filePath,
      manifest
    };
  }

  // Otherwise build ZIP (multi-match, partial/cancelled batch, or single-match with raw/)
  const zip = new JSZip();
  zip.file('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  for (const item of params.matches) {
    zip.file(`matches/${item.filename}`, item.cleanJsonText);
    if (params.includeRaw && item.rawBody !== undefined) {
      zip.file(`raw/matches/${item.filename}`, item.rawBody);
    }
  }

  if (params.includeRaw) {
    for (const page of params.rawListPages) {
      const pageName = `raw/list/page-${String(page.pageIndex).padStart(3, '0')}.json`;
      zip.file(pageName, page.rawBody);
    }
  }

  const zipName = `cs2-matches-${formatLocalTimestampForFilename(now)}.zip`;
  const zipPath = path.join(params.workDir, zipName);
  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });
  await writeFile(zipPath, zipBuffer, { mode: 0o600 });

  return {
    kind: 'zip',
    downloadFilename: zipName,
    contentType: 'application/zip',
    filePath: zipPath,
    manifest
  };
}
