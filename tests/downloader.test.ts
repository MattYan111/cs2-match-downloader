import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { createTempExportRoot, removeTempDirSafe } from '../src/export.js';
import { ExportJobManager } from '../src/jobs.js';
import { parsePlayerInputLines, PlayersStore } from '../src/players-store.js';
import { PerfectWorldProvider } from '../src/provider/perfectworld.js';
import { startDownloaderServer } from '../src/server.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function makeDetailPayload(matchId: string, baseFixtureText: string): string {
  return baseFixtureText.replaceAll('LOCAL@demo-match-001', matchId);
}

test('QR login flow, lossless single export, raw ZIP export, partial/retry, and auth resume', async () => {
  const listFixture = await readFile(path.join(fixturesDir, 'match-list-official.json'), 'utf8');
  const detailFixture = await readFile(path.join(fixturesDir, 'match-detail-official.json'), 'utf8');

  const secretToken = 'SECRET_LOGIN_TOKEN_DO_NOT_LEAK';
  const secretQrAccess = 'SECRET_QR_ACCESS_DO_NOT_LEAK';
  let qrCheckCount = 0;
  let failMatch002Once = true;
  let expireTokenOnNextDetail = false;
  const seenRequests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const reqBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    seenRequests.push({ url, body: reqBody });

    if (url.endsWith('/qrAuth/applyToken')) {
      return new Response(
        JSON.stringify({
          code: 0,
          result: {
            accessUrl: `https://passport.pwesports.cn/qr?accessToken=${secretQrAccess}`
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.endsWith('/qrAuth/check')) {
      qrCheckCount++;
      if (qrCheckCount === 1) {
        return new Response(JSON.stringify({ code: 0, result: { status: 1 } }), { status: 200 });
      }
      return new Response(
        `{"code":0,"result":{"status":2,"token":"${secretToken}","accountItem":{"steamId":76561198000000001,"nickName":"Tester","avatar":null}}}`,
        { status: 200 }
      );
    }

    if (url.endsWith('/api/csgo/home/match/list')) {
      if (reqBody.page === 1) {
        return new Response(listFixture, { status: 200 });
      }
      if (reqBody.page === 2) {
        // Includes duplicate matchId (LOCAL@demo-match-002) and one new match
        return new Response(
          JSON.stringify({
            statusCode: 0,
            errorMessage: 'success',
            data: {
              matchList: [
                {
                  matchId: 'LOCAL@demo-match-002',
                  mapName: '荒漠迷城',
                  score1: 9,
                  score2: 13,
                  pageTimeStamp: 1794337200
                },
                {
                  matchId: 'PW-99887766',
                  mapName: '炼狱小镇',
                  score1: 16,
                  score2: 14,
                  pageTimeStamp: 1794333000
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ statusCode: 0, data: { matchList: [] } }), { status: 200 });
    }

    if (url.endsWith('/api/v1/csgo/match')) {
      if (expireTokenOnNextDetail) {
        expireTokenOnNextDetail = false;
        return new Response(JSON.stringify({ statusCode: 401, errorMessage: 'token过期' }), {
          status: 401
        });
      }
      const matchId = String(reqBody.matchId);
      if (matchId === 'LOCAL@demo-match-002' && failMatch002Once) {
        failMatch002Once = false;
        return new Response(JSON.stringify({ statusCode: 10404, errorMessage: '比赛详情不存在' }), {
          status: 200
        });
      }
      return new Response(makeDetailPayload(matchId, detailFixture), { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  };

  const provider = new PerfectWorldProvider({ fetchImpl: mockFetch });
  const tempRoot = await createTempExportRoot();

  try {
    // 1. QR apply & poll
    const qrInit = await provider.createQrCode();
    assert.equal(qrInit.authenticated, false);
    assert.equal(qrInit.qr.status, 'waiting');
    const qrPng = provider.getQrImagePng();
    assert.ok(qrPng && qrPng.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
    assert.equal(JSON.stringify(qrInit).includes(secretQrAccess), false);

    const poll1 = await provider.pollQrStatus();
    assert.equal(poll1.qr.status, 'scanned');

    const poll2 = await provider.pollQrStatus();
    assert.equal(poll2.authenticated, true);
    assert.equal(poll2.user?.steamId, '76561198000000001');
    assert.equal(JSON.stringify(poll2).includes(secretToken), false);

    // 2. Query another player on perfectworld source (dataSource: 3)
    const pwList = await provider.fetchMatchListPage({
      source: 'perfectworld',
      targetSteamId: '76561198000000099',
      page: 1
    });
    assert.equal(pwList.matches.length, 2);
    const lastListReq = seenRequests.at(-1)!;
    assert.equal(lastListReq.body.dataSource, 3);
    assert.equal(lastListReq.body.mySteamId, '76561198000000001');
    assert.equal(lastListReq.body.toSteamId, '76561198000000099');

    // 3. Single-match export (no raw) => standalone JSON without statusCode, preserving big integers
    const jobs = new ExportJobManager(provider, {
      tempRootDir: tempRoot,
      detailDelayMs: 0,
      listDelayMs: 0,
      retryBaseDelayMs: 0
    });
    await jobs.startSelectedJob({
      source: 'official',
      targetSteamId: '76561198000000001',
      matchIds: ['LOCAL@demo-match-001'],
      includeRaw: false
    });
    await jobs.waitForCurrentRun();
    const singleArtifact = jobs.getDownloadArtifact();
    assert.ok(singleArtifact);
    assert.equal(singleArtifact.kind, 'json');
    assert.equal(singleArtifact.downloadFilename, 'official-LOCAL-demo-match-001.json');

    const exportedSingleText = await readFile(singleArtifact.filePath, 'utf8');
    assert.doesNotMatch(exportedSingleText, /"statusCode"/);
    assert.match(exportedSingleText, /9007199254740993/);
    assert.match(exportedSingleText, /76561199437647584/);
    assert.match(exportedSingleText, /"unknownFutureField"/);
    assert.equal(exportedSingleText.includes(secretToken), false);

    // 4. Single-match WITH includeRaw => ZIP containing manifest.json + matches/ + raw/
    await jobs.startSelectedJob({
      source: 'official',
      targetSteamId: '76561198000000001',
      matchIds: ['LOCAL@demo-match-001'],
      includeRaw: true,
      rawListPages: [{ pageIndex: 1, rawBody: listFixture }]
    });
    await jobs.waitForCurrentRun();
    const singleZipArtifact = jobs.getDownloadArtifact();
    assert.ok(singleZipArtifact);
    assert.equal(singleZipArtifact.kind, 'zip');

    const singleZip = await JSZip.loadAsync(await readFile(singleZipArtifact.filePath));
    assert.ok(singleZip.file('manifest.json'));
    assert.ok(singleZip.file('matches/official-LOCAL-demo-match-001.json'));
    assert.ok(singleZip.file('raw/list/page-001.json'));
    assert.ok(singleZip.file('raw/matches/official-LOCAL-demo-match-001.json'));
    const rawDetailInZip = await singleZip.file('raw/matches/official-LOCAL-demo-match-001.json')!.async('string');
    assert.equal(rawDetailInZip, detailFixture);

    // 5. Recent 10 export with shortage (only 3 unique matches exist), 1 temporary failure, retry, and auth expiry resume
    await jobs.startRecentJob({
      source: 'official',
      targetSteamId: '76561198000000001',
      recentCount: 10,
      includeRaw: false
    });
    await jobs.waitForCurrentRun();
    const partialState = jobs.getPublicState();
    assert.equal(partialState.status, 'partial');
    assert.equal(partialState.listedCount, 3);
    assert.equal(partialState.succeededCount, 2);
    assert.equal(partialState.failedCount, 1);
    assert.equal(partialState.failures[0].matchId, 'LOCAL@demo-match-002');
    assert.equal(partialState.downloadReady, true);

    // Trigger auth expiration during retryFailedItems, then re-login and resume
    expireTokenOnNextDetail = true;
    await jobs.retryFailedItems();
    await jobs.waitForCurrentRun();
    const pausedState = jobs.getPublicState();
    assert.equal(pausedState.status, 'paused_auth');
    assert.equal(provider.isAuthenticated(), false);

    // Re-login via QR
    await provider.createQrCode();
    await provider.pollQrStatus();
    assert.equal(provider.isAuthenticated(), true);

    await jobs.resumePausedJob();
    await jobs.waitForCurrentRun();
    const finalState = jobs.getPublicState();
    assert.equal(finalState.status, 'completed');
    assert.equal(finalState.succeededCount, 3);
    assert.equal(finalState.failedCount, 0);

    const batchZip = await JSZip.loadAsync(await readFile(jobs.getDownloadArtifact()!.filePath));
    const manifest = JSON.parse(await batchZip.file('manifest.json')!.async('string'));
    assert.equal(manifest.requestedCount, 10);
    assert.equal(manifest.actualCount, 3);
    assert.equal(manifest.succeededCount, 3);
    assert.equal(manifest.files.length, 3);
    assert.equal(JSON.stringify(manifest).includes(secretToken), false);
  } finally {
    await removeTempDirSafe(tempRoot);
  }
});

test('local server enforces 127.0.0.1 host, origin, and client header guards', async () => {
  const provider = new PerfectWorldProvider();
  const started = await startDownloaderServer({
    provider,
    port: 0,
    open: false,
    devMode: false
  });

  try {
    // Reject bad Origin
    const badOriginRes = await fetch(`${started.url}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'X-PW-Client': '1'
      }
    });
    assert.equal(badOriginRes.status, 403);

    // Reject missing X-PW-Client on POST
    const missingClientHeaderRes = await fetch(`${started.url}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: started.url
      }
    });
    assert.equal(missingClientHeaderRes.status, 403);

    // Valid same-origin POST works
    const okRes = await fetch(`${started.url}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Origin: started.url,
        'X-PW-Client': '1'
      }
    });
    assert.equal(okRes.status, 200);
  } finally {
    await started.close();
  }
});

test('PlayersStore persistence, API endpoints, and multi-player incremental sync with deduplication', async () => {
  const detailFixture = await readFile(path.join(fixturesDir, 'match-detail-official.json'), 'utf8');
  const tempRoot = await createTempExportRoot();
  const storePath = path.join(tempRoot, 'players.json');
  const playersStore = new PlayersStore(storePath);

  // parsePlayerInputLines handles common formats
  const parsedLines = parsePlayerInputLines(
    '# comment\n76561198000000001 好友A\n76561198000000002 # 好友B\n'
  );
  assert.deepEqual(parsedLines, [
    { steamId: '76561198000000001', note: '好友A' },
    { steamId: '76561198000000002', note: '好友B' }
  ]);
  assert.throws(() => parsePlayerInputLines('not-a-steam-id'), /SteamID64/);

  const p1 = '76561198000000001';
  const p2 = '76561198000000002';
  let phase = 1;
  const detailRequests: Array<{ matchId: string; dataSource: number }> = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const reqBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.endsWith('/qrAuth/applyToken')) {
      return new Response(
        JSON.stringify({
          code: 0,
          result: { accessUrl: 'https://passport.pwesports.cn/qr?accessToken=TEST_QR' }
        }),
        { status: 200 }
      );
    }
    if (url.endsWith('/qrAuth/check')) {
      return new Response(
        `{"code":0,"result":{"status":2,"token":"TEST_TOKEN","accountItem":{"steamId":${p1},"nickName":"Me","avatar":null}}}`,
        { status: 200 }
      );
    }
    if (url.endsWith('/api/csgo/home/match/list')) {
      const toSteamId = String(reqBody.toSteamId);
      const dataSource = Number(reqBody.dataSource); // 1=official, 3=perfectworld
      const page = Number(reqBody.page);
      if (page > 1) {
        return new Response(JSON.stringify({ statusCode: 0, data: { matchList: [] } }), { status: 200 });
      }

      if (phase === 1) {
        if (toSteamId === p1 && dataSource === 1) {
          return new Response(
            JSON.stringify({
              statusCode: 0,
              data: {
                matchList: [
                  { matchId: 'OFF-SHARED-001', startTime: '2026-11-10 21:00:00', pageTimeStamp: 1 },
                  { matchId: 'OFF-P1-OLD', startTime: '2026-11-10 19:00:00', pageTimeStamp: 2 }
                ]
              }
            }),
            { status: 200 }
          );
        }
        if (toSteamId === p1 && dataSource === 3) {
          return new Response(
            JSON.stringify({
              statusCode: 0,
              data: {
                matchList: [
                  { matchId: 'PW-P1-001', startTime: '2026-11-10 22:00:00', pageTimeStamp: 3 }
                ]
              }
            }),
            { status: 200 }
          );
        }
        if (toSteamId === p2 && dataSource === 1) {
          return new Response(
            JSON.stringify({
              statusCode: 0,
              data: {
                matchList: [
                  { matchId: 'OFF-SHARED-001', startTime: '2026-11-10 21:00:00', pageTimeStamp: 1 },
                  { matchId: 'OFF-P2-OLD', startTime: '2026-11-09 20:00:00', pageTimeStamp: 4 }
                ]
              }
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ statusCode: 0, data: { matchList: [] } }), { status: 200 });
      }

      // Phase 2: incremental sync with 1 new official match for P1 + older watermark matches
      if (toSteamId === p1 && dataSource === 1) {
        return new Response(
          JSON.stringify({
            statusCode: 0,
            data: {
              matchList: [
                { matchId: 'OFF-P1-NEW', startTime: '2026-11-11 20:00:00', pageTimeStamp: 10 },
                { matchId: 'OFF-SHARED-001', startTime: '2026-11-10 21:00:00', pageTimeStamp: 1 }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (toSteamId === p1 && dataSource === 3) {
        return new Response(
          JSON.stringify({
            statusCode: 0,
            data: {
              matchList: [
                { matchId: 'PW-P1-001', startTime: '2026-11-10 22:00:00', pageTimeStamp: 3 }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (toSteamId === p2 && dataSource === 1) {
        return new Response(
          JSON.stringify({
            statusCode: 0,
            data: {
              matchList: [
                { matchId: 'OFF-SHARED-001', startTime: '2026-11-10 21:00:00', pageTimeStamp: 1 }
              ]
            }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ statusCode: 0, data: { matchList: [] } }), { status: 200 });
    }

    if (url.endsWith('/api/v1/csgo/match')) {
      const matchId = String(reqBody.matchId);
      const dataSource = Number(reqBody.dataSource);
      detailRequests.push({ matchId, dataSource });
      return new Response(makeDetailPayload(matchId, detailFixture), { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  };

  const provider = new PerfectWorldProvider({ fetchImpl: mockFetch });
  const started = await startDownloaderServer({
    provider,
    playersStore,
    tempRootDir: path.join(tempRoot, 'work'),
    detailDelayMs: 0,
    listDelayMs: 0,
    retryBaseDelayMs: 0,
    port: 0,
    open: false,
    devMode: false
  });

  try {
    // 1. Add, update, remove via HTTP API + verify persistence in PlayersStore file
    const addRes = await fetch(`${started.url}/api/players/add`, {
      method: 'POST',
      headers: { Origin: started.url, 'Content-Type': 'application/json', 'X-PW-Client': '1' },
      body: JSON.stringify({ text: `${p1} 玩家一\n${p2} 玩家二\n76561198000000003 临时` })
    });
    assert.equal(addRes.status, 200);

    const removeRes = await fetch(`${started.url}/api/players/remove`, {
      method: 'POST',
      headers: { Origin: started.url, 'Content-Type': 'application/json', 'X-PW-Client': '1' },
      body: JSON.stringify({ steamId: '76561198000000003' })
    });
    assert.equal(removeRes.status, 200);
    const afterRemove = (await removeRes.json()) as { players: Array<{ steamId: string; note: string }> };
    assert.equal(afterRemove.players.length, 2);

    const rawFile = await readFile(storePath, 'utf8');
    assert.match(rawFile, /玩家一/);
    assert.doesNotMatch(rawFile, /76561198000000003/);

    // 2. Authenticate and run initial multi-sync (no watermarks -> full history for both players)
    await provider.createQrCode();
    await provider.pollQrStatus();

    const sync1 = await started.jobManager.startMultiSyncJob({
      steamIds: [p1, p2],
      sources: ['official', 'perfectworld'],
      syncMode: 'incremental',
      includeRaw: false
    });
    assert.equal(sync1.status, 'listing');
    await started.jobManager.waitForCurrentRun();

    const state1 = started.jobManager.getPublicState();
    assert.equal(state1.status, 'completed');
    // Unique matches: OFF-SHARED-001, OFF-P1-OLD, PW-P1-001, OFF-P2-OLD (4 unique total; OFF-SHARED-001 fetched once!)
    assert.equal(state1.succeededCount, 4);
    assert.equal(detailRequests.length, 4);

    const zip1 = await JSZip.loadAsync(await readFile(started.jobManager.getDownloadArtifact()!.filePath));
    assert.ok(zip1.file('matches/official-OFF-SHARED-001.json'));
    assert.ok(zip1.file('matches/official-OFF-P1-OLD.json'));
    assert.ok(zip1.file('matches/perfectworld-PW-P1-001.json'));
    assert.ok(zip1.file('matches/official-OFF-P2-OLD.json'));

    // Verify watermarks persisted
    const listAfter1 = await playersStore.getAll();
    const savedP1 = listAfter1.find((p) => p.steamId === p1)!;
    const savedP2 = listAfter1.find((p) => p.steamId === p2)!;
    assert.equal(savedP1.watermarks.official?.lastMatchId, 'OFF-SHARED-001');
    assert.equal(savedP1.watermarks.perfectworld?.lastMatchId, 'PW-P1-001');
    assert.equal(savedP2.watermarks.official?.lastMatchId, 'OFF-SHARED-001');

    // 3. Second incremental sync: only OFF-P1-NEW should be downloaded
    phase = 2;
    detailRequests.length = 0;

    await started.jobManager.startMultiSyncJob({
      steamIds: [p1, p2],
      sources: ['official', 'perfectworld'],
      syncMode: 'incremental',
      includeRaw: false
    });
    await started.jobManager.waitForCurrentRun();

    const state2 = started.jobManager.getPublicState();
    assert.equal(state2.status, 'completed');
    assert.equal(state2.succeededCount, 1);
    assert.deepEqual(detailRequests, [{ matchId: 'OFF-P1-NEW', dataSource: 1 }]);

    const listAfter2 = await playersStore.getAll();
    assert.equal(listAfter2.find((p) => p.steamId === p1)!.watermarks.official?.lastMatchId, 'OFF-P1-NEW');

    // 4. Reset watermark for P1 official via API
    const resetRes = await fetch(`${started.url}/api/players/update`, {
      method: 'POST',
      headers: { Origin: started.url, 'Content-Type': 'application/json', 'X-PW-Client': '1' },
      body: JSON.stringify({ steamId: p1, clearSource: 'official' })
    });
    assert.equal(resetRes.status, 200);
    const listAfterReset = await playersStore.getAll();
    assert.equal(listAfterReset.find((p) => p.steamId === p1)!.watermarks.official, undefined);
    assert.equal(listAfterReset.find((p) => p.steamId === p1)!.watermarks.perfectworld?.lastMatchId, 'PW-P1-001');
  } finally {
    await started.close();
    await removeTempDirSafe(tempRoot);
  }
});
