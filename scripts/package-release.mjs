import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    platform: process.platform === 'win32' ? 'win32' : 'darwin',
    arch: process.arch,
    nodeDir: '',
    outDir: path.join(rootDir, 'release')
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--platform' && val) {
      args.platform = val;
      i++;
    } else if (key === '--arch' && val) {
      args.arch = val;
      i++;
    } else if (key === '--node-dir' && val) {
      args.nodeDir = path.resolve(val);
      i++;
    } else if (key === '--out-dir' && val) {
      args.outDir = path.resolve(val);
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
  const targetLabel = `${args.platform}-${args.arch}`;
  const bundleName = `pw-match-downloader-v${pkg.version}-${targetLabel}`;
  const stageDir = path.join(args.outDir, bundleName);

  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  // Copy compiled app and minimal manifest
  await cp(path.join(rootDir, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
  await writeFile(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        private: true,
        type: 'module',
        dependencies: pkg.dependencies
      },
      null,
      2
    )}\n`
  );
  await cp(path.join(rootDir, 'package-lock.json'), path.join(stageDir, 'package-lock.json'));

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: stageDir,
    stdio: 'inherit'
  });

  // Bundle Node runtime if provided (or current node binary for same-platform local test)
  const runtimeDir = path.join(stageDir, 'runtime');
  await mkdir(runtimeDir, { recursive: true });

  if (args.nodeDir) {
    await cp(args.nodeDir, runtimeDir, { recursive: true });
  } else if (args.platform === process.platform && args.arch === process.arch) {
    const destBin =
      args.platform === 'win32'
        ? path.join(runtimeDir, 'node.exe')
        : path.join(runtimeDir, 'bin', 'node');
    await mkdir(path.dirname(destBin), { recursive: true });
    await cp(process.execPath, destBin);
    if (args.platform !== 'win32') {
      await chmod(destBin, 0o755);
    }
  } else {
    throw new Error(`跨平台打包 ${targetLabel} 时需要传入 --node-dir <解压后的 Node 目录>`);
  }

  if (args.platform === 'win32') {
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      'echo Starting CS2 Match Downloader...',
      '"%~dp0runtime\\node.exe" "%~dp0dist\\server\\server.js" --open',
      'if errorlevel 1 pause',
      ''
    ].join('\r\n');
    await writeFile(path.join(stageDir, '启动下载器.bat'), bat, 'utf8');
  } else {
    const cmd = [
      '#!/bin/bash',
      'cd "$(dirname "$0")"',
      'echo "Starting CS2 Match Downloader..."',
      '"./runtime/bin/node" "./dist/server/server.js" --open',
      'STATUS=$?',
      'if [ $STATUS -ne 0 ]; then',
      '  echo "Exited with code $STATUS. Press Enter to close..."',
      '  read -r _',
      'fi',
      ''
    ].join('\n');
    const cmdPath = path.join(stageDir, '启动下载器.command');
    await writeFile(cmdPath, cmd, 'utf8');
    await chmod(cmdPath, 0o755);
  }

  console.log(`已生成发布目录：${stageDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
