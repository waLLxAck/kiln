---
name: tune-skill
description: >-
  Cut what a skill costs to run — tool calls, tokens, minutes — by measuring a
  past run, rewriting the document, moving its plumbing into one command, and
  field-testing it with a subagent whose friction log drives the fixes. Use it
  when a skill takes too many iterations to be worth running, or before
  publishing a new skill that agents will run unattended.
---

# Tune a skill

A skill is judged by what a run costs and where the agent stumbles, not by how
it reads. The loop: **measure → rewrite → mechanize → trial → fix → re-measure**.
Every stage ends in a number or a list; opinion is not an exit condition.

Two words carry the loop. **Plumbing** is every call the agent spends on
nothing the deliverable will show: re-typed paths and env, port juggling,
finding a working screenshot method, reading a tool's source to learn a flag.
The **friction log** is the trial agent's blunt account of where it was slowed,
one entry per stumble, with the command and the attempt count.

**Budget.** One pass through the loop is one trial and one fix round — about
40 tool calls and 25 minutes. A second trial is earned only by three or more
non-cosmetic friction entries surviving the fix round; there is no third in one
session. If you are past twice the budget and still in step 2, stop and report
what is built: the trial is the point, and a run the rate limit ends mid-trial
yields no friction log at all.

Every command below is a subcommand of one tool, run from the project whose
transcripts you measure (or with `--project`):

```bash
M="python <skill-dir>/scripts/measure_run.py"   # in a repo: .claude/skills/tune-skill
$M            # live state: project, latest transcripts, open trials
$M help       # every command and flag
```

## 0. Measure a past run

```bash
$M find <skill-name>
$M measure <run> --from "<regex>" --to "<regex>" --commands
```

`find` lists the transcripts — sessions and their subagents — in this project
that mention the skill, with call counts; `--all` searches every project on the
machine. Only when both return nothing do you ask the user where the skill has
run — which sessions, or which other harness holds the history — and that is
the one question this loop puts to them. `measure` prints turns, tool calls,
wall and active minutes, output tokens and input processed for the segment
between the first call matching `--from` and the last matching `--to`;
`--commands` lists every call so you can classify it.

Read the command list and write the **plumbing list**: each thing the agent
re-typed, retried or hunted for, with a count. That list is the specification
for step 2, and the baseline row of the final table.

**A run of five calls or fewer is not worth this loop.** The cost lives inside
the calls (hand arithmetic, a trap nobody wrote down), and no trial will show a
saving in the table. Say so and stop, or name a different objective — the traps
the plumbing list exposes — and carry that word through to step 5 instead of the
call count.

Done when you hold the baseline numbers and a plumbing list with counts, or a
one-line verdict that the skill is already cheap.

## 1. Rewrite the document

Invoke `writing-for-agents` and apply it to the skill: steps with checkable
completion criteria, reference disclosed behind pointers, no-ops deleted,
leading words in place of restated triads. Anything the plumbing list shows the
agent doing by hand is a candidate to leave the document entirely and become a
subcommand in step 2 — prose that says *how* to do plumbing is the sediment
this loop removes.

Done when every step ends on a criterion the agent can check, and the document
carries no instruction the tool of step 2 will perform.

## 2. Mechanize the plumbing

One script, one command, subcommands for each plumbing item — never a menu of
snippets to paste. The design rules are in
[`references/axi-principles.md`](references/axi-principles.md); the short form:
running it with no arguments prints live state, not usage; every result is
`key: value` lines ending in `help[]` with the next command; an empty result
says so; errors go to stdout with exit 1, usage errors exit 2; nothing prompts;
mutations are idempotent; the tool reads its own configuration (`.env.local`,
`package.json`, the directory layout) so the agent exports nothing.

Knowledge acts better than it reads: a gotcha the old document explained in a
paragraph becomes a line the tool prints when the condition holds.

Every subcommand traces to one plumbing-list item or, later, one friction entry;
a subcommand with neither is sprawl, and a tool that doubles in a round is the
warning sign. Step 5 reports the script's line count beside the run's cost.

`$M check <skill-name>` compiles the skill's scripts and resolves every link
in its documents; run it after each edit. Run every subcommand yourself,
including its failure paths, before the trial. A subcommand whose work is a
mutation you may not perform for real (a label, a push, a comment) runs against
a stand-in — a shim `gh` on `PATH`, a scratch repo — and the PR says so.

Done when each plumbing-list item maps to a subcommand, `check` is clean, and
each subcommand has been run once and failed once on purpose.

## 3. Trial with a subagent

```bash
$M trial setup <skill-name> --pr <n> --task "<the job, on its real target>"
```

`trial setup` builds the isolated worktree — the target's head with your skill
branch merged, config copied, dependencies installed — and prints the prompt
from [`references/trial-prompt.md`](references/trial-prompt.md) filled in. A
skill under `~/.claude/skills`, or a repo skill whose repo may not gain a
worktree (`--copy`), is trialled as a copy under `~/.claude/skill-trials`; the
prompt then sends the agent to the copy's `SKILL.md` rather than the Skill
tool. Give it to a fresh `general-purpose` subagent, foreground, with a real
target: a real PR, a real incident, the task the skill exists for. For a skill
whose job is other skills, the target is a small skill with several past runs
and a cost worth cutting — step 0's gate applies to the target too. The prompt
asks for the deliverable and the friction log and forbids nothing about how to
work: the point is to watch it stumble.

Do not coach it mid-run. Record its `tool_uses`, tokens and duration from the
completion notice, and the agent id it names.

Done when the agent's report is in hand with a friction log and call counts.

## 4. Fix from the friction log

Take each entry in turn. Prefer the tool over the document: an output line that
fires when the condition holds beats a sentence the agent has to remember. Where
the entry is a domain trap (a table keyed differently than its name suggests,
a marker that every healthy page carries), put the fact where the agent meets it
— the dashboard, the error message — not in a reference file.

`$M trial sync <skill-name>` carries each fix into the trial worktree; re-run
the changed subcommand there as well as in your checkout. A copy is fixed in
place and its diff carried home afterwards.

Done when every entry has a fix or a written reason it stays, and every fix has
been executed once where the trial ran.

## 5. Re-measure and record

```bash
$M measure <agent-id> --commands
$M compare <old-session> <agent-id> --from ... --to ... --new-to ... --divide 2 --md
```

`compare` prints both runs and the saving per metric; `--divide` scales the old
run when its segment covered more than one task; `--new-from/--new-to` bound
the trial to the skill's own steps, leaving its report out; `--md` prints the
table as the PR body carries it, with the two caveats it always needs: what
else the old segment carried, and that one trial is one data point. When the
call count did not fall, the table gains a row for what each call no longer
contains — hand arithmetic, a retry, a trap now caught. Beside the table, the
tool's line count before and after. A skill with no repo puts the table in the
final report instead.

The exit is the budget's: a second trial only if three or more non-cosmetic
entries survived step 4, and its report is the last thing this session does.

Done when the PR or report carries before/after numbers computed the same way
for both runs.
