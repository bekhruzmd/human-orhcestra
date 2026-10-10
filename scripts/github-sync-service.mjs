import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (process.platform !== 'darwin') throw new Error('The background service requires macOS. Use npm run sync for a manual check.');
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const label = `local.human-orchestra.github-sync.${createHash('sha256').update(project).digest('hex').slice(0, 10)}`;
const folder = resolve(homedir(), 'Library/LaunchAgents');
const plist = resolve(folder, `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const xml = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const ctl = (...args) => execFileSync('/bin/launchctl', args, { stdio: 'pipe' });
let loaded = false;
try { ctl('print', service); loaded = true; } catch { /* not installed */ }
const action = process.argv[2];
if (action === 'start') {
  if (loaded) {
    console.log('Background GitHub checks are already enabled (every five minutes).');
  } else {
    mkdirSync(folder, { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(project, 'scripts/github-sync.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)}</string></dict>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`, { mode: 0o600 });
    ctl('bootstrap', domain, plist);
    console.log('Enabled GitHub checks every five minutes and at login. Read the report with npm run sync:status.');
  }
} else if (action === 'stop') {
  if (loaded) ctl('bootout', service);
  try { unlinkSync(plist); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('Background checks disabled; saved report preserved.');
} else if (action === 'status') {
  console.log(loaded ? ctl('print', service).toString() : 'Background checks are not enabled.');
} else {
  throw new Error('Usage: node scripts/github-sync-service.mjs start|stop|status');
}
