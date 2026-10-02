# Skills (tool plugins)

A skill is one tool the model can call. Builtins live in `skills/builtin/*.ts`; your own go in
`~/.config/voice-agent/skills/*.ts` (also `.mjs` / `.js`) and are discovered at startup.
Files starting with `_` are ignored. A user skill cannot replace a builtin name.

## Shape

```ts
export default (api) => ({
  name: 'open_ticket',                       // [a-z][a-z0-9_]*
  description: 'Open a ticket in the tracker by number. Use for "open ticket 123".',
  parameters: api.obj({ number: { type: 'integer' } }, ['number']),   // JSON Schema object
  readOnly: false,        // true = also runs in dry-run (must not change anything)
  cachePolicy: 'auto',    // 'auto' | 'never' | (args) => …  — 'never' for one-shot side effects
  needsConfirm: false,    // true | (args) => bool — the router asks before exec (unless confirmHandled)
  locale: 'all',          // 'zh' | 'en' | 'all' — which input languages the tool is offered for
  async exec(args, ctx) {
    const url = `https://tracker.example.com/t/${Number(args.number)}`;
    if (ctx.dryRun) return api.plan(ctx, `open ${url}`);
    const r = await ctx.run('open', [url]);
    return r.code === 0 ? { ok: true, display: `Opened ticket ${args.number}` } : { ok: false, display: r.stderr };
  },
});
```

The default export may also be a plain object or an array of them. The function form receives `api`
(`obj`, `str`, `num`, `plan`, `confirmOrPlan`, `osa`, `sayArgs`, `notifyNow`, `DIRS`, …) so the file needs no
import from this repo.

## Rules

- **Data minimization**: if your result contains user content (text, file names, paths, contacts), set
  `modelDisplay` / `modelData` — only those go back to the model when a second round is needed.
- `ctx.run(cmd, args)` is `execFile` (no shell). Never build shell strings from model arguments.
- Irreversible actions: set `needsConfirm`, or call `api.confirmOrPlan` yourself and set `confirmHandled: true`.
- Adding/changing a skill changes `TOOLS_VERSION`, which invalidates old cache entries automatically.

Example: [examples/skills/open_ticket.ts](../examples/skills/open_ticket.ts).
