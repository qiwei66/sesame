/** search_files (Spotlight, 3 allowed dirs) and trash_files (confirm first) */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tr } from '../../src/i18n.ts';
import type { ToolSpec } from '../../src/types.ts';
import { confirmOrPlan, DIR_KEYS, DIRS, dirPath, obj, osa, str } from '../../src/tool-helpers.ts';
import type { DirKey } from '../../src/tool-helpers.ts';

const sanitizeMd = (s: string) => s.replace(/["*\\'()&|=<>!$]/g, '').trim();

export function buildMdfindQuery(p: { name_contains?: string; extension?: string; added_days_ago?: number; added_within_days?: number }): string {
  const parts: string[] = [];
  const name = sanitizeMd(p.name_contains ?? '');
  const ext = sanitizeMd((p.extension ?? '').replace(/^\./, '')).toLowerCase();
  if (name) parts.push(`kMDItemFSName == "*${name}*"cd`);
  if (ext) parts.push(`kMDItemFSName == "*.${ext}"c`);
  if (typeof p.added_days_ago === 'number' && p.added_days_ago >= 0) {
    const n = Math.floor(p.added_days_ago);
    parts.push(`kMDItemDateAdded >= $time.today(-${n})`);
    parts.push(n === 0 ? 'kMDItemDateAdded < $time.today(+1)' : n === 1 ? 'kMDItemDateAdded < $time.today' : `kMDItemDateAdded < $time.today(-${n - 1})`);
  } else if (typeof p.added_within_days === 'number' && p.added_within_days > 0) {
    parts.push(`kMDItemDateAdded >= $time.today(-${Math.floor(p.added_within_days)})`);
  }
  return parts.length ? parts.join(' && ') : 'kMDItemFSName == "*"';
}

export const searchFilesTool: ToolSpec = {
  name: 'search_files',
  description: '在 下载/文稿/桌面 三个目录之一里用 Spotlight 找文件。时间用相对天数：昨天 added_days_ago=1，今天 0；最近 N 天用 added_within_days',
  parameters: obj({
    dir: { type: 'string', enum: DIR_KEYS },
    name_contains: { type: 'string', description: '文件名包含的关键词（可选）' },
    extension: { type: 'string', description: '扩展名，如 pdf、dmg（可选）' },
    added_days_ago: { type: 'integer', description: '恰好是几天前加进来的：今天0、昨天1（可选）' },
    added_within_days: { type: 'integer', description: '最近几天内加进来的（可选）' },
  }, ['dir']),
  readOnly: true,
  async exec(a, ctx) {
    const dir = dirPath(ctx, a.dir);
    if (!dir) return { ok: false, display: tr(`只能在 ${DIR_KEYS.join('/')} 里找`, `Can only search in ${DIR_KEYS.join('/')}`) };
    const q = buildMdfindQuery({
      name_contains: str(a.name_contains),
      extension: str(a.extension),
      added_days_ago: typeof a.added_days_ago === 'number' ? a.added_days_ago : undefined,
      added_within_days: typeof a.added_within_days === 'number' ? a.added_within_days : undefined,
    });
    const r = await ctx.run('mdfind', ['-onlyin', dir, q], { timeoutMs: 20_000 });
    if (r.code !== 0) return { ok: false, display: tr(`搜索失败：${r.stderr.trim()}`, `Search failed: ${r.stderr.trim()}`) };
    const files = r.stdout.split('\n').filter(Boolean);
    const names = files.slice(0, 5).map((f) => f.split('/').pop() ?? f);
    const display = files.length === 0
      ? tr(`在 ${DIRS[a.dir as DirKey]} 里没找到符合条件的文件`, `No matching files in ${DIRS[a.dir as DirKey]}`)
      : tr(`在 ${DIRS[a.dir as DirKey]} 找到 ${files.length} 个：${names.join('、')}${files.length > 5 ? ' …' : ''}`, `Found ${files.length} in ${DIRS[a.dir as DirKey]}: ${names.join(', ')}${files.length > 5 ? ' …' : ''}`);
    // 发给模型的只有数量与扩展名分布，不给文件名和完整路径（数据边界，见 CLAUDE.md）
    const byExt: Record<string, number> = {};
    for (const f of files) {
      const e = (f.split('/').pop() ?? '').split('.').slice(1).pop()?.toLowerCase() || '(无扩展名)';
      byExt[e] = (byExt[e] ?? 0) + 1;
    }
    return {
      ok: true, display, data: { query: q, count: files.length, files: files.slice(0, 20) },
      modelDisplay: `在 ${DIRS[a.dir as DirKey]} 找到 ${files.length} 个文件`, modelData: { count: files.length, by_extension: byExt },
    };
  },
};


export const trashFilesTool: ToolSpec = {
  name: 'trash_files',
  needsConfirm: true,
  confirmHandled: true,
  description: '把 下载/文稿/桌面 目录（只看第一层）里某扩展名的文件移到废纸篓。不可逆操作，会先弹窗让用户确认',
  parameters: obj({
    dir: { type: 'string', enum: DIR_KEYS },
    extension: { type: 'string', description: '扩展名，如 dmg' },
  }, ['dir', 'extension']),
  readOnly: false,
  async exec(a, ctx) {
    const dir = dirPath(ctx, a.dir);
    const ext = sanitizeMd(str(a.extension).replace(/^\./, '')).toLowerCase();
    if (!dir || !ext) return { ok: false, display: tr('目录或扩展名不合法', 'Invalid folder or extension') };
    const entries = await readdir(dir).catch(() => [] as string[]);
    const files: string[] = [];
    for (const e of entries) {
      if (!e.toLowerCase().endsWith(`.${ext}`)) continue;
      const full = join(dir, e);
      const s = await stat(full).catch(() => null);
      if (s) files.push(full);
    }
    if (files.length === 0) return { ok: true, display: tr(`${DIRS[a.dir as DirKey]} 里没有 .${ext} 文件`, `No .${ext} files in ${DIRS[a.dir as DirKey]}`) };
    const names = files.map((f) => f.split('/').pop() ?? f);
    const list = names.length > 6 ? tr(`${names.slice(0, 6).join('、')} 等 ${names.length} 个`, `${names.slice(0, 6).join(', ')} and ${names.length - 6} more`) : tr(names.join('、'), names.join(', '));
    const what = tr(`把 ${DIRS[a.dir as DirKey]} 里 ${files.length} 个 .${ext} 移到废纸篓：${list}`, `move ${files.length} .${ext} file(s) in ${DIRS[a.dir as DirKey]} to the Trash: ${list}`);
    const c = await confirmOrPlan(ctx, tr(`确定${what}？`, `Really ${what}?`), what);
    if (c === 'dry') return { ok: true, display: tr(`（演练）确认后${what}`, `(dry run) after confirmation: ${what}`), dryRun: true, data: { files } };
    if (c === 'no') return { ok: true, display: tr('已取消删除', 'Deletion cancelled') };
    const script = `on run argv
repeat with p in argv
tell application "Finder" to delete (POSIX file (p as text) as alias)
end repeat
end run`;
    const r = await osa(ctx, script, files);
    return r.ok ? { ok: true, display: tr(`已把 ${files.length} 个 .${ext} 移到废纸篓`, `Moved ${files.length} .${ext} file(s) to the Trash`) } : { ok: false, display: tr(`删除失败：${r.err}`, `Delete failed: ${r.err}`) };
  },
};
