import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lines = (s) => s.trim().split('\n').filter(Boolean);

export async function check(repo = project, remote = 'public', branch = 'master') {
  const git = async (...args) => (await exec('git', args, {
    cwd: repo, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })).stdout.trimEnd();
  const reportDir = resolve(repo, await git('rev-parse', '--git-path', 'github-sync'));
  await mkdir(reportDir, { recursive: true });
  const reportPath = resolve(reportDir, 'latest.md');
  const target = `refs/remotes/${remote}/${branch}`;
  const heading = `# GitHub activity\n\nChecked: ${new Date().toISOString()}\nTeam branch: ${remote}/${branch}\n`;
  let report;
  let ok = true;
  try {
    // Only remote-tracking refs: never update local branches, the index, or working files.
    await git('fetch', '--prune', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
      remote, `+refs/heads/*:refs/remotes/${remote}/*`);
    const head = await git('rev-parse', 'HEAD');
    const upstream = await git('rev-parse', '--verify', target);
    const base = await git('merge-base', head, upstream);
    const [counts, commits, changed, localCommitted, dirty, staged, untracked, activity, currentBranch, status] = await Promise.all([
      git('rev-list', '--left-right', '--count', `${head}...${upstream}`),
      git('log', '--max-count=25', '--format=%h %ad %an: %s', '--date=short', `${head}..${upstream}`),
      git('diff', '--name-only', base, upstream),
      git('diff', '--name-only', base, head),
      git('diff', '--name-only'), git('diff', '--cached', '--name-only'),
      git('ls-files', '--others', '--exclude-standard'),
      git('for-each-ref', '--sort=-committerdate', '--count=10',
        '--format=%(refname:short) | %(committerdate:short) | %(subject)', `refs/remotes/${remote}/`),
      git('branch', '--show-current'), git('status', '--short'),
    ]);
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
    const localFiles = new Set(lines([localCommitted, dirty, staged, untracked].join('\n')));
    const overlaps = lines(changed).filter((file) => localFiles.has(file));
    const section = (name, content) => `\n## ${name}\n\n${content || 'None.'}\n`;
    report = heading + `Local branch: ${currentBranch || '(detached HEAD)'}\n` +
      `Local commits not on team branch: ${ahead}\nIncoming commits: ${behind}\n` +
      section('Incoming commits (up to 25)', commits) +
      section('Incoming files (since shared ancestor)', changed) +
      section('Files also changed locally — review before merging', overlaps.join('\n')) +
      section('Uncommitted local changes', status) +
      section('Recent remote branch tips (not necessarily new)', activity) +
      '\nFetch only: no merge, rebase, checkout, stash, commit, or push was performed.\n' +
      'File overlap is a review hint, not a prediction of merge conflicts. Unpushed teammate work is not visible.\n' +
      (behind ? `\nNext: finish and commit your work, review the incoming diff, then manually merge ${remote}/${branch}.\n` : '\nNo incoming commits on the team branch.\n');
  } catch (error) {
    ok = false;
    report = heading + `\nCHECK FAILED — do not treat cached remote refs as current.\n\n${error.message}\n\nYour working files were not changed by this checker. It will retry on the next scheduled run.\n`;
  }
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporary, report);
  await rename(temporary, reportPath);
  return { ok, report, reportPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'check';
  if (mode === 'status') {
    const { stdout } = await exec('git', ['rev-parse', '--git-path', 'github-sync/latest.md'], { cwd: project });
    try { console.log(await readFile(resolve(project, stdout.trim()), 'utf8')); }
    catch { console.error('No report yet. Run npm run sync first.'); process.exitCode = 1; }
  } else if (mode === 'check') {
    const result = await check();
    console.log(result.report);
    console.log(`Report saved to ${result.reportPath}`);
    if (!result.ok) process.exitCode = 1;
  } else {
    console.error('Usage: node scripts/github-sync.mjs [check|status]');
    process.exitCode = 1;
  }
}
