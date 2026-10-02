/**
 * User skills: every *.ts / *.mjs / *.js file in <configDir>/skills/ is imported at startup.
 * A skill module's default export is either
 *   - a ToolSpec, or an array of ToolSpec, or
 *   - a function (api) => ToolSpec | ToolSpec[] — `api` carries the helpers (so the file needs no import
 *     from this repo and keeps working wherever the repo is installed).
 * See docs/skills.md and examples/skills/.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as helpers from './tool-helpers.ts';
import type { ToolSpec } from './types.ts';

export const SKILL_API = { ...helpers, version: 1 } as const;
export type SkillApi = typeof SKILL_API;

export interface LoadedSkills { specs: ToolSpec[]; errors: Array<{ file: string; error: string }> }

function isSpec(v: unknown): v is ToolSpec {
  return Boolean(v && typeof v === 'object' && typeof (v as ToolSpec).name === 'string' && typeof (v as ToolSpec).exec === 'function' && (v as ToolSpec).parameters);
}

export async function loadUserSkills(configDir: string): Promise<LoadedSkills> {
  const dir = join(configDir, 'skills');
  const out: LoadedSkills = { specs: [], errors: [] };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ts|mjs|js)$/.test(f) || f.endsWith('.d.ts') || f.startsWith('_')) continue;
    const file = join(dir, f);
    try {
      const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
      let v = mod.default;
      if (typeof v === 'function') v = (v as (api: SkillApi) => unknown)(SKILL_API);
      const list = Array.isArray(v) ? v : [v];
      for (const s of list) {
        if (!isSpec(s)) throw new Error('default export is not a ToolSpec (needs name, parameters, exec)');
        s.origin = `user:${file}`;
        s.readOnly ??= false;
        out.specs.push(s);
      }
    } catch (e) {
      out.errors.push({ file, error: (e as Error).message });
    }
  }
  return out;
}
