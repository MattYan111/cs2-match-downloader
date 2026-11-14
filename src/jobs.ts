import path from 'node:path';
import {
  type BuiltExportArtifact,
  buildExportArtifact,
  createMatchBaseFilename,
  type ExportedMatchEntry,
  type ExportFailureEntry,
  type ExportRawListPage,
  removeTempDirSafe
} from './export.js';
import {
  type PlayerSourceWatermark,
  type PlayersStore,
  shouldStopAtWatermark,
  STEAM_ID64_RE
} from './players-store.js';
import {
  AuthExpiredError,
  type MatchSource,
  type PerfectWorldProvider,
  ProviderRequestError,
  SOURCE_CONFIG
} from './provider/perfectworld.js';

export type JobStatus =
  | 'idle'
  | 'listing'
  | 'downloading'
  | 'paused_auth'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed';

export interface JobPublicState {
  jobId: string | null;
  status: JobStatus;
  source: MatchSource | null;
  sourceLabel: string | null;
  targetSteamId: string | null;
  includeRaw: boolean;
  requestedCount: number;
  listedCount: number;
  totalCount: number;
  succeededCount: number;
  failedCount: number;
  remainingCount: number;
  cancelledCount: number;
  message: string;
  failures: ExportFailureEntry[];
  downloadReady: boolean;
  downloadFilename: string | null;
  downloadKind: 'json' | 'zip' | null;
}

export interface StartSelectedJobParams {
  source: MatchSource;
  targetSteamId: string;
  matchIds: string[];
  includeRaw: boolean;
  rawListPages?: ExportRawListPage[];
}

export interface StartRecentJobParams {
  source: MatchSource;
  targetSteamId: string;
  recentCount: number;
  includeRaw: boolean;
}

export interface StartMultiSyncJobParams {
  steamIds: string[];
  sources: MatchSource[];
  syncMode: 'incremental' | 'full';
  includeRaw: boolean;
}

export interface JobManagerOptions {
  tempRootDir: string;
  playersStore?: PlayersStore;
  detailDelayMs?: number;
  listDelayMs?: number;
  retryBaseDelayMs?: number;
  maxDetailAttempts?: number;
  listPageSize?: number;
  maxListPages?: number;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface ScanTask {
  steamId: string;
  note: string;
  source: MatchSource;
  watermark?: PlayerSourceWatermark;
  nextPage: number;
  cursor: string | number | null;
  done: boolean;
  discoveredMatchIds: string[];
  latestCandidate: { matchId: string; startTime: string | null } | null;
}

interface ActiveJobInternal {
  jobId: string;
  workDir: string;
  mode: 'selected' | 'recent' | 'multi_sync';
  status: JobStatus;
  source: MatchSource;
  sources: MatchSource[];
  targetSteamId: string;
  targetSteamIds: string[];
  syncMode?: 'incremental' | 'full';
  includeRaw: boolean;
  requestedCount: number;
  singleMatchRequested: boolean;
  listCompleted: boolean;
  nextPage: number;
  listCursor: string | number | null;
  scanTasks: ScanTask[];
  matchSources: Map<string, MatchSource>;
  seenIds: Set<string>;
  usedFilenames: Set<string>;
  remainingIds: string[];
  succeeded: ExportedMatchEntry[];
  failures: ExportFailureEntry[];
  rawListPages: ExportRawListPage[];
  cancelledCount: number;
  message: string;
  artifact: BuiltExportArtifact | null;
  abortController: AbortController | null;
  cancelRequested: boolean;
}

export class ExportJobManager {
  private readonly provider: PerfectWorldProvider;
  private readonly playersStore?: PlayersStore;
  private readonly tempRootDir: string;
  private readonly detailDelayMs: number;
  private readonly listDelayMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxDetailAttempts: number;
  private readonly listPageSize: number;
  private readonly maxListPages: number;

  private job: ActiveJobInternal | null = null;
  private jobCounter = 0;
  private runPromise: Promise<void> | null = null;

  constructor(provider: PerfectWorldProvider, options: JobManagerOptions) {
    this.provider = provider;
    this.playersStore = options.playersStore;
    this.tempRootDir = options.tempRootDir;
    this.detailDelayMs = options.detailDelayMs ?? 600;
    this.listDelayMs = options.listDelayMs ?? 500;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1200;
    this.maxDetailAttempts = options.maxDetailAttempts ?? 3;
    this.listPageSize = options.listPageSize ?? 50;
    this.maxListPages = options.maxListPages ?? 40;
  }

  getPublicState(): JobPublicState {
    if (!this.job) {
      return {
        jobId: null,
        status: 'idle',
        source: null,
        sourceLabel: null,
        targetSteamId: null,
        includeRaw: false,
        requestedCount: 0,
        listedCount: 0,
        totalCount: 0,
        succeededCount: 0,
        failedCount: 0,
        remainingCount: 0,
        cancelledCount: 0,
        message: '尚未开始导出任务',
        failures: [],
        downloadReady: false,
        downloadFilename: null,
        downloadKind: null
      };
    }

    const totalCount =
      this.job.succeeded.length +
      this.job.failures.length +
      this.job.remainingIds.length +
      this.job.cancelledCount;

    const sourceLabel =
      this.job.sources.length > 1
        ? this.job.sources.map((s) => SOURCE_CONFIG[s].label).join(' + ')
        : SOURCE_CONFIG[this.job.source].label;
    const targetSteamIdLabel =
      this.job.targetSteamIds.length > 1
        ? `共 ${this.job.targetSteamIds.length} 人`
        : this.job.targetSteamId;

    return {
      jobId: this.job.jobId,
      status: this.job.status,
      source: this.job.source,
      sourceLabel,
      targetSteamId: targetSteamIdLabel,
      includeRaw: this.job.includeRaw,
      requestedCount: this.job.requestedCount,
      listedCount: this.job.seenIds.size,
      totalCount,
      succeededCount: this.job.succeeded.length,
      failedCount: this.job.failures.length,
      remainingCount: this.job.remainingIds.length,
      cancelledCount: this.job.cancelledCount,
      message: this.job.message,
      failures: [...this.job.failures],
      downloadReady: this.job.artifact !== null,
      downloadFilename: this.job.artifact?.downloadFilename ?? null,
      downloadKind: this.job.artifact?.kind ?? null
    };
  }

  getDownloadArtifact(): BuiltExportArtifact | null {
    return this.job?.artifact ?? null;
  }

  isRunning(): boolean {
    return this.job?.status === 'listing' || this.job?.status === 'downloading';
  }

  async startSelectedJob(params: StartSelectedJobParams): Promise<JobPublicState> {
    this.assertCanStartNewJob();
    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    for (const rawId of params.matchIds) {
      const id = String(rawId).trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        uniqueIds.push(id);
      }
    }
    if (uniqueIds.length === 0) {
      throw new Error('请至少选择一场比赛');
    }

    await this.cleanupPreviousJobWorkDir();
    this.jobCounter++;
    const jobId = `job-${this.jobCounter}`;
    const workDir = path.join(this.tempRootDir, jobId);

    const matchSources = new Map<string, MatchSource>();
    for (const id of uniqueIds) {
      matchSources.set(id, params.source);
    }

    this.job = {
      jobId,
      workDir,
      mode: 'selected',
      status: 'downloading',
      source: params.source,
      sources: [params.source],
      targetSteamId: params.targetSteamId,
      targetSteamIds: [params.targetSteamId],
      includeRaw: params.includeRaw,
      requestedCount: uniqueIds.length,
      singleMatchRequested: uniqueIds.length === 1,
      listCompleted: true,
      nextPage: 1,
      listCursor: null,
      scanTasks: [],
      matchSources,
      seenIds: seen,
      usedFilenames: new Set(),
      remainingIds: uniqueIds,
      succeeded: [],
      failures: [],
      rawListPages: params.includeRaw ? [...(params.rawListPages ?? [])] : [],
      cancelledCount: 0,
      message: `准备导出 ${uniqueIds.length} 场比赛`,
      artifact: null,
      abortController: new AbortController(),
      cancelRequested: false
    };

    this.runPromise = this.executeJob(this.job);
    return this.getPublicState();
  }

  async startRecentJob(params: StartRecentJobParams): Promise<JobPublicState> {
    this.assertCanStartNewJob();
    if (!Number.isInteger(params.recentCount) || params.recentCount < 1 || params.recentCount > 1000) {
      throw new Error('最近场数需为 1 到 1000 之间的整数');
    }

    await this.cleanupPreviousJobWorkDir();
    this.jobCounter++;
    const jobId = `job-${this.jobCounter}`;
    const workDir = path.join(this.tempRootDir, jobId);

    this.job = {
      jobId,
      workDir,
      mode: 'recent',
      status: 'listing',
      source: params.source,
      sources: [params.source],
      targetSteamId: params.targetSteamId,
      targetSteamIds: [params.targetSteamId],
      includeRaw: params.includeRaw,
      requestedCount: params.recentCount,
      singleMatchRequested: params.recentCount === 1,
      listCompleted: false,
      nextPage: 1,
      listCursor: null,
      scanTasks: [],
      matchSources: new Map(),
      seenIds: new Set(),
      usedFilenames: new Set(),
      remainingIds: [],
      succeeded: [],
      failures: [],
      rawListPages: [],
      cancelledCount: 0,
      message: `正在加载最近 ${params.recentCount} 场比赛列表`,
      artifact: null,
      abortController: new AbortController(),
      cancelRequested: false
    };

    this.runPromise = this.executeJob(this.job);
    return this.getPublicState();
  }

  async startMultiSyncJob(params: StartMultiSyncJobParams): Promise<JobPublicState> {
    this.assertCanStartNewJob();

    const uniqueSteamIds: string[] = [];
    const seenPlayers = new Set<string>();
    for (const rawId of params.steamIds) {
      const id = String(rawId).trim();
      if (!STEAM_ID64_RE.test(id)) {
        throw new Error(`无效的 SteamID64（需为 17 位数字）：${id}`);
      }
      if (!seenPlayers.has(id)) {
        seenPlayers.add(id);
        uniqueSteamIds.push(id);
      }
    }
    if (uniqueSteamIds.length === 0) {
      throw new Error('请至少选择一个目标玩家');
    }

    const uniqueSources: MatchSource[] = [];
    for (const src of params.sources) {
      if ((src === 'official' || src === 'perfectworld') && !uniqueSources.includes(src)) {
        uniqueSources.push(src);
      }
    }
    if (uniqueSources.length === 0) {
      throw new Error('请至少选择一个比赛来源');
    }

    const savedProfiles = this.playersStore ? await this.playersStore.getAll() : [];
    const profileMap = new Map(savedProfiles.map((p) => [p.steamId, p]));

    const scanTasks: ScanTask[] = [];
    for (const steamId of uniqueSteamIds) {
      const profile = profileMap.get(steamId);
      const note = profile?.note || steamId.slice(-6);
      for (const source of uniqueSources) {
        const watermark =
          params.syncMode === 'incremental' ? profile?.watermarks[source] : undefined;
        scanTasks.push({
          steamId,
          note,
          source,
          watermark,
          nextPage: 1,
          cursor: null,
          done: false,
          discoveredMatchIds: [],
          latestCandidate: null
        });
      }
    }

    await this.cleanupPreviousJobWorkDir();
    this.jobCounter++;
    const jobId = `job-${this.jobCounter}`;
    const workDir = path.join(this.tempRootDir, jobId);

    this.job = {
      jobId,
      workDir,
      mode: 'multi_sync',
      status: 'listing',
      source: uniqueSources[0],
      sources: uniqueSources,
      targetSteamId: uniqueSteamIds[0],
      targetSteamIds: uniqueSteamIds,
      syncMode: params.syncMode,
      includeRaw: params.includeRaw,
      requestedCount: 0,
      singleMatchRequested: false,
      listCompleted: false,
      nextPage: 1,
      listCursor: null,
      scanTasks,
      matchSources: new Map(),
      seenIds: new Set(),
      usedFilenames: new Set(),
      remainingIds: [],
      succeeded: [],
      failures: [],
      rawListPages: [],
      cancelledCount: 0,
      message: `正在准备扫描 ${uniqueSteamIds.length} 位玩家的比赛记录`,
      artifact: null,
      abortController: new AbortController(),
      cancelRequested: false
    };

    this.runPromise = this.executeJob(this.job);
    return this.getPublicState();
  }

  async resumePausedJob(): Promise<JobPublicState> {
    if (!this.job) {
      throw new Error('当前没有可继续的任务');
    }
    if (this.job.status !== 'paused_auth') {
      throw new Error('只有因登录过期暂停的任务可以继续');
    }
    if (!this.provider.isAuthenticated()) {
      throw new Error('请先重新扫码登录');
    }

    this.job.cancelRequested = false;
    this.job.abortController = new AbortController();
    this.job.artifact = null;
    this.job.status = this.job.listCompleted ? 'downloading' : 'listing';
    this.job.message = '已重新登录，正在继续未完成任务';
    this.runPromise = this.executeJob(this.job);
    return this.getPublicState();
  }

  async retryFailedItems(): Promise<JobPublicState> {
    if (!this.job) {
      throw new Error('当前没有任务');
    }
    if (this.isRunning()) {
      throw new Error('任务仍在运行中，请等待完成或先取消');
    }
    if (this.job.failures.length === 0) {
      throw new Error('当前没有失败的比赛可重试');
    }
    if (!this.provider.isAuthenticated()) {
      throw new Error('请先扫码登录');
    }

    const retryIds = this.job.failures.map((f) => f.matchId);
    this.job.failures = [];
    this.job.remainingIds = [...this.job.remainingIds, ...retryIds];
    this.job.cancelledCount = 0;
    this.job.cancelRequested = false;
    this.job.abortController = new AbortController();
    this.job.artifact = null;
    this.job.status = 'downloading';
    this.job.message = `正在重试 ${retryIds.length} 场失败比赛`;

    this.runPromise = this.executeJob(this.job);
    return this.getPublicState();
  }

  async cancelCurrentJob(): Promise<JobPublicState> {
    if (!this.job) return this.getPublicState();
    if (!this.isRunning()) return this.getPublicState();

    this.job.cancelRequested = true;
    this.job.message = '正在取消任务并整理已完成结果...';
    this.job.abortController?.abort();

    if (this.runPromise) {
      await this.runPromise;
    }
    return this.getPublicState();
  }

  async waitForCurrentRun(): Promise<void> {
    if (this.runPromise) {
      await this.runPromise;
    }
  }

  async shutdown(): Promise<void> {
    await this.cancelCurrentJob();
    await this.cleanupPreviousJobWorkDir();
    this.job = null;
  }

  private assertCanStartNewJob(): void {
    if (this.isRunning()) {
      throw new Error('已有导出任务正在进行，请等待完成或先取消');
    }
    if (!this.provider.isAuthenticated()) {
      throw new Error('请先扫码登录');
    }
  }

  private async cleanupPreviousJobWorkDir(): Promise<void> {
    if (this.job) {
      await removeTempDirSafe(this.job.workDir);
    }
  }

  private async executeJob(job: ActiveJobInternal): Promise<void> {
    const signal = job.abortController?.signal ?? new AbortController().signal;

    try {
      // Phase 1: list pagination
      if (job.mode === 'multi_sync') {
        for (const task of job.scanTasks) {
          if (task.done) continue;
          const sourceLabel = SOURCE_CONFIG[task.source].label;
          const taskSeen = new Set<string>(task.discoveredMatchIds);

          while (!task.done && task.nextPage <= this.maxListPages) {
            if (job.cancelRequested || signal.aborted) {
              await this.finalizeCancelled(job);
              return;
            }

            job.status = 'listing';
            job.message = `正在扫描 ${task.note} 的${sourceLabel}第 ${task.nextPage} 页（已收集 ${job.seenIds.size} 场唯一比赛）`;

            const pageResult = await this.provider.fetchMatchListPage({
              source: task.source,
              targetSteamId: task.steamId,
              page: task.nextPage,
              pageSize: this.listPageSize,
              cursor: task.cursor,
              signal
            });

            if (job.includeRaw) {
              job.rawListPages.push({
                pageIndex: task.nextPage,
                prefix: `${task.source}-${task.steamId}`,
                rawBody: pageResult.rawBody
              });
            }

            let addedToTask = 0;
            let hitWatermark = false;
            for (const item of pageResult.matches) {
              if (task.watermark && shouldStopAtWatermark(item, task.watermark)) {
                hitWatermark = true;
                break;
              }
              if (!task.latestCandidate) {
                task.latestCandidate = {
                  matchId: item.matchId,
                  startTime: item.startTime ?? item.endTime ?? null
                };
              }
              if (!taskSeen.has(item.matchId)) {
                taskSeen.add(item.matchId);
                task.discoveredMatchIds.push(item.matchId);
                addedToTask++;
              }
              if (!job.seenIds.has(item.matchId)) {
                job.seenIds.add(item.matchId);
                job.matchSources.set(item.matchId, task.source);
                job.remainingIds.push(item.matchId);
              }
            }

            const nextCursor = pageResult.nextCursor;
            const cursorStuck =
              addedToTask === 0 && (nextCursor === null || nextCursor === task.cursor);
            if (hitWatermark || pageResult.matches.length === 0 || cursorStuck) {
              task.done = true;
              break;
            }

            task.cursor = nextCursor;
            task.nextPage++;
            await sleepAbortable(this.listDelayMs, signal);
          }

          if (task.nextPage > this.maxListPages) {
            task.done = true;
          }
        }
        job.listCompleted = true;
      } else {
        while (!job.listCompleted) {
          if (job.cancelRequested || signal.aborted) {
            await this.finalizeCancelled(job);
            return;
          }
          if (job.seenIds.size >= job.requestedCount || job.nextPage > this.maxListPages) {
            job.listCompleted = true;
            break;
          }

          job.status = 'listing';
          job.message = `正在读取比赛列表第 ${job.nextPage} 页（已收集 ${job.seenIds.size}/${job.requestedCount} 场）`;

          const pageResult = await this.provider.fetchMatchListPage({
            source: job.source,
            targetSteamId: job.targetSteamId,
            page: job.nextPage,
            pageSize: this.listPageSize,
            cursor: job.listCursor,
            signal
          });

          if (job.includeRaw) {
            job.rawListPages.push({
              pageIndex: job.nextPage,
              rawBody: pageResult.rawBody
            });
          }

          let addedOnPage = 0;
          for (const item of pageResult.matches) {
            if (!job.seenIds.has(item.matchId)) {
              job.seenIds.add(item.matchId);
              job.matchSources.set(item.matchId, job.source);
              job.remainingIds.push(item.matchId);
              addedOnPage++;
              if (job.seenIds.size >= job.requestedCount) {
                break;
              }
            }
          }

          const nextCursor = pageResult.nextCursor;
          const cursorStuck =
            addedOnPage === 0 && (nextCursor === null || nextCursor === job.listCursor);
          if (
            pageResult.matches.length === 0 ||
            cursorStuck ||
            job.seenIds.size >= job.requestedCount
          ) {
            job.listCompleted = true;
            break;
          }

          job.listCursor = nextCursor;
          job.nextPage++;
          await sleepAbortable(this.listDelayMs, signal);
        }
      }

      if (job.cancelRequested || signal.aborted) {
        await this.finalizeCancelled(job);
        return;
      }

      if (job.remainingIds.length === 0 && job.succeeded.length === 0 && job.failures.length === 0) {
        job.status = 'completed';
        job.message =
          job.mode === 'multi_sync'
            ? '已完成扫描：所有选中玩家均无新增比赛'
            : '未查询到符合条件的比赛记录';
        return;
      }

      // Phase 2: fetch each match detail sequentially
      job.status = 'downloading';
      while (job.remainingIds.length > 0) {
        if (job.cancelRequested || signal.aborted) {
          await this.finalizeCancelled(job);
          return;
        }

        const matchId = job.remainingIds[0];
        const itemSource = job.matchSources.get(matchId) ?? job.source;
        const total = job.succeeded.length + job.failures.length + job.remainingIds.length;
        const processed = job.succeeded.length + job.failures.length + 1;
        job.message = `正在下载比赛详情 ${processed}/${total}（成功 ${job.succeeded.length}，失败 ${job.failures.length}）`;

        try {
          const detail = await this.fetchDetailWithRetry(itemSource, matchId, signal);
          const filename = createMatchBaseFilename(itemSource, matchId, job.usedFilenames);
          job.succeeded.push({
            matchId: detail.matchId,
            source: itemSource,
            filename,
            cleanJsonText: detail.cleanJsonText,
            ...(job.includeRaw ? { rawBody: detail.rawBody } : {})
          });
          job.remainingIds.shift();
        } catch (error) {
          if (error instanceof AuthExpiredError) {
            job.status = 'paused_auth';
            job.message = '登录已过期，任务已暂停。请重新扫码登录后点击继续任务';
            await this.tryBuildPartialArtifact(job);
            return;
          }
          if (job.cancelRequested || signal.aborted) {
            await this.finalizeCancelled(job);
            return;
          }
          const reason = error instanceof Error ? error.message : '详情获取失败';
          job.failures.push({ matchId, reason });
          job.remainingIds.shift();
        }

        if (job.remainingIds.length > 0 && !job.cancelRequested && !signal.aborted) {
          await sleepAbortable(this.detailDelayMs, signal);
        }
      }

      await this.finalizeDone(job);
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        job.status = 'paused_auth';
        job.message = '登录已过期，任务已暂停。请重新扫码登录后点击继续任务';
        await this.tryBuildPartialArtifact(job);
        return;
      }
      if (job.cancelRequested || signal.aborted) {
        await this.finalizeCancelled(job);
        return;
      }
      job.status = job.succeeded.length > 0 ? 'partial' : 'failed';
      job.message = error instanceof Error ? error.message : '导出任务失败';
      await this.tryBuildPartialArtifact(job);
    }
  }

  private async fetchDetailWithRetry(
    source: MatchSource,
    matchId: string,
    signal: AbortSignal
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxDetailAttempts; attempt++) {
      try {
        return await this.provider.fetchMatchDetail({ source, matchId, signal });
      } catch (error) {
        lastError = error;
        if (error instanceof AuthExpiredError || signal.aborted) {
          throw error;
        }
        const retryable = error instanceof ProviderRequestError && error.retryable;
        if (!retryable || attempt >= this.maxDetailAttempts) {
          throw error;
        }
        await sleepAbortable(this.retryBaseDelayMs * attempt, signal);
      }
    }
    throw lastError;
  }

  private async tryBuildPartialArtifact(job: ActiveJobInternal): Promise<void> {
    if (job.succeeded.length === 0) {
      job.artifact = null;
      return;
    }
    job.artifact = await buildExportArtifact({
      workDir: job.workDir,
      source: job.source,
      sources: job.sources,
      targetSteamId: job.targetSteamId,
      targetSteamIds: job.targetSteamIds,
      includeRaw: job.includeRaw,
      singleMatchRequested: job.singleMatchRequested,
      requestedCount: job.mode === 'multi_sync' ? job.seenIds.size : job.requestedCount,
      actualCount: job.seenIds.size,
      cancelledCount: job.cancelledCount,
      matches: job.succeeded,
      rawListPages: job.rawListPages,
      failures: job.failures
    });
  }

  private async advanceCompletedWatermarks(job: ActiveJobInternal): Promise<void> {
    if (job.mode !== 'multi_sync' || !this.playersStore || job.remainingIds.length > 0) {
      return;
    }
    const succeededSet = new Set(job.succeeded.map((item) => item.matchId));
    const failedSet = new Set(job.failures.map((item) => item.matchId));

    for (const task of job.scanTasks) {
      if (!task.done || !task.latestCandidate || task.discoveredMatchIds.length === 0) {
        continue;
      }
      const allSucceeded = task.discoveredMatchIds.every(
        (id) => succeededSet.has(id) && !failedSet.has(id)
      );
      if (allSucceeded) {
        await this.playersStore.advanceWatermark(task.steamId, task.source, task.latestCandidate);
      }
    }
  }

  private async finalizeCancelled(job: ActiveJobInternal): Promise<void> {
    job.cancelledCount += job.remainingIds.length;
    job.remainingIds = [];
    job.status = 'cancelled';
    await this.tryBuildPartialArtifact(job);
    if (job.succeeded.length > 0) {
      job.message = `任务已取消，已保留 ${job.succeeded.length} 场成功结果可下载`;
    } else {
      job.message = '任务已取消，没有可下载的比赛结果';
    }
  }

  private async finalizeDone(job: ActiveJobInternal): Promise<void> {
    await this.tryBuildPartialArtifact(job);
    await this.advanceCompletedWatermarks(job);
    const totalAvailable = job.seenIds.size;
    const shortageNote =
      job.mode === 'recent' && totalAvailable < job.requestedCount
        ? `（接口实际仅返回 ${totalAvailable} 场）`
        : '';

    if (job.failures.length === 0 && job.succeeded.length > 0) {
      job.status = 'completed';
      job.message = `导出完成：共 ${job.succeeded.length} 场${shortageNote}`;
    } else if (job.succeeded.length > 0) {
      job.status = 'partial';
      job.message = `部分完成：成功 ${job.succeeded.length} 场，失败 ${job.failures.length} 场${shortageNote}`;
    } else {
      job.status = 'failed';
      job.message = `导出失败：${job.failures.length} 场均未能获取详情${shortageNote}`;
    }
  }
}
