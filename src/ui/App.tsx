import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthPublicState,
  JobPublicState,
  MatchSource,
  MatchSummary,
  SavedPlayerProfile
} from './types';

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-PW-Client': '1'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || `请求失败（HTTP ${res.status}）`) as Error & {
      authExpired?: boolean;
    };
    err.authExpired = Boolean((data as { authExpired?: boolean }).authExpired);
    throw err;
  }
  return data as T;
}

const MAP_NAME_DISPLAY: Record<string, string> = {
  炙热沙城Ⅱ: 'Dust2（炙热沙城Ⅱ）',
  de_dust2: 'Dust2',
  荒漠迷城: 'Mirage（荒漠迷城）',
  de_mirage: 'Mirage',
  炼狱小镇: 'Inferno（炼狱小镇）',
  de_inferno: 'Inferno',
  核子危机: 'Nuke（核子危机）',
  de_nuke: 'Nuke',
  死亡游乐园: 'Overpass（死亡游乐园）',
  de_overpass: 'Overpass',
  远古遗迹: 'Ancient（远古遗迹）',
  de_ancient: 'Ancient',
  阿努比斯: 'Anubis（阿努比斯）',
  de_anubis: 'Anubis',
  殒命大厦: 'Vertigo（殒命大厦）',
  de_vertigo: 'Vertigo',
  列车停放站: 'Train（列车停放站）',
  de_train: 'Train'
};

function formatMapLabel(raw: string | null): string {
  if (!raw) return '—';
  return MAP_NAME_DISPLAY[raw] ?? raw;
}

function formatTimeShort(raw: string | null): string {
  if (!raw) return '—';
  return raw.replace(/:\d{2}$/, '');
}

const INITIAL_AUTH: AuthPublicState = {
  authenticated: false,
  user: null,
  qr: {
    status: 'none',
    message: '正在初始化登录状态...',
    qrHost: null,
    createdAt: null,
    expiresAt: null,
    hasQrImage: false
  }
};

const INITIAL_JOB: JobPublicState = {
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

const JOB_STATUS_LABELS: Record<JobPublicState['status'], string> = {
  idle: '待命',
  listing: '读取列表中',
  downloading: '下载详情中',
  paused_auth: '登录过期已暂停',
  completed: '已完成',
  partial: '部分完成',
  cancelled: '已取消',
  failed: '失败'
};

export function App() {
  const [auth, setAuth] = useState<AuthPublicState>(INITIAL_AUTH);
  const [qrVersion, setQrVersion] = useState(0);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [playerMode, setPlayerMode] = useState<'self' | 'custom'>('self');
  const [customSteamId, setCustomSteamId] = useState('');
  const [source, setSource] = useState<MatchSource>('official');

  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | number | null>(null);
  const [nextPage, setNextPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [listLoadedOnce, setListLoadedOnce] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [includeRaw, setIncludeRaw] = useState(false);
  const [customRecentN, setCustomRecentN] = useState('20');

  const [job, setJob] = useState<JobPublicState>(INITIAL_JOB);
  const [jobError, setJobError] = useState<string | null>(null);
  const [exited, setExited] = useState(false);

  const [workMode, setWorkMode] = useState<'single' | 'multi'>('single');
  const workModeTouchedRef = useRef(false);
  const [savedPlayers, setSavedPlayers] = useState<SavedPlayerProfile[]>([]);
  const [storePath, setStorePath] = useState<string>('');
  const [playersBusy, setPlayersBusy] = useState(false);
  const [playersError, setPlayersError] = useState<string | null>(null);
  const [newSteamId, setNewSteamId] = useState('');
  const [newNote, setNewNote] = useState('');
  const [showBulkPaste, setShowBulkPaste] = useState(false);
  const [bulkPasteText, setBulkPasteText] = useState('');
  const [multiSources, setMultiSources] = useState<{ official: boolean; perfectworld: boolean }>({
    official: true,
    perfectworld: true
  });
  const [syncMode, setSyncMode] = useState<'incremental' | 'full'>('incremental');

  const qrAutoRequestedRef = useRef(false);
  const prevJobStatusRef = useRef<JobPublicState['status']>('idle');

  const activeTargetSteamId = useMemo(() => {
    if (playerMode === 'self') return auth.user?.steamId ?? '';
    return customSteamId.trim();
  }, [playerMode, auth.user?.steamId, customSteamId]);

  const refreshQr = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const state = await apiPost<AuthPublicState>('/api/auth/qr');
      setAuth(state);
      setQrVersion((v) => v + 1);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '申请二维码失败');
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const fetchAuthState = useCallback(async () => {
    try {
      const state = await apiGet<AuthPublicState>('/api/auth/state');
      setAuth(state);
      if (!state.authenticated && state.qr.status === 'none' && !qrAutoRequestedRef.current) {
        qrAutoRequestedRef.current = true;
        void refreshQr();
      }
    } catch {
      // Ignore transient poll failure if server exited
    }
  }, [refreshQr]);

  const fetchSavedPlayers = useCallback(async () => {
    try {
      const res = await apiGet<{ players: SavedPlayerProfile[]; storePath?: string }>('/api/players');
      setSavedPlayers(res.players);
      if (res.storePath) setStorePath(res.storePath);
      if (!workModeTouchedRef.current && res.players.length > 0) {
        setWorkMode('multi');
      }
    } catch {
      // Ignore transient error on exit
    }
  }, []);

  const fetchJobState = useCallback(async () => {
    try {
      const state = await apiGet<JobPublicState>('/api/jobs/state');
      const prevStatus = prevJobStatusRef.current;
      prevJobStatusRef.current = state.status;
      setJob(state);
      if (state.status === 'paused_auth') {
        void fetchAuthState();
      }
      if (
        prevStatus !== state.status &&
        (state.status === 'completed' || state.status === 'partial')
      ) {
        void fetchSavedPlayers();
      }
    } catch {
      // Ignore poll errors
    }
  }, [fetchAuthState, fetchSavedPlayers]);

  useEffect(() => {
    if (exited) return;
    void fetchAuthState();
    void fetchJobState();
    void fetchSavedPlayers();
  }, [exited, fetchAuthState, fetchJobState, fetchSavedPlayers]);

  useEffect(() => {
    if (exited) return;
    const shouldPollQr =
      !auth.authenticated && (auth.qr.status === 'waiting' || auth.qr.status === 'scanned');
    if (!shouldPollQr) return;

    const timer = window.setInterval(() => {
      void fetchAuthState();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [exited, auth.authenticated, auth.qr.status, fetchAuthState]);

  useEffect(() => {
    if (exited) return;
    const running = job.status === 'listing' || job.status === 'downloading';
    if (!running) return;

    const timer = window.setInterval(() => {
      void fetchJobState();
    }, 650);
    return () => window.clearInterval(timer);
  }, [exited, job.status, fetchJobState]);

  const handleLogout = async () => {
    setAuthError(null);
    try {
      const state = await apiPost<AuthPublicState>('/api/auth/logout');
      setAuth(state);
      setMatches([]);
      setSelectedIds(new Set());
      setListLoadedOnce(false);
      qrAutoRequestedRef.current = false;
      void refreshQr();
      void fetchJobState();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '退出登录失败');
    }
  };

  const resetListView = () => {
    setMatches([]);
    setNextCursor(null);
    setNextPage(1);
    setHasMore(false);
    setListLoadedOnce(false);
    setSelectedIds(new Set());
    setListError(null);
  };

  const loadMatchPage = async (reset: boolean) => {
    if (!auth.authenticated) {
      setListError('请先扫码登录');
      return;
    }
    if (playerMode === 'custom' && !/^\d{17}$/.test(customSteamId.trim())) {
      setListError('请输入 17 位 SteamID64');
      return;
    }

    setListLoading(true);
    setListError(null);

    const pageToFetch = reset ? 1 : nextPage;
    const cursorToSend = reset ? null : nextCursor;

    try {
      const res = await apiPost<{
        matches: MatchSummary[];
        nextCursor: string | number | null;
        hasMore: boolean;
      }>('/api/matches/list', {
        source,
        targetSteamId: activeTargetSteamId,
        page: pageToFetch,
        pageSize: 20,
        cursor: cursorToSend,
        reset
      });

      setMatches((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((m) => m.matchId));
        const merged = [...base];
        for (const item of res.matches) {
          if (!seen.has(item.matchId)) {
            seen.add(item.matchId);
            merged.push(item);
          }
        }
        return merged;
      });
      if (reset) {
        setSelectedIds(new Set());
      }
      setNextCursor(res.nextCursor);
      setNextPage(pageToFetch + 1);
      setHasMore(res.hasMore);
      setListLoadedOnce(true);
    } catch (error) {
      const err = error as Error & { authExpired?: boolean };
      setListError(err.message);
      if (err.authExpired) {
        void fetchAuthState();
      }
    } finally {
      setListLoading(false);
    }
  };

  const toggleSelectAllLoaded = () => {
    if (matches.length === 0) return;
    if (selectedIds.size === matches.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(matches.map((m) => m.matchId)));
    }
  };

  const toggleOneMatch = (matchId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(matchId)) next.delete(matchId);
      else next.add(matchId);
      return next;
    });
  };

  const startSelectedExport = async (ids: string[]) => {
    if (!auth.authenticated) {
      setJobError('请先扫码登录');
      return;
    }
    if (playerMode === 'custom' && !/^\d{17}$/.test(customSteamId.trim())) {
      setJobError('请输入 17 位 SteamID64');
      return;
    }
    setJobError(null);
    try {
      const state = await apiPost<JobPublicState>('/api/jobs/export-selected', {
        source,
        targetSteamId: activeTargetSteamId,
        matchIds: ids,
        includeRaw
      });
      setJob(state);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : '启动导出失败');
    }
  };

  const startRecentExport = async (count: number) => {
    if (!auth.authenticated) {
      setJobError('请先扫码登录');
      return;
    }
    if (playerMode === 'custom' && !/^\d{17}$/.test(customSteamId.trim())) {
      setJobError('请输入 17 位 SteamID64');
      return;
    }
    if (!Number.isInteger(count) || count < 1 || count > 1000) {
      setJobError('最近场数需为 1 到 1000 之间的整数');
      return;
    }
    setJobError(null);
    try {
      const state = await apiPost<JobPublicState>('/api/jobs/export-recent', {
        source,
        targetSteamId: activeTargetSteamId,
        recentCount: count,
        includeRaw
      });
      setJob(state);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : '启动导出失败');
    }
  };

  const handleResumeJob = async () => {
    setJobError(null);
    try {
      const state = await apiPost<JobPublicState>('/api/jobs/resume');
      prevJobStatusRef.current = state.status;
      setJob(state);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : '继续任务失败');
    }
  };

  const handleRetryFailed = async () => {
    setJobError(null);
    try {
      const state = await apiPost<JobPublicState>('/api/jobs/retry-failed');
      prevJobStatusRef.current = state.status;
      setJob(state);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : '重试失败');
    }
  };

  const handleCancelJob = async () => {
    setJobError(null);
    try {
      const state = await apiPost<JobPublicState>('/api/jobs/cancel');
      prevJobStatusRef.current = state.status;
      setJob(state);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : '取消失败');
    }
  };

  const handleAddSinglePlayer = async () => {
    setPlayersError(null);
    setPlayersBusy(true);
    try {
      const res = await apiPost<{ players: SavedPlayerProfile[] }>('/api/players/add', {
        steamId: newSteamId.trim(),
        note: newNote.trim()
      });
      setSavedPlayers(res.players);
      setNewSteamId('');
      setNewNote('');
    } catch (error) {
      setPlayersError(error instanceof Error ? error.message : '添加玩家失败');
    } finally {
      setPlayersBusy(false);
    }
  };

  const handleAddCurrentAuthPlayer = async () => {
    if (!auth.user) return;
    setPlayersError(null);
    setPlayersBusy(true);
    try {
      const res = await apiPost<{ players: SavedPlayerProfile[] }>('/api/players/add', {
        steamId: auth.user.steamId,
        note: auth.user.nickname ?? ''
      });
      setSavedPlayers(res.players);
    } catch (error) {
      setPlayersError(error instanceof Error ? error.message : '添加当前账号失败');
    } finally {
      setPlayersBusy(false);
    }
  };

  const handleBulkAddPlayers = async () => {
    if (!bulkPasteText.trim()) {
      setPlayersError('请先粘贴包含 17 位 SteamID64 的文本');
      return;
    }
    setPlayersError(null);
    setPlayersBusy(true);
    try {
      const res = await apiPost<{ players: SavedPlayerProfile[] }>('/api/players/add', {
        text: bulkPasteText
      });
      setSavedPlayers(res.players);
      setBulkPasteText('');
      setShowBulkPaste(false);
    } catch (error) {
      setPlayersError(error instanceof Error ? error.message : '批量导入玩家失败');
    } finally {
      setPlayersBusy(false);
    }
  };

  const handleUpdateSavedPlayer = async (
    steamId: string,
    patch: { enabled?: boolean; resetWatermarks?: boolean; clearSource?: MatchSource }
  ) => {
    setPlayersError(null);
    setPlayersBusy(true);
    try {
      const res = await apiPost<{ players: SavedPlayerProfile[] }>('/api/players/update', {
        steamId,
        ...patch
      });
      setSavedPlayers(res.players);
    } catch (error) {
      setPlayersError(error instanceof Error ? error.message : '更新玩家设置失败');
    } finally {
      setPlayersBusy(false);
    }
  };

  const handleRemoveSavedPlayer = async (steamId: string) => {
    setPlayersError(null);
    setPlayersBusy(true);
    try {
      const res = await apiPost<{ players: SavedPlayerProfile[] }>('/api/players/remove', {
        steamId
      });
      setSavedPlayers(res.players);
    } catch (error) {
      setPlayersError(error instanceof Error ? error.message : '删除玩家失败');
    } finally {
      setPlayersBusy(false);
    }
  };

  const startMultiSyncExport = async () => {
    if (!auth.authenticated) {
      setJobError('请先扫码登录');
      return;
    }
    const targetIds = savedPlayers.filter((p) => p.enabled).map((p) => p.steamId);
    const chosenSources: MatchSource[] = [];
    if (multiSources.official) chosenSources.push('official');
    if (multiSources.perfectworld) chosenSources.push('perfectworld');

    if (targetIds.length === 0) {
      setJobError('请先添加并勾选至少一位要导出的玩家');
      return;
    }
    if (chosenSources.length === 0) {
      setJobError('请至少勾选一个比赛来源（国服官匹 / 完美平台）');
      return;
    }

    setJobError(null);
    try {
      const state = await apiPost<JobPublicState>('/api/jobs/export-multi-sync', {
        steamIds: targetIds,
        sources: chosenSources,
        syncMode,
        includeRaw
      });
      prevJobStatusRef.current = state.status;
      setJob(state);
    } catch (error) {
      setJobError(error instanceof Error ? error.message : '启动多玩家导出失败');
    }
  };

  const handleExitTool = async () => {
    try {
      await apiPost('/api/system/exit');
      setExited(true);
    } catch {
      setExited(true);
    }
  };

  const jobRunning = job.status === 'listing' || job.status === 'downloading';
  const enabledSavedCount = savedPlayers.filter((p) => p.enabled).length;
  const authAlreadySaved = Boolean(
    auth.user && savedPlayers.some((p) => p.steamId === auth.user?.steamId)
  );
  const progressPercent =
    job.totalCount > 0
      ? Math.round(((job.succeededCount + job.failedCount + job.cancelledCount) / job.totalCount) * 100)
      : 0;

  if (exited) {
    return (
      <div className="page-shell">
        <div className="exit-banner card">
          <h1>工具已退出</h1>
          <p>内存中的登录会话和临时导出文件已清除，本地服务已关闭。您可以安全关闭此浏览器页面。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <header className="topbar">
        <div>
          <h1>CS2 比赛数据下载器</h1>
          <p className="subtitle">完美电竞扫码导出国服官匹 / 完美平台原始比赛数据（仅本机运行）</p>
        </div>
        <button type="button" className="btn btn-danger" onClick={handleExitTool}>
          退出工具
        </button>
      </header>

      <main className="layout-grid">
        {/* 1. 登录区 */}
        <section className="card">
          <div className="card-header">
            <h2>1. 扫码登录</h2>
            <span className={`badge ${auth.authenticated ? 'badge-ok' : 'badge-muted'}`}>
              {auth.authenticated ? '已登录' : '未登录'}
            </span>
          </div>

          {auth.authenticated && auth.user ? (
            <div className="auth-logged-in">
              <div className="user-meta">
                {auth.user.avatar && <img className="avatar" src={auth.user.avatar} alt="" />}
                <div>
                  <div className="user-name">{auth.user.nickname || '已登录玩家'}</div>
                  <div className="mono muted">SteamID64: {auth.user.steamId}</div>
                </div>
              </div>
              <p className="hint">
                登录凭证仅保存在本机进程内存中，不会写入日志或导出文件。同一会话可切换来源与多次导出。
              </p>
              <button type="button" className="btn btn-secondary" onClick={handleLogout}>
                退出登录
              </button>
            </div>
          ) : (
            <div className="auth-qr-box">
              {job.status === 'paused_auth' && (
                <div className="alert alert-warn">
                  导出任务因登录过期已暂停，重新扫码登录成功后可继续未完成项。
                </div>
              )}

              {auth.qr.hasQrImage ? (
                <img
                  className="qr-image"
                  src={`/api/auth/qr.png?v=${qrVersion}`}
                  alt="完美世界电竞扫码登录二维码"
                />
              ) : (
                <div className="qr-placeholder">二维码未就绪</div>
              )}

              <p className="qr-status-text">{auth.qr.message}</p>
              {authError && <p className="error-text">{authError}</p>}

              <button
                type="button"
                className="btn btn-secondary"
                disabled={authLoading}
                onClick={refreshQr}
              >
                {authLoading ? '正在生成...' : '刷新二维码'}
              </button>
            </div>
          )}
        </section>

        {/* 3. 导出进度区 (紧挨侧栏或在下方展示，保持单页三区) */}
        <section className="card">
          <div className="card-header">
            <h2>3. 导出进度</h2>
            <span className={`badge badge-${job.status}`}>{JOB_STATUS_LABELS[job.status]}</span>
          </div>

          <p className="job-message">{job.message}</p>
          {jobError && <p className="error-text">{jobError}</p>}

          {job.jobId && (
            <>
              <div className="progress-track" aria-label="导出进度条">
                <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
              </div>

              <div className="stats-row">
                <div className="stat-box">
                  <span className="stat-label">成功</span>
                  <strong className="stat-value ok">{job.succeededCount}</strong>
                </div>
                <div className="stat-box">
                  <span className="stat-label">失败</span>
                  <strong className="stat-value fail">{job.failedCount}</strong>
                </div>
                <div className="stat-box">
                  <span className="stat-label">剩余</span>
                  <strong className="stat-value">{job.remainingCount}</strong>
                </div>
                <div className="stat-box">
                  <span className="stat-label">来源 / 目标</span>
                  <strong className="stat-value-sm">
                    {job.sourceLabel || '—'} ·{' '}
                    {job.targetSteamId
                      ? /^\d{17}$/.test(job.targetSteamId)
                        ? job.targetSteamId.slice(-6)
                        : job.targetSteamId
                      : '—'}
                  </strong>
                </div>
              </div>

              <div className="job-actions">
                {jobRunning && (
                  <button type="button" className="btn btn-danger-outline" onClick={handleCancelJob}>
                    取消任务
                  </button>
                )}

                {job.status === 'paused_auth' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!auth.authenticated}
                    onClick={handleResumeJob}
                  >
                    继续未完成任务
                  </button>
                )}

                {!jobRunning && job.failedCount > 0 && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={!auth.authenticated}
                    onClick={handleRetryFailed}
                  >
                    重试失败项（{job.failedCount}）
                  </button>
                )}

                {job.downloadReady && job.downloadFilename && (
                  <a
                    className="btn btn-primary"
                    href="/api/jobs/download"
                    download={job.downloadFilename}
                  >
                    下载结果：{job.downloadFilename}
                  </a>
                )}
              </div>

              {job.failures.length > 0 && (
                <div className="failures-box">
                  <h3>失败列表（{job.failures.length}）</h3>
                  <ul>
                    {job.failures.map((item) => (
                      <li key={item.matchId}>
                        <span className="mono">{item.matchId}</span>：{item.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>

        {/* 2. 比赛列表与导出区 */}
        <section className="card card-full">
          <div className="card-header">
            <div className="header-left-group">
              <h2>2. 比赛列表与导出</h2>
              <div className="segmented" role="tablist" aria-label="导出工作模式">
                <button
                  type="button"
                  role="tab"
                  aria-selected={workMode === 'single'}
                  className={workMode === 'single' ? 'active' : ''}
                  onClick={() => {
                    workModeTouchedRef.current = true;
                    setWorkMode('single');
                  }}
                >
                  单人列表查询与选择
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={workMode === 'multi'}
                  className={workMode === 'multi' ? 'active' : ''}
                  onClick={() => {
                    workModeTouchedRef.current = true;
                    setWorkMode('multi');
                  }}
                >
                  多玩家增量批量导出（{savedPlayers.length}）
                </button>
              </div>
            </div>
            <span className="hint">
              默认导出原始 <code className="mono">data</code> JSON，保留全部字段与大整数精度
            </span>
          </div>

          {workMode === 'multi' ? (
            <div className="multi-sync-panel">
              <p className="hint" style={{ marginTop: 0 }}>
                常用 SteamID 名单与每位玩家的上次导出水位仅保存在本机配置文件（
                <code className="mono">{storePath || 'players.json'}</code>
                ），不存储登录凭证。无历史水位的玩家首次将拉取全部可查比赛，之后仅自动导出最新一场之后的新比赛并跨玩家去重打包为单个 ZIP。
              </p>

              <div className="multi-add-row">
                <input
                  type="text"
                  className="text-input mono"
                  placeholder="输入 17 位 SteamID64"
                  value={newSteamId}
                  onChange={(e) => setNewSteamId(e.target.value)}
                />
                <input
                  type="text"
                  className="text-input note-input"
                  placeholder="备注昵称（可选）"
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={playersBusy}
                  onClick={handleAddSinglePlayer}
                >
                  添加玩家
                </button>
                {auth.authenticated && auth.user && !authAlreadySaved && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={playersBusy}
                    onClick={handleAddCurrentAuthPlayer}
                  >
                    + 加入当前账号（{auth.user.nickname || auth.user.steamId.slice(-6)}）
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={playersBusy}
                  onClick={() => setShowBulkPaste((v) => !v)}
                >
                  {showBulkPaste ? '收起批量粘贴' : '批量粘贴添加'}
                </button>
              </div>

              {showBulkPaste && (
                <div className="bulk-paste-box">
                  <textarea
                    className="bulk-textarea mono"
                    rows={4}
                    placeholder={'每行一个玩家，例如：\n76561198000000001 好友A\n76561198000000002 # 好友B'}
                    value={bulkPasteText}
                    onChange={(e) => setBulkPasteText(e.target.value)}
                  />
                  <div className="bulk-paste-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={playersBusy}
                      onClick={handleBulkAddPlayers}
                    >
                      解析并加入列表
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={playersBusy}
                      onClick={() => {
                        setShowBulkPaste(false);
                        setBulkPasteText('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}

              {playersError && <p className="error-text">{playersError}</p>}

              {savedPlayers.length === 0 ? (
                <div className="empty-state">
                  尚未保存任何常用玩家，请先在上方添加或批量粘贴 17 位 SteamID64。
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="match-table">
                    <thead>
                      <tr>
                        <th style={{ width: 42 }}>启用</th>
                        <th>备注 / SteamID64</th>
                        <th>国服官匹上次水位</th>
                        <th>完美平台上次水位</th>
                        <th style={{ width: 148 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {savedPlayers.map((p) => {
                        const offWm = p.watermarks.official;
                        const pwWm = p.watermarks.perfectworld;
                        return (
                          <tr key={p.steamId} className={p.enabled ? 'row-selected' : ''}>
                            <td>
                              <input
                                type="checkbox"
                                checked={p.enabled}
                                disabled={playersBusy || jobRunning}
                                aria-label={`启用玩家 ${p.note || p.steamId}`}
                                onChange={(e) =>
                                  handleUpdateSavedPlayer(p.steamId, { enabled: e.target.checked })
                                }
                              />
                            </td>
                            <td>
                              <div>{p.note || '未命名玩家'}</div>
                              <div className="mono muted small">{p.steamId}</div>
                            </td>
                            <td>
                              {offWm ? (
                                <div className="wm-cell">
                                  <span className="mono small">
                                    {offWm.lastStartTime
                                      ? formatTimeShort(offWm.lastStartTime)
                                      : offWm.lastMatchId}
                                  </span>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-xs"
                                    disabled={playersBusy || jobRunning}
                                    onClick={() =>
                                      handleUpdateSavedPlayer(p.steamId, { clearSource: 'official' })
                                    }
                                  >
                                    清空
                                  </button>
                                </div>
                              ) : (
                                <span className="muted small">无记录（下次全量）</span>
                              )}
                            </td>
                            <td>
                              {pwWm ? (
                                <div className="wm-cell">
                                  <span className="mono small">
                                    {pwWm.lastStartTime
                                      ? formatTimeShort(pwWm.lastStartTime)
                                      : pwWm.lastMatchId}
                                  </span>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-xs"
                                    disabled={playersBusy || jobRunning}
                                    onClick={() =>
                                      handleUpdateSavedPlayer(p.steamId, {
                                        clearSource: 'perfectworld'
                                      })
                                    }
                                  >
                                    清空
                                  </button>
                                </div>
                              ) : (
                                <span className="muted small">无记录（下次全量）</span>
                              )}
                            </td>
                            <td>
                              <div className="wm-actions">
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs"
                                  disabled={
                                    playersBusy || jobRunning || (!offWm && !pwWm)
                                  }
                                  onClick={() =>
                                    handleUpdateSavedPlayer(p.steamId, { resetWatermarks: true })
                                  }
                                >
                                  重置水位
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger-outline btn-xs"
                                  disabled={playersBusy || jobRunning}
                                  onClick={() => handleRemoveSavedPlayer(p.steamId)}
                                >
                                  删除
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="multi-export-bar">
                <div className="multi-options">
                  <div className="multi-option-group">
                    <span className="group-label">平台来源：</span>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={multiSources.official}
                        disabled={jobRunning}
                        onChange={(e) =>
                          setMultiSources((prev) => ({ ...prev, official: e.target.checked }))
                        }
                      />
                      <span>国服官匹</span>
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={multiSources.perfectworld}
                        disabled={jobRunning}
                        onChange={(e) =>
                          setMultiSources((prev) => ({ ...prev, perfectworld: e.target.checked }))
                        }
                      />
                      <span>完美平台</span>
                    </label>
                  </div>

                  <div className="multi-option-group">
                    <span className="group-label">同步方式：</span>
                    <div className="segmented">
                      <button
                        type="button"
                        disabled={jobRunning}
                        className={syncMode === 'incremental' ? 'active' : ''}
                        onClick={() => setSyncMode('incremental')}
                      >
                        增量导出（新比赛）
                      </button>
                      <button
                        type="button"
                        disabled={jobRunning}
                        className={syncMode === 'full' ? 'active' : ''}
                        onClick={() => setSyncMode('full')}
                      >
                        全量导出（忽略水位）
                      </button>
                    </div>
                  </div>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={includeRaw}
                      disabled={jobRunning}
                      onChange={(e) => setIncludeRaw(e.target.checked)}
                    />
                    <span>附带完整接口响应（raw/）</span>
                  </label>
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!auth.authenticated || jobRunning || enabledSavedCount === 0}
                  onClick={startMultiSyncExport}
                >
                  {syncMode === 'incremental'
                    ? `一键增量导出（已启用 ${enabledSavedCount} 人）`
                    : `一键全量导出（已启用 ${enabledSavedCount} 人）`}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="controls-panel">
            <div className="control-group">
              <label className="group-label">查询玩家</label>
              <div className="segmented">
                <button
                  type="button"
                  className={playerMode === 'self' ? 'active' : ''}
                  onClick={() => {
                    setPlayerMode('self');
                    resetListView();
                  }}
                >
                  本人
                </button>
                <button
                  type="button"
                  className={playerMode === 'custom' ? 'active' : ''}
                  onClick={() => {
                    setPlayerMode('custom');
                    resetListView();
                  }}
                >
                  指定 SteamID64
                </button>
              </div>
              {playerMode === 'custom' && (
                <input
                  type="text"
                  className="text-input mono"
                  placeholder="输入 17 位 SteamID64"
                  value={customSteamId}
                  onChange={(e) => {
                    setCustomSteamId(e.target.value);
                    resetListView();
                  }}
                />
              )}
            </div>

            <div className="control-group">
              <label className="group-label">比赛来源</label>
              <div className="segmented">
                <button
                  type="button"
                  className={source === 'official' ? 'active' : ''}
                  onClick={() => {
                    setSource('official');
                    resetListView();
                  }}
                >
                  国服官匹
                </button>
                <button
                  type="button"
                  className={source === 'perfectworld' ? 'active' : ''}
                  onClick={() => {
                    setSource('perfectworld');
                    resetListView();
                  }}
                >
                  完美平台
                </button>
              </div>
            </div>

            <div className="control-group control-action">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!auth.authenticated || listLoading}
                onClick={() => loadMatchPage(true)}
              >
                {listLoading ? '加载中...' : '加载比赛列表'}
              </button>
            </div>
          </div>

          <div className="export-toolbar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includeRaw}
                onChange={(e) => setIncludeRaw(e.target.checked)}
              />
              <span>附带完整接口响应（保存到 raw/；勾选后单场也输出为 ZIP）</span>
            </label>

            <div className="quick-recent">
              <span className="group-label">批量导出最近：</span>
              {[10, 50, 100].map((n) => (
                <button
                  key={n}
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!auth.authenticated || jobRunning}
                  onClick={() => startRecentExport(n)}
                >
                  最近 {n} 场
                </button>
              ))}
              <input
                type="number"
                min={1}
                max={1000}
                className="num-input"
                value={customRecentN}
                onChange={(e) => setCustomRecentN(e.target.value)}
                aria-label="自定义最近场数"
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!auth.authenticated || jobRunning}
                onClick={() => startRecentExport(Number(customRecentN))}
              >
                导出最近 N 场
              </button>
            </div>
          </div>

          {listError && <p className="error-text">{listError}</p>}

          <div className="selection-bar">
            <div className="selection-left">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={matches.length === 0}
                onClick={toggleSelectAllLoaded}
              >
                {matches.length > 0 && selectedIds.size === matches.length ? '取消全选' : '全选已加载'}
              </button>
              <span className="muted">
                已加载 {matches.length} 场，已选 {selectedIds.size} 场
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!auth.authenticated || jobRunning || selectedIds.size === 0}
              onClick={() => startSelectedExport([...selectedIds])}
            >
              导出选中比赛（{selectedIds.size} 场）
            </button>
          </div>

          {matches.length === 0 ? (
            <div className="empty-state">
              {listLoadedOnce
                ? '该来源下暂无可查询的比赛记录。'
                : '请先扫码登录，然后点击“加载比赛列表”，或直接使用上方“最近 N 场”快捷导出。'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="match-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>选</th>
                    <th>时间</th>
                    <th>地图 / 模式</th>
                    <th>比分</th>
                    <th>数据 (K/D/A · Rating)</th>
                    <th>比赛 ID</th>
                    <th style={{ width: 96 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => {
                    const checked = selectedIds.has(m.matchId);
                    const score =
                      m.score1 !== null && m.score2 !== null ? `${m.score1} : ${m.score2}` : '—';
                    const isWin = m.team !== null && m.winTeam !== null && m.team === m.winTeam;
                    const isLoss =
                      m.team !== null && m.winTeam !== null && m.winTeam !== 0 && m.team !== m.winTeam;
                    const kda =
                      m.kill !== null && m.death !== null && m.assist !== null
                        ? `${m.kill}/${m.death}/${m.assist}`
                        : '—';
                    return (
                      <tr key={m.matchId} className={checked ? 'row-selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleOneMatch(m.matchId)}
                            aria-label={`选择比赛 ${m.matchId}`}
                          />
                        </td>
                        <td className="mono">{formatTimeShort(m.startTime || m.endTime)}</td>
                        <td>
                          <div>{formatMapLabel(m.mapName)}</div>
                          {m.mode && <div className="muted small">{m.mode}</div>}
                        </td>
                        <td>
                          <span className={`score-pill ${isWin ? 'win' : isLoss ? 'loss' : ''}`}>
                            {score}
                          </span>
                        </td>
                        <td className="mono">
                          {kda}
                          {m.rating !== null ? ` · ${m.rating}` : ''}
                        </td>
                        <td className="mono small">{m.matchId}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary btn-xs"
                            disabled={jobRunning}
                            onClick={() => startSelectedExport([m.matchId])}
                          >
                            导出此场
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {hasMore && (
            <div className="list-footer">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={listLoading}
                onClick={() => loadMatchPage(false)}
              >
                {listLoading ? '加载中...' : '加载更多比赛'}
              </button>
            </div>
          )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
