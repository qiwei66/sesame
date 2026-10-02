import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_MAP, buildMdfindQuery, installCommands, needsConfirm, reminderDate, resolveApp, toolDefinitions } from '../src/tools.ts';
import { setApps } from '../src/apps.ts';
import { compileCommand, parseCommands } from '../src/commands.ts';
import { parseYaml } from '../src/yaml.ts';
import type { ExecContext, RunOutput } from '../src/types.ts';

function ctxWith(runImpl: (cmd: string, args: string[]) => RunOutput, dryRun = false) {
  const ran: Array<{ cmd: string; args: string[] }> = [];
  const printed: string[] = [];
  const ctx: ExecContext = {
    dryRun,
    print: (l) => printed.push(l),
    run: async (cmd, args) => { ran.push({ cmd, args }); return runImpl(cmd, args); },
    confirm: async () => false,
    home: '/home/tester',
    now: () => new Date(2026, 9, 1, 20, 0, 0),
  };
  return { ctx, ran, printed };
}

test('resolveApp：本地化名 / 显示名 / 配置别名都能映射到盘上实际 App 名（不再靠手写映射表）', () => {
  const apps = [
    { app: 'Lark', names: ['Lark', 'Feishu', '飞书'] },
    { app: 'WeChat', names: ['WeChat', '微信'] },
    { app: 'Notes', names: ['Notes', '备忘录'] },
    { app: 'Google Chrome', names: ['Google Chrome'] },
  ];
  setApps(apps);
  try {
    assert.equal(resolveApp('飞书', {}), 'Lark');
    assert.equal(resolveApp('Feishu', {}), 'Lark');
    assert.equal(resolveApp('lark.app', {}), 'Lark');
    assert.equal(resolveApp('微信', {}), 'WeChat');
    assert.equal(resolveApp('备忘录', {}), 'Notes');
    assert.equal(resolveApp('chrome', {}), 'Google Chrome', '模糊包含匹配');
    assert.equal(resolveApp('浏览器', { 浏览器: 'Google Chrome' }), 'Google Chrome', '配置别名');
    assert.equal(resolveApp('不存在', {}), null);
  } finally {
    setApps(null);
  }
});

test('run_shell：不在白名单的命令与参数一律拒绝', async () => {
  const { ctx, ran } = ctxWith(() => ({ code: 0, stdout: '', stderr: '' }));
  const r1 = await TOOL_MAP.run_shell.exec({ command_id: 'rm_rf' }, ctx);
  assert.equal(r1.ok, false);
  const r2 = await TOOL_MAP.run_shell.exec({ command_id: 'battery', args: ['; rm -rf /'] }, ctx);
  assert.equal(r2.ok, false);
  const r3 = await TOOL_MAP.run_shell.exec({ command_id: 'disk_free', args: ['x'] }, ctx);
  assert.equal(r3.ok, false);
  assert.equal(ran.length, 0);
});

test('commands.yaml：自定义命令编译进 run_shell 白名单，固定 argv + 参数白名单 + 模板输出', async () => {
  const defs = parseCommands(parseYaml(`commands:
  - id: quota_check
    name: 配额查询
    description: 查配额。args: ["home"]（默认）或 ["work"]
    examples: [查一下配额]
    command: [python3, ~/bin/quota.py]
    args:
      - [home, work]
    default_args: [home]
    output:
      json: true
      template: "配额 {host|map:work=工作,*=家里} {ip}：剩余 {left_gb|fixed:1} GB / {quota_gb|fixed:0} GB（{reset|slice:5:16} 重置）"
`));
  installCommands(Object.fromEntries(defs.map((d) => [d.id, compileCommand(d, 'command:test')])));
  try {
    const out = JSON.stringify({ host: 'home', ip: '192.0.2.1', left_gb: 1984.882, quota_gb: 2000, reset: '2026-10-31 14:24:08' });
    const { ctx, ran } = ctxWith(() => ({ code: 0, stdout: out, stderr: '' }));
    const r = await TOOL_MAP.run_shell.exec({ command_id: 'quota_check', args: ['home'] }, ctx);
    assert.equal(r.ok, true);
    assert.equal(r.display, '配额 家里 192.0.2.1：剩余 1984.9 GB / 2000 GB（10-31 14:24 重置）');
    assert.deepEqual(ran[0], { cmd: 'python3', args: ['/home/tester/bin/quota.py', 'home'] });
    // 没给参数 → default_args
    await TOOL_MAP.run_shell.exec({ command_id: 'quota_check' }, ctx);
    assert.deepEqual(ran[1].args.slice(-1), ['home']);
    // 白名单外参数一律拒绝，不执行
    const bad = await TOOL_MAP.run_shell.exec({ command_id: 'quota_check', args: ['; rm -rf /'] }, ctx);
    assert.equal(bad.ok, false);
    assert.equal(ran.length, 2);
    // 描述（给模型看）带例句；用户命令排在内置命令前面
    const desc = toolDefinitions().find((t) => t.function.name === 'run_shell')!.function.description;
    assert.match(desc, /quota_check（查配额。.*（例：查一下配额））；disk_free/);
  } finally {
    installCommands({});
  }
});

test('commands.yaml：confirm: true 的命令先确认，dry-run 下不执行', async () => {
  const [d] = parseCommands(parseYaml('commands:\n  - id: flush_dns\n    command: [dscacheutil, -flushcache]\n    confirm: true\n'));
  installCommands({ flush_dns: compileCommand(d, 'command:test') });
  try {
    const dry = ctxWith(() => ({ code: 0, stdout: '', stderr: '' }), true);
    const r1 = await TOOL_MAP.run_shell.exec({ command_id: 'flush_dns' }, dry.ctx);
    assert.equal(r1.dryRun, true);
    assert.equal(dry.ran.length, 0, 'dry-run 不执行');
    const no = ctxWith(() => ({ code: 0, stdout: 'x', stderr: '' }));
    const r2 = await TOOL_MAP.run_shell.exec({ command_id: 'flush_dns' }, no.ctx);
    assert.match(r2.display, /已取消/);
    assert.equal(no.ran.length, 0, '用户没确认 → 不执行');
    assert.equal(needsConfirm({ name: 'run_shell', args: { command_id: 'flush_dns' } }), true);
    assert.equal(needsConfirm({ name: 'run_shell', args: { command_id: 'battery' } }), false);
  } finally {
    installCommands({});
  }
});

test('commands.yaml：非法 id / 空 command 报错', () => {
  assert.throws(() => parseCommands(parseYaml('commands:\n  - id: Bad-Id\n    command: [ls]\n')), /invalid id/);
  assert.throws(() => parseCommands(parseYaml('commands:\n  - id: ok\n')), /command must be/);
});

test('run_shell battery / disk_free 解析', async () => {
  const { ctx } = ctxWith((cmd) =>
    cmd === 'pmset'
      ? { code: 0, stdout: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n", stderr: '' }
      : { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5   971350180 776530984 157708388    84% 1 1 0% /System/Volumes/Data\n', stderr: '' });
  assert.match((await TOOL_MAP.run_shell.exec({ command_id: 'battery' }, ctx)).display, /电量 100%，已充满/);
  assert.match((await TOOL_MAP.run_shell.exec({ command_id: 'disk_free' }, ctx)).display, /磁盘剩余 150\.4 GB/);
});

test('applescript：只接受预定义动作，参数经 argv 传入（无拼接注入）', async () => {
  const { ctx, ran } = ctxWith(() => ({ code: 0, stdout: '', stderr: '' }));
  assert.equal((await TOOL_MAP.applescript.exec({ action: 'do shell script' }, ctx)).ok, false);
  await TOOL_MAP.applescript.exec({ action: 'create_reminder', params: { title: '交材料" & do shell script "x', day_offset: 1, time: '09:00' } }, ctx);
  const call = ran[0];
  assert.equal(call.cmd, 'osascript');
  assert.ok(!call.args[1].includes('交材料'), '标题不能拼进脚本正文');
  assert.equal(call.args[2], '交材料" & do shell script "x');
});

test('reminderDate：明天 9 点按相对天数计算', () => {
  const d = reminderDate(new Date(2026, 9, 31, 23, 0), 1, '09:00');
  assert.ok(d);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 9);
  assert.equal(reminderDate(new Date(), 1, '25:00'), null);
  assert.equal(reminderDate(new Date(), -1, '09:00'), null);
});

test('buildMdfindQuery：昨天 + pdf，且过滤注入字符', () => {
  assert.equal(
    buildMdfindQuery({ extension: 'PDF', added_days_ago: 1 }),
    'kMDItemFSName == "*.pdf"c && kMDItemDateAdded >= $time.today(-1) && kMDItemDateAdded < $time.today',
  );
  assert.equal(buildMdfindQuery({ name_contains: 'a"||kMDItemFSName=*' }), 'kMDItemFSName == "*akMDItemFSName*"cd');
});

test('search_files：只允许三个目录，mdfind 带 -onlyin', async () => {
  const { ctx, ran } = ctxWith(() => ({ code: 0, stdout: '/home/tester/Downloads/a.pdf\n', stderr: '' }));
  assert.equal((await TOOL_MAP.search_files.exec({ dir: 'home' }, ctx)).ok, false);
  assert.equal((await TOOL_MAP.search_files.exec({ dir: '/' }, ctx)).ok, false);
  const r = await TOOL_MAP.search_files.exec({ dir: 'downloads', extension: 'pdf' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(ran[0].args.slice(0, 2), ['-onlyin', '/home/tester/Downloads']);
});

test('open_url：只允许 http/https', async () => {
  const { ctx, ran } = ctxWith(() => ({ code: 0, stdout: '', stderr: '' }));
  assert.equal((await TOOL_MAP.open_url.exec({ url: 'file:///etc/passwd' }, ctx)).ok, false);
  assert.equal((await TOOL_MAP.open_url.exec({ url: 'javascript:alert(1)' }, ctx)).ok, false);
  assert.equal(ran.length, 0);
});

test('read_clipboard dry-run：读取照常，朗读只打印', async () => {
  const { ctx, ran, printed } = ctxWith((cmd) => ({ code: 0, stdout: cmd === 'pbpaste' ? '你好世界' : '', stderr: '' }), true);
  const r = await TOOL_MAP.read_clipboard.exec({ speak_aloud: true }, ctx);
  assert.match(r.display, /你好世界/);
  assert.deepEqual(ran.map((x) => x.cmd), ['pbpaste']);
  assert.ok(printed.some((l) => l.includes('say')));
});

test('tools 定义符合 OpenAI function 格式', () => {
  const defs = toolDefinitions();
  assert.ok(defs.length >= 9);
  for (const d of defs) {
    assert.equal(d.type, 'function');
    assert.match(d.function.name, /^[a-z_]+$/);
  }
});
