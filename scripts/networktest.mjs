// Isolated protocol test: never mutates a developer's running room.
import { spawn } from 'node:child_process';
const port = process.env.TEST_PORT ?? '3199';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: port, VERCEL: '' }, stdio: ['ignore', 'pipe', 'inherit'],
});
let runner;
const cleanup = () => { runner?.kill(); server.kill(); };
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    server.once('error', reject);
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Test server exited: ${code}`)); });
    server.stdout.on('data', (data) => { if (String(data).includes('Stage:')) { clearTimeout(timeout); resolve(); } });
  });
  runner = spawn(process.execPath, ['--import', 'tsx', 'scripts/smoke.ts'], {
    env: { ...process.env, URL: `ws://localhost:${port}/ws` }, stdio: 'inherit',
  });
  const timeout = setTimeout(() => runner.kill(), 30000);
  const code = await new Promise((resolve, reject) => { runner.once('error', reject); runner.once('exit', resolve); });
  clearTimeout(timeout);
  process.exitCode = code ?? 1;
} finally { cleanup(); }
