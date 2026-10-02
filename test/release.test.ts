import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'release-fresh-history.sh');

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'va-rel-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.org', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.org' } });
  git('init', '-q', '-b', 'oss-core');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(join(dir, 'old.txt'), 'secret-old-history codename-zeta\n');
  git('add', '.'); git('commit', '-q', '-m', 'old history mentions codename-zeta');
  git('rm', '-q', 'old.txt');
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  git('add', '.'); git('commit', '-q', '-m', 'clean tree');
  const deny = join(dir, '..', `${dir.split('/').pop()}-deny.txt`);
  writeFileSync(deny, '# test\ncodename-zeta\n');
  const run = (...extra: string[]) => spawnSync('bash', [SCRIPT, '--deny-file', deny, ...extra], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', PUBLIC_AUTHOR_NAME: 'Jane', PUBLIC_AUTHOR_EMAIL: '1+jane@users.noreply.github.com' },
  });
  return { dir, git, run };
}

test('release-fresh-history：生成 1 个无父提交的 public 分支，作者是 noreply，旧历史里的禁词不可达', () => {
  const { git, run } = repo({ 'README.md': '# demo\n' });
  const r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /check 3: reachable objects=\d+ · message hits=0 · path hits=0 · text-file hits=0 · any-blob hits=0/);
  assert.equal(git('rev-list', '--count', 'public').trim(), '1');
  assert.equal(git('log', '-1', '--format=%ae|%P', 'public').trim(), '1+jane@users.noreply.github.com|');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'oss-core', '不切分支、不动工作区');
  assert.equal(git('ls-tree', '-r', '--name-only', 'public').trim(), 'README.md');
  // 已存在 → 不加 --force 拒绝
  assert.notEqual(run().status, 0);
  assert.equal(run('--force').status, 0);
});

test('release-fresh-history：当前树里有禁词 → 自检失败并删掉 public 分支；非 noreply 邮箱直接拒绝', () => {
  const { git, run } = repo({ 'notes.md': 'contact codename-zeta here\n' });
  const r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /deny patterns found/);
  assert.equal(git('branch', '--list', 'public').trim(), '', '失败后分支被删除');
  const bad = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, PUBLIC_AUTHOR_NAME: 'x', PUBLIC_AUTHOR_EMAIL: 'x@example.org' } });
  assert.match(bad.stderr, /noreply/);
});
