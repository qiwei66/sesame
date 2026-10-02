/** read_clipboard: local only; the model sees length/lines, never the text */
import { tr } from '../../src/i18n.ts';
import type { ToolSpec } from '../../src/types.ts';
import { obj, sayArgs } from '../../src/tool-helpers.ts';

export const readClipboardTool: ToolSpec = {
  name: 'read_clipboard',
  description: '读取剪贴板文本。speak_aloud=true 时直接用语音朗读出来（用户说「读出来」就设 true）',
  parameters: obj({ speak_aloud: { type: 'boolean' } }, []),
  readOnly: true,
  async exec(a, ctx) {
    const r = await ctx.run('pbpaste', []);
    const text = r.stdout;
    if (!text.trim()) return { ok: true, display: tr('剪贴板是空的（或不是文本）', 'The clipboard is empty (or not text)') };
    const short = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    if (a.speak_aloud === true) {
      if (ctx.dryRun) ctx.print(tr(`[DRY-RUN] 将执行：say 朗读剪贴板（${text.length} 字）`, `[DRY-RUN] would run: say (read the clipboard aloud, ${text.length} chars)`));
      else await ctx.run('say', sayArgs(text.slice(0, 2000)), { timeoutMs: 300_000 });
    }
    // 发给模型的只有摘要（字数/行数/像不像网址），不给全文
    const lines = text.split('\n').length;
    const looksUrl = /^\s*https?:\/\/\S+\s*$/.test(text);
    return {
      ok: true, display: tr(`剪贴板：${short}`, `Clipboard: ${short}`), data: { text: text.slice(0, 2000), length: text.length },
      modelDisplay: `剪贴板有文本（${text.length} 字，${lines} 行${looksUrl ? '，是一个网址' : ''}）${a.speak_aloud === true ? '，已朗读' : ''}`,
      modelData: { length: text.length, lines, looks_like_url: looksUrl },
    };
  },
};
