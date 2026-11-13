import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  createTempExportRoot,
  type ExportRawListPage,
  removeTempDirSafe
} from './export.js';
import { ExportJobManager } from './jobs.js';
import {
  AuthExpiredError,
  type MatchSource,
  PerfectWorldProvider,
  ProviderRequestError
} from './provider/perfectworld.js';

export interface AppServerOptions {
  provider?: PerfectWorldProvider;
  tempRootDir?: string;
  uiDistDir?: string;
  devMode?: boolean;
  detailDelayMs?: number;
  listDelayMs?: number;
  retryBaseDelayMs?: number;
  onExitRequested?: () => void;
}

interface ListCache {
  key: string;
  rawPages: ExportRawListPage[];
}

function isValidSource(value: unknown): value is MatchSource {
  return value === 'official' || value === 'perfectworld';
}

function isAllowedDevOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // User can still copy the printed URL from terminal
  }
}

export function createDownloaderApp(options: AppServerOptions & { getBoundPort: () => number }) {
  const provider = options.provider ?? new PerfectWorldProvider();
  const tempRootDir = options.tempRootDir ?? '';
  const jobManager = new ExportJobManager(provider, {
    tempRootDir,
    detailDelayMs: options.detailDelayMs,
    listDelayMs: options.listDelayMs,
    retryBaseDelayMs: options.retryBaseDelayMs
  });

  const devMode = options.devMode ?? process.env.PW_DEV_MODE === '1';
  let listCache: ListCache = { key: '', rawPages: [] };

  const app = express();
  app.disable('x-powered-by');

  // Strict local host & origin protection
  app.use((req: Request, res: Response, next: NextFunction) => {
    const port = options.getBoundPort();
    const host = req.headers.host;
    if (port > 0) {
      if (devMode) {
        if (!host || !/^127\.0\.0\.1:\d+$|^localhost:\d+$/.test(host)) {
          res.status(403).json({ error: '禁止非本机 Host 访问' });
          return;
        }
      } else if (host !== `127.0.0.1:${port}`) {
        res.status(403).json({ error: '禁止非本机 Host 访问' });
        return;
      }
    }

    const secFetchSite = req.headers['sec-fetch-site'];
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      res.status(403).json({ error: '禁止跨站请求' });
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      const expectedOrigin = `http://127.0.0.1:${port}`;
      const allowed = devMode ? isAllowedDevOrigin(origin) : origin === expectedOrigin;
      if (!allowed) {
        res.status(403).json({ error: '禁止跨源请求' });
        return;
      }
    }

    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (req.headers['x-pw-client'] !== '1') {
          res.status(403).json({ error: '缺少客户端请求标记' });
          return;
        }
      }
    }

    next();
  });

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/auth/state', async (_req: Request, res: Response) => {
    const state = await provider.pollQrStatus();
    res.json(state);
  });

  app.post('/api/auth/qr', async (_req: Request, res: Response) => {
    try {
      const state = await provider.createQrCode();
      res.json(state);
    } catch (error) {
      res.status(502).json({
        error: error instanceof Error ? error.message : '申请二维码失败',
        auth: provider.getPublicAuthState()
      });
    }
  });

  app.get('/api/auth/qr.png', (_req: Request, res: Response) => {
    const png = provider.getQrImagePng();
    if (!png || png.length === 0) {
      res.status(404).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  });

  app.post('/api/auth/logout', async (_req: Request, res: Response) => {
    if (jobManager.isRunning()) {
      await jobManager.cancelCurrentJob();
    }
    provider.logout();
    listCache = { key: '', rawPages: [] };
    res.json(provider.getPublicAuthState());
  });

  app.post('/api/matches/list', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = body.source;
    if (!isValidSource(source)) {
      res.status(400).json({ error: '无效的比赛来源，仅支持 official 或 perfectworld' });
      return;
    }

    const authSteamId = provider.getAuthenticatedSteamId();
    if (!authSteamId) {
      res.status(401).json({
        error: '请先扫码登录',
        authExpired: true,
        auth: provider.getPublicAuthState()
      });
      return;
    }

    const targetSteamId =
      typeof body.targetSteamId === 'string' && body.targetSteamId.trim()
        ? body.targetSteamId.trim()
        : authSteamId;
    const page = typeof body.page === 'number' && Number.isInteger(body.page) && body.page >= 1 ? body.page : 1;
    const pageSize =
      typeof body.pageSize === 'number' && Number.isInteger(body.pageSize) && body.pageSize >= 1 && body.pageSize <= 100
        ? body.pageSize
        : 20;
    const cursor =
      typeof body.cursor === 'string' || typeof body.cursor === 'number' ? body.cursor : null;
    const reset = body.reset === true || page === 1;

    try {
      const result = await provider.fetchMatchListPage({
        source,
        targetSteamId,
        page,
        pageSize,
        cursor
      });

      const cacheKey = `${source}:${targetSteamId}`;
      if (reset || listCache.key !== cacheKey) {
        listCache = { key: cacheKey, rawPages: [{ pageIndex: page, rawBody: result.rawBody }] };
      } else {
        listCache.rawPages.push({ pageIndex: page, rawBody: result.rawBody });
      }

      res.json({
        source,
        targetSteamId,
        page,
        matches: result.matches,
        nextCursor: result.nextCursor,
        hasMore: result.hasMore
      });
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        res.status(401).json({
          error: error.message,
          authExpired: true,
          auth: provider.getPublicAuthState()
        });
        return;
      }
      const status = error instanceof ProviderRequestError ? 400 : 500;
      res.status(status).json({
        error: error instanceof Error ? error.message : '加载比赛列表失败'
      });
    }
  });

  app.get('/api/jobs/state', (_req: Request, res: Response) => {
    res.json(jobManager.getPublicState());
  });

  app.post('/api/jobs/export-selected', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = body.source;
    if (!isValidSource(source)) {
      res.status(400).json({ error: '无效的比赛来源' });
      return;
    }

    const authSteamId = provider.getAuthenticatedSteamId();
    if (!authSteamId) {
      res.status(401).json({ error: '请先扫码登录', authExpired: true });
      return;
    }

    const targetSteamId =
      typeof body.targetSteamId === 'string' && body.targetSteamId.trim()
        ? body.targetSteamId.trim()
        : authSteamId;
    if (!/^\d{17}$/.test(targetSteamId)) {
      res.status(400).json({ error: '目标玩家 SteamID64 必须为 17 位数字' });
      return;
    }

    const matchIds = Array.isArray(body.matchIds)
      ? body.matchIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    const includeRaw = body.includeRaw === true;
    const cacheKey = `${source}:${targetSteamId}`;
    const rawListPages = includeRaw && listCache.key === cacheKey ? listCache.rawPages : [];

    try {
      const state = await jobManager.startSelectedJob({
        source,
        targetSteamId,
        matchIds,
        includeRaw,
        rawListPages
      });
      res.json(state);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '启动导出失败' });
    }
  });

  app.post('/api/jobs/export-recent', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = body.source;
    if (!isValidSource(source)) {
      res.status(400).json({ error: '无效的比赛来源' });
      return;
    }

    const authSteamId = provider.getAuthenticatedSteamId();
    if (!authSteamId) {
      res.status(401).json({ error: '请先扫码登录', authExpired: true });
      return;
    }

    const targetSteamId =
      typeof body.targetSteamId === 'string' && body.targetSteamId.trim()
        ? body.targetSteamId.trim()
        : authSteamId;
    if (!/^\d{17}$/.test(targetSteamId)) {
      res.status(400).json({ error: '目标玩家 SteamID64 必须为 17 位数字' });
      return;
    }

    const recentCount = Number(body.recentCount);
    const includeRaw = body.includeRaw === true;

    try {
      const state = await jobManager.startRecentJob({
        source,
        targetSteamId,
        recentCount,
        includeRaw
      });
      res.json(state);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '启动最近 N 场导出失败' });
    }
  });

  app.post('/api/jobs/resume', async (_req: Request, res: Response) => {
    try {
      const state = await jobManager.resumePausedJob();
      res.json(state);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '继续任务失败' });
    }
  });

  app.post('/api/jobs/retry-failed', async (_req: Request, res: Response) => {
    try {
      const state = await jobManager.retryFailedItems();
      res.json(state);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '重试失败项失败' });
    }
  });

  app.post('/api/jobs/cancel', async (_req: Request, res: Response) => {
    const state = await jobManager.cancelCurrentJob();
    res.json(state);
  });

  app.get('/api/jobs/download', (_req: Request, res: Response) => {
    const artifact = jobManager.getDownloadArtifact();
    if (!artifact || !fs.existsSync(artifact.filePath)) {
      res.status(404).json({ error: '当前没有可下载的导出文件' });
      return;
    }
    res.setHeader('Content-Type', artifact.contentType);
    res.download(artifact.filePath, artifact.downloadFilename);
  });

  app.post('/api/system/exit', async (_req: Request, res: Response) => {
    provider.logout();
    listCache = { key: '', rawPages: [] };
    await jobManager.shutdown();
    if (tempRootDir) {
      await removeTempDirSafe(tempRootDir);
    }
    res.json({ ok: true, message: '工具已退出，可关闭此页面' });
    options.onExitRequested?.();
  });

  // Serve built UI in production
  const defaultUiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui');
  const uiDir = options.uiDistDir ?? defaultUiDir;
  if (fs.existsSync(uiDir)) {
    app.use(express.static(uiDir));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(path.join(uiDir, 'index.html'));
    });
  }

  return { app, jobManager, provider };
}

export async function startDownloaderServer(
  options: AppServerOptions & { port?: number; open?: boolean } = {}
): Promise<{
  server: http.Server;
  port: number;
  url: string;
  jobManager: ExportJobManager;
  provider: PerfectWorldProvider;
  close: () => Promise<void>;
}> {
  const tempRootDir = options.tempRootDir ?? (await createTempExportRoot());
  let boundPort = 0;
  let server: http.Server | null = null;
  let closed = false;

  const closeAll = async () => {
    if (closed) return;
    closed = true;
    await jobManager.shutdown();
    await removeTempDirSafe(tempRootDir);
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
    }
  };

  const { app, jobManager, provider } = createDownloaderApp({
    ...options,
    tempRootDir,
    getBoundPort: () => boundPort,
    onExitRequested: () => {
      if (options.onExitRequested) {
        options.onExitRequested();
        return;
      }
      setTimeout(async () => {
        await closeAll();
        process.exit(0);
      }, 150);
    }
  });

  const requestedPort = options.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);

  await new Promise<void>((resolve, reject) => {
    const s = app.listen(requestedPort, '127.0.0.1', () => {
      const addr = s.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('无法获取本地监听端口'));
        return;
      }
      boundPort = addr.port;
      server = s;
      resolve();
    });
    s.on('error', reject);
  });

  const url = `http://127.0.0.1:${boundPort}`;
  if (options.open) {
    openBrowser(url);
  }

  return {
    server: server!,
    port: boundPort,
    url,
    jobManager,
    provider,
    close: closeAll
  };
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  const shouldOpen = process.argv.includes('--open');
  const portEnv = process.env.PW_PORT ? Number(process.env.PW_PORT) : 0;
  startDownloaderServer({ port: portEnv, open: shouldOpen })
    .then(({ url }) => {
      console.log(`CS2 比赛数据下载器已启动：${url}`);
      console.log('如需退出请点击页面右上角“退出工具”按钮，或在此终端按 Ctrl+C。');
    })
    .catch((error) => {
      console.error('启动失败：', error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
