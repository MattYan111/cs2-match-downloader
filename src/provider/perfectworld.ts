import QRCode from 'qrcode';
import {
  asCursorValue,
  asIdString,
  asOptionalString,
  asSafeNumber,
  decodeUtf8Strict,
  getObjectProp,
  LosslessJsonError,
  type LosslessJsonNode,
  parseLosslessJson,
  serializeLosslessJson
} from '../json-lossless.js';

export type MatchSource = 'official' | 'perfectworld';

export const SOURCE_CONFIG: Record<
  MatchSource,
  { dataSource: number; label: string; filePrefix: string }
> = {
  official: { dataSource: 1, label: '国服官匹', filePrefix: 'official' },
  perfectworld: { dataSource: 3, label: '完美平台', filePrefix: 'perfectworld' }
};

export interface AuthUser {
  steamId: string;
  nickname: string | null;
  avatar: string | null;
}

export interface QrPublicState {
  status: 'none' | 'waiting' | 'scanned' | 'expired' | 'error';
  message: string;
  qrHost: string | null;
  createdAt: number | null;
  expiresAt: number | null;
  hasQrImage: boolean;
}

export interface AuthPublicState {
  authenticated: boolean;
  user: AuthUser | null;
  qr: QrPublicState;
}

export interface MatchSummary {
  matchId: string;
  startTime: string | null;
  endTime: string | null;
  mapName: string | null;
  mode: string | null;
  score1: number | null;
  score2: number | null;
  team: number | null;
  winTeam: number | null;
  kill: number | null;
  death: number | null;
  assist: number | null;
  rating: number | null;
  pageTimeStamp: string | number | null;
}

export interface MatchListPageResult {
  matches: MatchSummary[];
  nextCursor: string | number | null;
  hasMore: boolean;
  rawBody: string;
}

export interface MatchDetailResult {
  matchId: string;
  cleanJsonText: string;
  rawBody: string;
}

export class AuthExpiredError extends Error {
  constructor(message = '登录会话已过期，请重新扫码') {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export class ProviderRequestError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(message: string, options?: { retryable?: boolean; statusCode?: number }) {
    super(message);
    this.name = 'ProviderRequestError';
    this.retryable = options?.retryable ?? false;
    this.statusCode = options?.statusCode;
  }
}

export interface PerfectWorldProviderOptions {
  passportBaseUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  qrTtlMs?: number;
}

interface InternalQrState {
  accessToken: string;
  qrPng: Buffer;
  qrHost: string;
  createdAt: number;
  expiresAt: number;
  status: 'waiting' | 'scanned' | 'expired' | 'error';
  message: string;
}

interface InternalAuthSession {
  token: string;
  user: AuthUser;
}

const DEFAULT_PASSPORT_BASE = 'https://passport.pwesports.cn';
const DEFAULT_API_BASE = 'https://api.wmpvp.com';
const APP_VERSIONS = ['3.5.4.172', '4.0.9.215'] as const;
const QR_HOST_PATTERN = /(^|\.)(pwesports\.cn|wmpvp\.com|wanmei\.com)$/;

function isAuthExpiredStatus(httpStatus: number, statusCode: number | null, errorMessage: string | null): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (statusCode === 401 || statusCode === 403) return true;
  if (errorMessage && /token.*(过期|失效|无效)|未登录|登录.*过期|重新登录/i.test(errorMessage)) {
    return true;
  }
  return false;
}

function optionalDisplayNumber(node: LosslessJsonNode | undefined, field: string): number | null {
  if (!node || node.type === 'null') return null;
  if (node.type === 'number') return asSafeNumber(node, field);
  return null;
}

export class PerfectWorldProvider {
  private readonly passportBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly qrTtlMs: number;

  private authSession: InternalAuthSession | null = null;
  private qrState: InternalQrState | null = null;
  private workingAppVersion: string = APP_VERSIONS[0];
  private qrBusy = false;
  private pollBusy = false;

  constructor(options: PerfectWorldProviderOptions = {}) {
    this.passportBaseUrl = (options.passportBaseUrl ?? DEFAULT_PASSPORT_BASE).replace(/\/$/, '');
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.qrTtlMs = options.qrTtlMs ?? 240000;
  }

  isAuthenticated(): boolean {
    return this.authSession !== null;
  }

  getAuthenticatedSteamId(): string | null {
    return this.authSession?.user.steamId ?? null;
  }

  getPublicAuthState(): AuthPublicState {
    if (!this.qrState) {
      return {
        authenticated: this.authSession !== null,
        user: this.authSession?.user ?? null,
        qr: {
          status: 'none',
          message: this.authSession ? '已登录' : '点击生成二维码后使用完美世界电竞 App 扫码',
          qrHost: null,
          createdAt: null,
          expiresAt: null,
          hasQrImage: false
        }
      };
    }

    return {
      authenticated: this.authSession !== null,
      user: this.authSession?.user ?? null,
      qr: {
        status: this.qrState.status,
        message: this.qrState.message,
        qrHost: this.qrState.qrHost,
        createdAt: this.qrState.createdAt,
        expiresAt: this.qrState.expiresAt,
        hasQrImage: this.qrState.status === 'waiting' || this.qrState.status === 'scanned'
      }
    };
  }

  getQrImagePng(): Buffer | null {
    if (!this.qrState) return null;
    if (this.qrState.status !== 'waiting' && this.qrState.status !== 'scanned') return null;
    return this.qrState.qrPng;
  }

  clearAuthOnly(): void {
    this.authSession = null;
  }

  logout(): void {
    this.authSession = null;
    this.qrState = null;
  }

  async createQrCode(): Promise<AuthPublicState> {
    if (this.qrBusy) return this.getPublicAuthState();
    this.qrBusy = true;
    try {
      const { json } = await this.postJsonLossless(
        `${this.passportBaseUrl}/qrAuth/applyToken`,
        { appId: '5', qrType: '1', redirect: false, website: 'pvp' },
        {},
        false
      );

      const code = optionalDisplayNumber(getObjectProp(json, 'code'), 'code');
      const result = getObjectProp(json, 'result');
      const accessUrl = asOptionalString(getObjectProp(result, 'accessUrl'));
      if (!accessUrl) {
        throw new ProviderRequestError(`申请二维码失败${code !== null ? `（代码 ${code}）` : ''}`);
      }

      let parsed: URL;
      try {
        parsed = new URL(accessUrl);
      } catch {
        throw new ProviderRequestError('二维码地址格式无效');
      }
      if (parsed.protocol !== 'https:' || !QR_HOST_PATTERN.test(parsed.hostname)) {
        throw new ProviderRequestError('二维码域名不符合预期');
      }

      const accessToken = parsed.searchParams.get('accessToken');
      if (!accessToken) {
        throw new ProviderRequestError('二维码缺少访问参数');
      }

      const qrPng = await QRCode.toBuffer(accessUrl, {
        type: 'png',
        width: 280,
        margin: 2,
        errorCorrectionLevel: 'M'
      });

      const now = Date.now();
      this.qrState = {
        accessToken,
        qrPng,
        qrHost: parsed.hostname,
        createdAt: now,
        expiresAt: now + this.qrTtlMs,
        status: 'waiting',
        message: '请使用完美世界电竞 App 扫码并在手机上确认登录'
      };
      return this.getPublicAuthState();
    } catch (error) {
      const msg = error instanceof Error ? error.message : '申请二维码失败';
      this.qrState = {
        accessToken: '',
        qrPng: Buffer.alloc(0),
        qrHost: '',
        createdAt: Date.now(),
        expiresAt: Date.now(),
        status: 'error',
        message: msg
      };
      throw error;
    } finally {
      this.qrBusy = false;
    }
  }

  async pollQrStatus(): Promise<AuthPublicState> {
    if (!this.qrState || (this.qrState.status !== 'waiting' && this.qrState.status !== 'scanned')) {
      return this.getPublicAuthState();
    }
    if (Date.now() > this.qrState.expiresAt) {
      this.qrState = {
        ...this.qrState,
        accessToken: '',
        qrPng: Buffer.alloc(0),
        status: 'expired',
        message: '二维码已过期，请点击刷新二维码'
      };
      return this.getPublicAuthState();
    }
    if (this.pollBusy) return this.getPublicAuthState();

    this.pollBusy = true;
    try {
      const { json } = await this.postJsonLossless(
        `${this.passportBaseUrl}/qrAuth/check`,
        { appId: '5', accessToken: this.qrState.accessToken },
        {},
        false
      );

      const result = getObjectProp(json, 'result');
      const status = optionalDisplayNumber(getObjectProp(result, 'status'), 'result.status');

      if (status === 2) {
        const token = asOptionalString(getObjectProp(result, 'token'));
        const accountItem = getObjectProp(result, 'accountItem');
        const steamId = asIdString(getObjectProp(accountItem, 'steamId'), 'accountItem.steamId');
        const nickname = asOptionalString(getObjectProp(accountItem, 'nickName'));
        const avatar = asOptionalString(getObjectProp(accountItem, 'avatar'));

        if (!token || !steamId) {
          throw new ProviderRequestError('登录响应缺少必要账号字段');
        }

        this.authSession = {
          token,
          user: { steamId, nickname, avatar }
        };
        this.qrState = null;
        return this.getPublicAuthState();
      }

      if (status === 3) {
        this.qrState = {
          ...this.qrState,
          accessToken: '',
          qrPng: Buffer.alloc(0),
          status: 'expired',
          message: '二维码已过期，请点击刷新二维码'
        };
        return this.getPublicAuthState();
      }

      if (status === 1) {
        this.qrState = {
          ...this.qrState,
          status: 'scanned',
          message: '已扫码，请在手机上点击确认登录'
        };
      }
      return this.getPublicAuthState();
    } catch (error) {
      if (this.qrState) {
        const msg = error instanceof Error ? error.message : '登录状态检查失败';
        this.qrState = {
          ...this.qrState,
          message: `登录查询暂遇异常（${msg}），仍在等待确认`
        };
      }
      return this.getPublicAuthState();
    } finally {
      this.pollBusy = false;
    }
  }

  async fetchMatchListPage(params: {
    source: MatchSource;
    targetSteamId?: string;
    page: number;
    pageSize?: number;
    cursor?: string | number | null;
    signal?: AbortSignal;
  }): Promise<MatchListPageResult> {
    const session = this.requireAuth();
    const toSteamId = (params.targetSteamId?.trim() || session.user.steamId).trim();
    if (!/^\d{17}$/.test(toSteamId)) {
      throw new ProviderRequestError('目标玩家 SteamID64 必须为 17 位数字');
    }

    const { dataSource } = SOURCE_CONFIG[params.source];
    const pageSize = params.pageSize ?? 100;
    const candidates =
      params.page === 1
        ? [this.workingAppVersion, ...APP_VERSIONS.filter((v) => v !== this.workingAppVersion)]
        : [this.workingAppVersion];

    let lastError: Error | null = null;

    for (const appversion of candidates) {
      const body: Record<string, unknown> = {
        csgoSeasonId: 'recent',
        dataSource,
        mySteamId: session.user.steamId,
        toSteamId,
        page: params.page,
        pageSize,
        pvpType: -1
      };
      if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
        body.pageTimeStamp = params.cursor;
      }

      const { httpStatus, rawText, json } = await this.postJsonLossless(
        `${this.apiBaseUrl}/api/csgo/home/match/list`,
        body,
        {
          token: session.token,
          appversion,
          platform: 'android',
          'User-Agent': 'okhttp/4.11.0'
        },
        true,
        params.signal
      );

      const statusCode = optionalDisplayNumber(getObjectProp(json, 'statusCode'), 'statusCode');
      const errorMessage = asOptionalString(getObjectProp(json, 'errorMessage'));

      if (isAuthExpiredStatus(httpStatus, statusCode, errorMessage)) {
        this.authSession = null;
        throw new AuthExpiredError();
      }

      if (statusCode === 0) {
        const dataNode = getObjectProp(json, 'data');
        const listNode = getObjectProp(dataNode, 'matchList');
        if (listNode?.type === 'null' || listNode === undefined) {
          this.workingAppVersion = appversion;
          return {
            matches: [],
            nextCursor: null,
            hasMore: false,
            rawBody: rawText
          };
        }
        if (listNode.type !== 'array') {
          throw new ProviderRequestError('比赛列表响应格式不符合预期');
        }

        this.workingAppVersion = appversion;
        const matches: MatchSummary[] = [];
        for (const item of listNode.items) {
          if (item.type !== 'object') {
            throw new ProviderRequestError('比赛列表项不是对象');
          }
          const matchId = asIdString(getObjectProp(item, 'matchId'), 'matchId');
          if (!matchId) {
            throw new ProviderRequestError('比赛列表项缺少 matchId');
          }
          matches.push({
            matchId,
            startTime: asOptionalString(getObjectProp(item, 'startTime')),
            endTime: asOptionalString(getObjectProp(item, 'endTime')),
            mapName: asOptionalString(getObjectProp(item, 'mapName')),
            mode: asOptionalString(getObjectProp(item, 'mode')),
            score1: optionalDisplayNumber(getObjectProp(item, 'score1'), 'score1'),
            score2: optionalDisplayNumber(getObjectProp(item, 'score2'), 'score2'),
            team: optionalDisplayNumber(getObjectProp(item, 'team'), 'team'),
            winTeam: optionalDisplayNumber(getObjectProp(item, 'winTeam'), 'winTeam'),
            kill: optionalDisplayNumber(getObjectProp(item, 'kill'), 'kill'),
            death: optionalDisplayNumber(getObjectProp(item, 'death'), 'death'),
            assist: optionalDisplayNumber(getObjectProp(item, 'assist'), 'assist'),
            rating: optionalDisplayNumber(getObjectProp(item, 'rating'), 'rating'),
            pageTimeStamp: asCursorValue(getObjectProp(item, 'pageTimeStamp'))
          });
        }

        const nextCursor = matches.length > 0 ? matches[matches.length - 1].pageTimeStamp : null;
        return {
          matches,
          nextCursor,
          hasMore: matches.length > 0,
          rawBody: rawText
        };
      }

      lastError = new ProviderRequestError(
        `读取比赛列表失败（代码 ${statusCode ?? httpStatus}${errorMessage ? `：${errorMessage}` : ''}）`,
        {
          retryable: httpStatus >= 500,
          statusCode: statusCode ?? httpStatus
        }
      );
    }

    throw lastError ?? new ProviderRequestError('读取比赛列表失败');
  }

  async fetchMatchDetail(params: {
    source: MatchSource;
    matchId: string;
    signal?: AbortSignal;
  }): Promise<MatchDetailResult> {
    const session = this.requireAuth();
    const { dataSource } = SOURCE_CONFIG[params.source];

    const { httpStatus, rawText, json } = await this.postJsonLossless(
      `${this.apiBaseUrl}/api/v1/csgo/match`,
      {
        matchId: params.matchId,
        platform: 'admin',
        dataSource
      },
      {
        accesstoken: session.token,
        appversion: this.workingAppVersion
      },
      true,
      params.signal
    );

    const statusCode = optionalDisplayNumber(getObjectProp(json, 'statusCode'), 'statusCode');
    const errorMessage = asOptionalString(getObjectProp(json, 'errorMessage'));

    if (isAuthExpiredStatus(httpStatus, statusCode, errorMessage)) {
      this.authSession = null;
      throw new AuthExpiredError();
    }

    if (httpStatus >= 500) {
      throw new ProviderRequestError(`接口服务暂时不可用（HTTP ${httpStatus}）`, {
        retryable: true,
        statusCode: httpStatus
      });
    }

    if (statusCode !== 0) {
      throw new ProviderRequestError(
        `比赛详情不可用（代码 ${statusCode ?? httpStatus}${errorMessage ? `：${errorMessage}` : ''}）`,
        {
          retryable: false,
          statusCode: statusCode ?? httpStatus
        }
      );
    }

    const dataNode = getObjectProp(json, 'data');
    if (!dataNode || dataNode.type !== 'object' || dataNode.entries.length === 0) {
      throw new ProviderRequestError('比赛详情响应缺少有效的 data 对象', { retryable: false });
    }

    const baseNode = getObjectProp(dataNode, 'base');
    if (baseNode && baseNode.type === 'object') {
      const returnedIdNode = getObjectProp(baseNode, 'matchId');
      if (returnedIdNode && returnedIdNode.type !== 'null') {
        const returnedId = asIdString(returnedIdNode, 'data.base.matchId');
        if (returnedId && returnedId !== params.matchId) {
          throw new ProviderRequestError(
            `详情比赛 ID 不一致（请求 ${params.matchId}，返回 ${returnedId}）`,
            { retryable: false }
          );
        }
      }
    }

    const cleanJsonText = `${serializeLosslessJson(dataNode, 2)}\n`;
    return {
      matchId: params.matchId,
      cleanJsonText,
      rawBody: rawText
    };
  }

  private requireAuth(): InternalAuthSession {
    if (!this.authSession) {
      throw new AuthExpiredError('尚未登录或会话已过期，请先扫码登录');
    }
    return this.authSession;
  }

  private async postJsonLossless(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    allowHttp4xxJson: boolean,
    callerSignal?: AbortSignal
  ): Promise<{ httpStatus: number; rawText: string; json: LosslessJsonNode }> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new ProviderRequestError('任务已取消', { retryable: false });
      }
      const msg = error instanceof Error ? error.message : '网络请求失败';
      throw new ProviderRequestError(`网络请求失败：${msg}`, { retryable: true });
    }

    if (response.status === 401 || response.status === 403) {
      if (!allowHttp4xxJson) {
        throw new ProviderRequestError(`HTTP ${response.status}`, { retryable: false });
      }
      // Try parsing body if available, otherwise treat directly as auth expired
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) {
        throw new AuthExpiredError();
      }
      try {
        const rawText = decodeUtf8Strict(bytes);
        const json = parseLosslessJson(rawText);
        return { httpStatus: response.status, rawText, json };
      } catch {
        throw new AuthExpiredError();
      }
    }

    if (!response.ok && !(allowHttp4xxJson && response.status >= 400 && response.status < 500)) {
      throw new ProviderRequestError(`接口请求失败（HTTP ${response.status}）`, {
        retryable: response.status >= 500 || response.status === 429,
        statusCode: response.status
      });
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    let rawText: string;
    let json: LosslessJsonNode;
    try {
      rawText = decodeUtf8Strict(bytes);
      json = parseLosslessJson(rawText);
    } catch (error) {
      if (error instanceof LosslessJsonError) {
        throw new ProviderRequestError(error.message, { retryable: false });
      }
      throw error;
    }

    return { httpStatus: response.status, rawText, json };
  }
}
