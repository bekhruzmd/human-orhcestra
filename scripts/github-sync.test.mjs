import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check } from './github-sync.mjs';

test('fetch reports incoming work and overlap without touching local commits, index, files, or tags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-sync-'));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const team = join(root, 'team');
    const local = join(root, 'local');
    git(root, 'init', '-b', 'master', team);
    git(team, 'config', 'user.name', 'Sync test');
    git(team, 'config', 'user.email', 'sync@example.invalid');
    writeFileSync(join(team, 'shared.txt'), 'base\n');
    git(team, 'add', '.'); git(team, 'commit', '-m', 'Initial');
    git(root, 'clone', '--origin', 'public', team, local);
    git(local, 'config', 'user.name', 'Sync test');
    git(local, 'config', 'user.email', 'sync@example.invalid');
    writeFileSync(join(local, 'mine.txt'), 'my committed work\n');
    git(local, 'add', '.'); git(local, 'commit', '-m', 'My feature');
    writeFileSync(join(local, 'shared.txt'), 'my staged change\n');
    git(local, 'add', 'shared.txt');
    writeFileSync(join(local, 'shared.txt'), 'my unstaged change\n');
    writeFileSync(join(local, 'untracked.txt'), 'keep me\n');
    const before = { head: git(local, 'rev-parse', 'HEAD'), status: git(local, 'status', '--porcelain'), index: git(local, 'diff', '--cached'), work: git(local, 'diff') };
    writeFileSync(join(team, 'shared.txt'), 'teammate redesign\n');
    git(team, 'add', '.'); git(team, 'commit', '-m', 'Teammate redesign');
    git(team, 'tag', 'teammate-tag'); git(team, 'branch', 'feature/team-ui');
    const result = await check(local);
    assert.equal(result.ok, true);
    assert.match(result.report, /Incoming commits: 1/);
    assert.match(result.report, /Local commits not on team branch: 1/);
    assert.match(result.report, /Files also changed locally[^\n]*\n\nshared.txt/);
    assert.match(result.report, /public\/feature\/team-ui/);
    assert.equal(git(local, 'rev-parse', 'public/master'), git(team, 'rev-parse', 'HEAD'));
    assert.equal(git(local, 'tag'), '');
    assert.deepEqual({ head: git(local, 'rev-parse', 'HEAD'), status: git(local, 'status', '--porcelain'), index: git(local, 'diff', '--cached'), work: git(local, 'diff') }, before);
    assert.equal(readFileSync(join(local, 'untracked.txt'), 'utf8'), 'keep me\n');
    git(team, 'branch', '-D', 'feature/team-ui');
    assert.equal((await check(local)).ok, true);
    assert.equal(git(local, 'branch', '-r', '--list', 'public/feature/team-ui'), '');
    git(local, 'remote', 'set-url', 'public', join(root, 'missing'));
    const failed = await check(local);
    assert.equal(failed.ok, false);
    assert.match(readFileSync(failed.reportPath, 'utf8'), /CHECK FAILED/);
    assert.equal(git(local, 'rev-parse', 'HEAD'), before.head);
    assert.equal(git(local, 'status', '--porcelain'), before.status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
