# commands.yaml — custom whitelisted commands

Each command becomes a `run_shell` `command_id`. The model can only pick an id and whitelisted argument
values; the command itself is a fixed argv executed without a shell.

```yaml
commands:
  - id: quota_check                    # [a-z][a-z0-9_]*
    name: Quota                        # label used in messages
    description: Check remaining quota. args: ["home"] (default) or ["work"]    # shown to the model
    examples: [check my quota, how much quota is left at work]                 # appended to the description
    command: [python3, ~/bin/quota.py] # fixed argv; ~ expanded
    args:                              # allowed values for each extra positional argument
      - [home, work]
    default_args: [home]               # used when the model passes none
    confirm: false                     # true → confirmation dialog first; never runs in dry-run
    timeout_ms: 30000
    output:
      json: true                       # parse stdout as JSON for the template
      template: "Quota {host|map:work=Work,*=Home}: {left_gb|fixed:1} GB left (resets {reset|slice:5:16})"
```

Template filters: `fixed:N` (decimals), `slice:A:B` (substring), `map:k=v,…,*=default`. Without `json`, the
template sees `{stdout}`. Without a template the result is `<name>：<stdout>`.

User commands are listed before the builtin ones (`disk_free`, `battery`, `ip_info`, `network_status`) and
cannot replace a builtin id.
