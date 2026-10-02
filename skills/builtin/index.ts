/**
 * Builtin skills, in the order they are offered to the model (order is part of TOOLS_VERSION).
 * User skills (~/.config/voice-agent/skills/*.ts) are appended after these.
 */
import type { ToolSpec } from '../../src/types.ts';
import { openAppTool } from './apps.ts';
import { openUrlTool } from './web.ts';
import { openSavedTool, saveAliasTool } from './saved.ts';
import { runShellTool } from './shell.ts';
import { applescriptTool } from './applescript.ts';
import { searchFilesTool, trashFilesTool } from './files.ts';
import { readClipboardTool } from './clipboard.ts';
import { notifyTool, speakTool } from './feedback.ts';
import { unsupportedTool } from './unsupported.ts';

export function builtinSkills(): ToolSpec[] {
  return [openAppTool, openUrlTool, openSavedTool, saveAliasTool, runShellTool, applescriptTool, searchFilesTool, trashFilesTool, readClipboardTool, notifyTool, speakTool, unsupportedTool];
}

for (const t of builtinSkills()) t.origin ??= 'builtin';
