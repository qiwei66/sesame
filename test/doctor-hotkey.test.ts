import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alfredHotkeyEnabled, collectChecks, formatCheck, hotkeyCheck, raycastHotkeyEnabled, spotlightHotkeyEnabled } from '../src/doctor.ts';
import type { HotkeyDefaults } from '../src/doctor.ts';
import { withLocale } from '../src/i18n.ts';
import type { Runner } from '../src/types.ts';

function symbolic(enabled: number, code = 49, mods = 1048576, id = 64): string {
  return `{ ${id} = { enabled = ${enabled}; value = { parameters = (65535, ${code}, ${mods}); type = standard; }; }; }`;
}

const free: HotkeyDefaults = {
  spotlight: symbolic(0), alfred: [], raycast: 'Option-49',
  sesameHotkey: '49:256', sesameCommandSpace: null,
};

test('doctor 热键：空闲为 ok；Spotlight / Raycast / Alfred 占 ⌘Space 为 warn，提供双语修法', () => {
  const cases: [string, Partial<HotkeyDefaults>][] = [
    ['Spotlight', { spotlight: symbolic(1) }],
    ['Raycast', { raycast: 'Command-49\n' }],
    ['Alfred', { alfred: ['{ key = 49; mod = 1048576; string = Space; }'] }],
  ];
  for (const locale of ['zh', 'en'] as const) {
    withLocale(locale, () => {
      const available = hotkeyCheck(free);
      assert.equal(available.level, 'ok');
      assert.equal(available.fix, undefined);
      assert.match(available.detail, /Sesame .*⌘Space/);
      for (const [holder, settings] of cases) {
        const clash = hotkeyCheck({ ...free, ...settings });
        assert.equal(clash.level, 'warn');
        assert.equal(clash.name, locale === 'en' ? 'Hot key' : '热键');
        assert.ok(clash.detail.includes(holder));
        assert.ok(clash.fix);
        assert.ok(!clash.fix.includes('\n'), '修法只有一行');
        const text = formatCheck(clash, false);
        if (locale === 'en') {
          assert.doesNotMatch(text, /\p{Script=Han}/u);
          assert.match(text, /fix: Settings › Hot key/);
        } else {
          assert.match(text, /修法：设置 › 热键/);
        }
      }
    });
  }
});

test('doctor 热键：备用键和其他自定义键不因 ⌘Space 被占误报警；所有占用应用都显示', () => {
  const held = { ...free, spotlight: symbolic(1), alfred: ['{ key = 49; mod = 256; }'], raycast: 'Command-49' };
  for (const settings of [
    { sesameHotkey: null, sesameCommandSpace: null },
    { sesameHotkey: null, sesameCommandSpace: '1' },
    { sesameHotkey: '49:2048', sesameCommandSpace: '1' }, // 旧 ⌥Space 存储迁移到自动模式
    { sesameHotkey: '49:2560', sesameCommandSpace: '1' },
    { sesameHotkey: '40:256', sesameCommandSpace: '1' },
  ]) {
    const result = hotkeyCheck({ ...held, ...settings });
    assert.equal(result.level, 'ok');
    assert.match(result.detail, /Spotlight \/ Alfred \/ Raycast/);
    assert.ok(result.detail.includes(settings.sesameHotkey === '40:256' ? '⌘#40' : '⌥⇧Space'));
  }
  assert.match(hotkeyCheck({ ...free, sesameHotkey: null, sesameCommandSpace: '1' }).detail, /Sesame .*⌘Space/);
  assert.match(hotkeyCheck({ ...free, sesameHotkey: null, sesameCommandSpace: '0' }).detail, /⌥⇧Space/);
});

test('doctor 热键：Spotlight 解析缺失、禁用、改键、额外修饰键及其他系统快捷键', () => {
  assert.equal(spotlightHotkeyEnabled(null), true);
  assert.equal(spotlightHotkeyEnabled(''), true);
  assert.equal(spotlightHotkeyEnabled('{}'), true);
  assert.equal(spotlightHotkeyEnabled(symbolic(0)), false);
  assert.equal(spotlightHotkeyEnabled(symbolic(1)), true);
  assert.equal(spotlightHotkeyEnabled(symbolic(1, 40)), false);
  assert.equal(spotlightHotkeyEnabled(symbolic(1, 49, 1572864)), false);
  assert.equal(spotlightHotkeyEnabled(symbolic(1, 49, 1179648)), false);
  assert.equal(spotlightHotkeyEnabled('{ "64" = { enabled = 1; }; }'), true);
  assert.equal(spotlightHotkeyEnabled('{ 64 = { enabled = 0; }; 65 = { enabled = 1; value = { parameters = (32, 49, 1048576); }; }; }'), true);
  // 多行缩进以及 parameters 中的数字不能误当成另一项的 enabled。
  assert.equal(spotlightHotkeyEnabled(`{
    64 = { enabled = 0; value = { parameters = (65535, 49, 1048576); }; };
    65 = { enabled = 1; value = { parameters = (65535, 49, 1572864); }; };
  }`), false);
});

test('doctor 热键：Raycast 只匹配 Command-49 / Cmd-49，缺键和未知格式不占 ⌘Space', () => {
  for (const value of ['Command-49', 'cmd-49', '"Command-49"\n', 'COMMAND-49']) assert.equal(raycastHotkeyEnabled(value), true);
  for (const value of [null, '', 'Option-49', 'Command-Shift-49', 'Command-40', 'Unknown-49', 'garbage']) assert.equal(raycastHotkeyEnabled(value), false);
});

test('doctor 热键：Alfred 接受 AppKit / Carbon 掩码，缺键及额外修饰键不占 ⌘Space', () => {
  for (const mod of [256, 1048576, 1048576 + 8388608]) assert.equal(alfredHotkeyEnabled(`{ default = { key = 49; mod = ${mod}; }; }`), true);
  for (const value of [null, '', '{}', '{ key = 49; }', '{ key = 40; mod = 256; }', '{ key = 49; mod = 524288; }', '{ key = 49; mod = 768; }', '{ key = 49; mod = 1572864; }']) assert.equal(alfredHotkeyEnabled(value), false);
});

test('doctor 热键：defaults 键不存在沿用 Spotlight 默认，备用键 ok，自定义 ⌘Space warn', () => {
  const missing: HotkeyDefaults = { spotlight: null, alfred: [null], raycast: null, sesameHotkey: null, sesameCommandSpace: null };
  assert.equal(hotkeyCheck(missing).level, 'ok');
  assert.match(hotkeyCheck(missing).detail, /Spotlight/);
  assert.equal(hotkeyCheck({ ...missing, sesameHotkey: '49:256' }).level, 'warn');
  for (const sesameHotkey of ['bad', '4294967296:256', '49:4294967296']) {
    assert.match(hotkeyCheck({ ...missing, sesameHotkey }).detail, /⌥⇧Space/);
  }
});

test('doctor 热键：collectChecks 用 defaults read 读取同步 Alfred 偏好，缺键和执行失败不会崩溃', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'sesame-doctor-'));
  const oldConfigDir = process.env.VA_CONFIG_DIR;
  t.after(() => {
    if (oldConfigDir === undefined) delete process.env.VA_CONFIG_DIR;
    else process.env.VA_CONFIG_DIR = oldConfigDir;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.VA_CONFIG_DIR = home;
  writeFileSync(join(home, 'config.yaml'), 'provider: ollama\n');
  const sync = join(home, 'made-up sync');
  const local = join(sync, 'Alfred.alfredpreferences/preferences/local/fake-host/hotkey');
  mkdirSync(local, { recursive: true });
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    assert.equal(cmd, 'defaults');
    assert.equal(args[0], 'read', '设置只读');
    calls.push(args);
    let stdout: string | undefined;
    if (args[1] === 'com.apple.symbolichotkeys') stdout = symbolic(0);
    if (args[1] === 'com.runningwithcrayons.Alfred-Preferences') stdout = sync;
    if (args[1] === join(local, 'prefs')) stdout = '{ key = 49; mod = 1048576; }';
    if (args[1] === 'io.github.sesame.app' && args[2] === 'hotKey') stdout = '49:256';
    return { code: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: stdout === undefined ? 'The domain/default pair does not exist' : '' };
  };
  const result = await withLocale('en', () => collectChecks({ root: home, home, run }));
  const hotkey = result.find((c) => c.name === 'Hot key');
  assert.equal(hotkey?.level, 'warn');
  assert.match(hotkey!.detail, /Alfred/);
  assert.deepEqual(calls.find((args) => args[1] === join(local, 'prefs')), ['read', join(local, 'prefs'), 'default']);
  for (const run of [
    async () => ({ code: 1, stdout: '', stderr: 'The domain/default pair does not exist' }),
    async () => { throw new Error('defaults unavailable'); },
  ]) {
    const checks = await withLocale('en', () => collectChecks({ root: home, home, run }));
    assert.equal(checks.find((c) => c.name === 'Hot key')?.level, 'ok');
  }
});
