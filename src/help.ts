/** `--help` / `-h` / `help` given on its own: print usage and exit (never handled as a sentence, never indexes) */
export function isHelpArgs(argv: readonly string[]): boolean {
  const a = argv.map((s) => s.trim()).filter(Boolean);
  return a.length === 1 && (a[0] === '--help' || a[0] === '-h' || a[0].toLowerCase() === 'help');
}

export const INDEX_USAGE = `usage:
  va-index                 incremental index (only bytes appended since the last run)
  va-index --full          rebuild the index from scratch
  va-index --progress-json stdout = JSON progress lines (used by va serve)
`;
