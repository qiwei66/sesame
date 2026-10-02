/**
 * Index source plugin: where conversation transcripts live and how to pull links/files out of one line.
 * Sources are read-only: the indexer never writes inside a source directory.
 */
import type { FileState, LineResult } from '../indexer.ts';

export interface IndexSource {
  /** config `sources:` id */
  id: string;
  /** Default transcript root (absolute) for this home directory */
  defaultDir(home: string): string;
  /** Only files for which this returns true are read (default: *.jsonl) */
  accept?(path: string): boolean;
  /** Parse one JSONL line; `st` is per-file state shared across lines */
  processLine(line: string, st: FileState): LineResult;
  /** Conversation id of a transcript file (used for "same session" keyword boosting) */
  sessionIdOf(path: string): string;
}
