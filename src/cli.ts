import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLog } from './log.ts';
import { runDoctor, SELFTEST_PREFIX, writeSelftestMarker } from './doctor.ts';
import { createRuntime, runner } from './runtime.ts';
import { serveStdio } from './rpc.ts';
import { IndexService } from './index-service.ts';
import { loadConfig, resolvePaths } from './config.ts';
import { detectLocale, setDefaultOutputLocale, tr, uiLocale, withLocale } from './i18n.ts';
import type { RunReport } from './types.ts';
import { isHelpArgs } from './help.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();

const USAGE = `usage:
  va "<sentence>"        handle one sentence (VA_DRY_RUN=1 print only · VA_JSON=1 JSON report · VA_SPEAK=1 speak)
  va doctor              read-only health check
  va serve --stdio       JSON-RPC 2.0 over stdin/stdout (NDJSON), see docs/rpc.md
  va mcp                 MCP server over stdio (search_artifacts / open_artifact / artifact_stats), see docs/mcp.md
`;

const CFG = loadConfig();
const PATHS = resolvePaths(CFG, ROOT, process.env, HOME);
setDefaultOutputLocale(uiLocale(CFG));
const dataDir = (): string => PATHS.dataDir;
const doctorEnv = () => ({ root: PATHS.dataDir, appRoot: ROOT, indexDir: PATHS.indexDir, logDir: PATHS.logDir, home: HOME, run: runner });

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (isHelpArgs(argv)) { process.stdout.write(USAGE); return 0; }   // never sent to the model as a sentence
  if (argv[0] === 'serve') {
    if (!argv.includes('--stdio')) { process.stderr.write(USAGE); return 2; }
    await serveStdio({
      ...doctorEnv(),
      write: (l) => process.stdout.write(`${l}\n`),
      indexer: new IndexService({ root: ROOT, indexDir: PATHS.indexDir }),
      runtime: (dryRun, print) => createRuntime({ root: ROOT, home: HOME, dryRun, print, diag: (l) => process.stderr.write(`${l}\n`) }),
    });
    return 0;
  }
  if (argv[0] === 'mcp' && argv.length === 1) return serveMcpCli();
  const input = argv.join(' ').trim();
  if (!input) {
    process.stderr.write(USAGE);
    return 2;
  }
  // 自检入口（Alfred 外部触发 / va doctor 用）：只写一个标记文件，不调模型、不碰缓存、不执行任何动作
  if (input.startsWith(SELFTEST_PREFIX)) {
    writeSelftestMarker(join(dataDir(), 'logs'), input.slice(SELFTEST_PREFIX.length).trim());
    return 0;
  }
  if (input === 'doctor' || input === '--doctor') return runDoctor(doctorEnv());

  const print = (line: string) => process.stdout.write(`${line}\n`);
  const rt = await createRuntime({ root: ROOT, home: HOME, print });
  const report = await rt.run(input);

  withLocale(detectLocale(input, rt.cfg.locale), () => printReport(input, rt.paths.logDir, report, print));
  return report.layer === 'error' ? 1 : 0;
}

async function serveMcpCli(): Promise<number> {
  // loaded only here: the other commands keep working in a core installed without node_modules
  let mod: typeof import('./mcp.ts');
  try {
    mod = await import('./mcp.ts');
  } catch (e) {
    process.stderr.write(`[va] the MCP server needs its packages: run \`npm ci --omit=dev\` in ${ROOT} (${(e as Error).message.split('\n')[0]})\n`);
    return 1;
  }
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const diag = (l: string) => process.stderr.write(`${l}\n`);
  let rt: ReturnType<typeof createRuntime> | null = null;
  await mod.serveMcp({
    version,
    // one runtime for the session; VA_DRY_RUN=1 = open_artifact only says what it would open
    runtime: () => (rt ??= createRuntime({ root: ROOT, home: HOME, print: diag, diag })),
    indexer: new IndexService({ root: ROOT, indexDir: PATHS.indexDir }),
  });
  return 0;
}

function printReport(_input: string, logDir: string, report: RunReport, print: (l: string) => void): void {
  const logPath = writeLog(logDir, report, new Date());
  if (process.env.VA_JSON === '1') {
    print(JSON.stringify({ ...report, logPath }));
  } else {
    const u = report.usage;
    print(`[${report.layer}] ${report.result}`);
    print(`  tokens=${u.total_tokens} (in ${u.prompt_tokens} / out ${u.completion_tokens}, cache-hit ${u.prompt_cache_hit_tokens ?? 0}) rounds=${report.llmRounds} ${report.durationMs}ms${report.cached ? tr(' → 已写缓存', ' → cached') : report.cacheCandidate ? tr(' → 记为缓存候选（再得到相同规划才写入）', ' → cache candidate (cached once the same plan repeats)') : ''}`);
    for (const c of report.calls) print(`  · ${c.name} ${JSON.stringify(c.args)} → ${c.ok ? 'ok' : 'FAIL'}${c.dryRun ? ' (dry-run)' : ''}`);
  }
}

main().then((code) => process.exit(code), (e: unknown) => {
  // 退出码 3 = 未捕获错误（用户没看到任何反馈）；Alfred 脚本据此写日志 + 弹通知
  process.stderr.write(`[va] 未捕获错误：${(e as Error).message}\n`);
  process.exit(3);
});
