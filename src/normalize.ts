/**
 * 缓存键归一化：只做「字面」层面的清洗，不做任何语义/模糊匹配（避免误触发）。
 * 规则：
 *  1. NFKC（全角→半角，兼容字符统一）+ 英文转小写
 *  2. 去掉所有标点、符号与空白
 *  3. 去掉句首礼貌/口头前缀（帮我、请、麻烦…），句尾语气词（吧、呢、啊、一下…）
 * 只去「前缀/后缀」，不动句中字符——「打开飞书」与「打开飞书吧」同键，「打开飞书文档」不同键。
 * 语气词表按语言选（src/i18n.ts）：含汉字 → zh，否则 en；config.locale 可强制。
 */
import { getConfig } from './config.ts';
import { packFor } from './i18n.ts';
import type { LocaleSetting } from './i18n.ts';

// Unicode 标点(P)、符号(S)、分隔符/空白(Z) 一律去掉
const PUNCT_RE = /[\p{P}\p{S}\p{Z}\s]+/gu;

function stripRepeated(s: string, list: readonly string[], fromStart: boolean): string {
  // 按长度降序，优先剥长的（「麻烦你」先于「麻烦」）
  const sorted = [...list].sort((a, b) => b.length - a.length);
  let changed = true;
  let out = s;
  while (changed) {
    changed = false;
    for (const w of sorted) {
      if (fromStart ? out.startsWith(w) : out.endsWith(w)) {
        const next = fromStart ? out.slice(w.length) : out.slice(0, out.length - w.length);
        // 剥完不能变空：整句就是「好吧」这种，保持原样以免所有短句都撞同一个空键
        if (next.length === 0) return out;
        out = next;
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function normalize(input: string, locale: LocaleSetting = getConfig().locale): string {
  const pack = packFor(input, locale);
  let s = input.normalize('NFKC').toLowerCase().replace(PUNCT_RE, '');
  s = stripRepeated(s, pack.leadingFillers, true);
  s = stripRepeated(s, pack.trailingFillers, false);
  return s;
}
