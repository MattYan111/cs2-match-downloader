import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env.PW_DEV_API_PORT || '18787';

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const serverProc = spawn(npxCmd, ['tsx', 'watch', 'src/server.ts'], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PW_DEV_MODE: '1',
    PW_PORT: apiPort
  }
});

const uiProc = spawn(npxCmd, ['vite'], {
  cwd: rootDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    PW_DEV_API_PORT: apiPort
  }
});

function shutdown(code = 0) {
  serverProc.kill('SIGTERM');
  uiProc.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

serverProc.on('exit', (code) => {
  if (code && code !== 0) shutdown(code);
});
uiProc.on('exit', (code) => {
  if (code && code !== 0) shutdown(code);
});
