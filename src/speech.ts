/** 朗读用的简短版：去掉演练前缀，取第一句，最多 40 字 */
export function shortForSpeech(text: string): string {
  const t = text.replace(/（演练）/g, '').replace(/\s+/g, ' ').trim();
  const first = t.split(/[。；\n]/)[0] ?? t;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}
