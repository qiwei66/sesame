/**
 * 生成 Alfred 5 workflow 包（2026-10-01 入口变更：不用专属热键，保持 ⌘Space 肌肉记忆）：
 *  1. Fallback Search 触发器：Alfred 主输入框里没有本地结果的句子，回车交给 bin/va
 *     （需用户在 Features > Default Results > Setup fallback results 里把它加入并拖到第一位）
 *  2. 关键词 `v <一句话>`：强制入口，不依赖 fallback
 * 对象结构照抄 Alfred 自带模板（Alfred 5.app 内的「Fallback Searches」「Keyword to Script」）。
 * 注：Alfred 导入第三方 workflow 时会剥掉热键（Alfred Framework 内文案 "Hotkeys and Snippet Triggers for imported
 * workflows will be stripped for predictability."），所以本包不含热键。
 * 用法：node scripts/build-alfred.ts  → dist/语音指令助手.alfredworkflow
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'dist', 'build');
const OUT = join(ROOT, 'dist', '语音指令助手.alfredworkflow');

export const KEYWORD = 'v';

/**
 * Alfred 运行的脚本。不再把输出全丢掉：
 *  - 退出码 0：正常（va 自己已经通知/弹框）
 *  - 退出码 1：va 已处理的失败（用户已看到不自动关闭的对话框）→ 只写 logs/alfred-errors.log，不重复弹
 *  - 其它（3 = 未捕获异常、127 = 找不到 node、被杀…）：用户什么都没看到 → 写日志 + 弹系统通知
 * 日志一行头：ISO 时间 rc=N，后面是 va 的 stdout/stderr 末 40 行（不含密钥：va 输出本身已脱敏）
 */
export const ALFRED_SCRIPT = [
  'LOG="$HOME/.voice-agent/logs/alfred-errors.log"',
  'out="$("$HOME/.voice-agent/bin/va" "$1" 2>&1)"; rc=$?',
  'if [ "$rc" -ne 0 ]; then',
  '  mkdir -p "$(dirname "$LOG")"',
  '  { printf \'%s rc=%s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc"; printf \'%s\\n\' "$out" | tail -40; } >> "$LOG"',
  '  if [ "$rc" -ne 1 ]; then',
  '    /usr/bin/osascript -e \'on run argv\' -e \'display notification (item 1 of argv) with title "语音助手出错"\' -e \'end run\' "va 异常退出（rc=$rc），详情见 ~/.voice-agent/logs/alfred-errors.log"',
  '  fi',
  'fi',
].join('\n');

const UID = {
  fallback: '6C1F7A10-2B7E-4C2A-9D11-0A1B2C3D4E01',
  keyword: '6C1F7A10-2B7E-4C2A-9D11-0A1B2C3D4E02',
  script: '6C1F7A10-2B7E-4C2A-9D11-0A1B2C3D4E03',
  external: '6C1F7A10-2B7E-4C2A-9D11-0A1B2C3D4E04',
};

const conn = (dest: string) => ({ destinationuid: dest, modifiers: 0, modifiersubtext: '', vitoclose: false });

export const workflow = {
  bundleid: `${process.env.VA_BUNDLE_PREFIX ?? 'local.voice-agent'}.voice-agent`,
  category: 'Productivity',
  createdby: process.env.VA_AUTHOR ?? 'voice-agent',
  description: '语音指令助手 v1：⌘Space 唤起 Alfred → Typeless 说一句话 → 回车执行',
  disabled: false,
  name: '语音指令助手',
  readme: `入口一：Alfred 主输入框直接说话，没有本地结果时回车走 Fallback「语音助手」。\n入口二：v <一句话> 强制交给语音助手。\n脚本：~/.voice-agent/bin/va\n日志：~/.voice-agent/logs/`,
  connections: {
    [UID.fallback]: [conn(UID.script)],
    [UID.keyword]: [conn(UID.script)],
    [UID.external]: [conn(UID.script)],
  },
  objects: [
    {
      type: 'alfred.workflow.trigger.fallback',
      uid: UID.fallback,
      version: 1,
      config: { text: "语音助手：'{query}'" },
    },
    {
      type: 'alfred.workflow.input.keyword',
      uid: UID.keyword,
      version: 1,
      config: {
        argumenttype: 0, // 必须带参数
        keyword: KEYWORD,
        subtext: '交给语音助手执行（例：打开飞书 / 查一下我的VPS）',
        text: '语音助手：{query}',
        withspace: true,
      },
    },
    {
      type: 'alfred.workflow.action.script',
      uid: UID.script,
      version: 2,
      config: {
        concurrently: true,
        escaping: 102,
        script: ALFRED_SCRIPT,
        scriptargtype: 1, // 以 argv 传参，不做字符串拼接
        scriptfile: '',
        type: 0, // /bin/bash
      },
    },
    {
      // 外部触发：osascript -e 'tell application id "com.runningwithcrayons.Alfred" to run trigger "va" in workflow "<VA_BUNDLE_PREFIX>.voice-agent" with argument "…"'
      // 用于自检 Alfred 已加载本 workflow，也方便别的自动化调用
      type: 'alfred.workflow.trigger.external',
      uid: UID.external,
      version: 1,
      config: { availableviaurlhandler: false, triggerid: 'va' },
    },
  ],
  uidata: {
    [UID.fallback]: { xpos: 50, ypos: 50, note: '加入 Features > Default Results > Setup fallback results，并拖到第一位' },
    [UID.keyword]: { xpos: 50, ypos: 200, note: '强制入口：v <一句话>' },
    [UID.script]: { xpos: 330, ypos: 120 },
    [UID.external]: { xpos: 50, ypos: 350, note: '外部触发 va（自检/自动化用）' },
  },
  variablesdontexport: [],
  version: '1.1.0',
  webaddress: '',
};

function main(): void {
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  const jsonPath = join(BUILD, 'info.json');
  writeFileSync(jsonPath, JSON.stringify(workflow, null, 2));
  execFileSync('plutil', ['-convert', 'xml1', jsonPath, '-o', join(BUILD, 'info.plist')]);
  rmSync(jsonPath);
  execFileSync('plutil', ['-lint', join(BUILD, 'info.plist')], { stdio: 'inherit' });
  if (existsSync(OUT)) rmSync(OUT);
  execFileSync('zip', ['-q', '-j', OUT, join(BUILD, 'info.plist')]);
  process.stdout.write(`${OUT}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
