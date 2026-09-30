# Agent-ergonomic command design

Distilled from [axi.md](https://axi.md/), which benchmarks CLIs built for
agents against MCP servers and stock CLIs and finds the cost lives in turns:
a task that needs eleven round trips costs eleven times the context of one
that needs two. The ten principles, grouped, with what each means for a skill
script.

## Efficiency

1. **Token-efficient output.** `key: value` lines and `name[N]{cols}:` headers
   over JSON; no braces, quotes or commas the reader does not need.
2. **Minimal default schema.** Three or four fields per item by default; a flag
   (`--full`, `--fields`) for the rest.
3. **Truncate with a size hint.** `text: … (800 of 2336 chars — --full for all)`
   beats a silent cut and beats a wall of text.

## Robustness

4. **Pre-computed aggregates.** Report the total, not the page; fold the
   derived check into the output (`349 pass, 0 fail`) so it costs no second
   call.
5. **Definitive empty states.** `rows: 0 — the query ran and matched nothing`.
   Silence is indistinguishable from failure.
6. **Structured errors, clean exits.** Errors on stdout as `error: …`; exit 0
   success, 1 failure, 2 usage; unknown flags fail loud; never prompt;
   mutations idempotent so a retry is safe.

## Discoverability

7. **Ambient context.** State the agent needs before acting arrives before it
   acts — a session hook, or the no-argument dashboard the skill tells it to
   run first.
8. **Content first.** No arguments prints live, actionable state, not usage.
9. **Contextual disclosure.** End every output with `help[]` lines naming the
   next command as a template, runtime values left as `<id>` placeholders.
10. **One way to get help.** `help` and `<cmd> --help` list every flag, so the
    agent never reads the source to find one.

## Beyond the ten, from the trials

- **Combine what the agent always does in sequence.** Start-server-then-wait,
  screenshot-then-verify, swap-run-swap-back-verify: one subcommand each. The
  eleven-turn extraction became two turns this way.
- **Read your own configuration.** The tool parses `.env.local`, finds the
  browser, resolves the ports. Every export the agent has to type is a call
  spent, and the one it forgets is a false negative.
- **Know your worktree.** Several checkouts share one machine; a server or a
  file the tool did not create for *this* tree is refused with a reason, not
  used by default.
- **Print the trap where it bites.** The domain fact that cost three queries
  (a table keyed by a different id than its name says) belongs on the dashboard
  line about that table.
- **Scan wider than you expect.** A port range the agent might not pick is a
  server the dashboard cannot see. Remember what you started; look there too.
- **Shell-friendly paths.** Git Bash rewrites a leading `/path`; accept the
  slashless form and undo the rewrite rather than documenting it. Native
  Python never sees `/tmp` or `/c/…` at all — a path that crosses from the
  shell into the script goes through `C:/…`, and the script prints paths the
  same way.
