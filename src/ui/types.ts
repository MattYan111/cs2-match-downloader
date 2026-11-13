export type MatchSource = 'official' | 'perfectworld';

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

export type JobStatus =
  | 'idle'
  | 'listing'
  | 'downloading'
  | 'paused_auth'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed';

export interface ExportFailureEntry {
  matchId: string;
  reason: string;
}

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
