import { claudeSource } from './claude.ts';
import { codexSource } from './codex.ts';
import type { IndexSource } from './types.ts';

export type { IndexSource } from './types.ts';
export const SOURCES: Record<string, IndexSource> = { claude: claudeSource, codex: codexSource };

/** config `sources: [claude, codex]` → [{source, dir}] (unknown ids are ignored; VA_PROJECTS_DIR overrides claude's dir) */
export function resolveSources(ids: string[], home: string, env: NodeJS.ProcessEnv = process.env): Array<{ source: IndexSource; dir: string }> {
  const out: Array<{ source: IndexSource; dir: string }> = [];
  for (const id of ids) {
    const s = SOURCES[id];
    if (!s) continue;
    const dir = id === 'claude' && env.VA_PROJECTS_DIR ? env.VA_PROJECTS_DIR : id === 'codex' && env.VA_CODEX_DIR ? env.VA_CODEX_DIR : s.defaultDir(home);
    out.push({ source: s, dir });
  }
  return out;
}
