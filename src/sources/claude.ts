/** Claude Code transcripts: ~/.claude/projects/<project>/<session>.jsonl (+ <session>/subagents/*.jsonl) */
import { join } from 'node:path';
import { processLine, sessionIdOf } from '../indexer.ts';
import type { IndexSource } from './types.ts';

export const claudeSource: IndexSource = {
  id: 'claude',
  defaultDir: (home) => join(home, '.claude', 'projects'),
  processLine,
  sessionIdOf,
};
