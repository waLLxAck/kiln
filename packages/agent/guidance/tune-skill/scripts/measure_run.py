#!/usr/bin/env python3
"""measure_run — the tune-skill tool: what a run cost, and the trial around it.

    measure_run.py                                    live state: project, latest transcripts, open trials
    measure_run.py find <text> [--all] [--show]       transcripts (sessions and subagents) whose calls name <text>
    measure_run.py measure <run> [--from RE] [--to RE] [--commands]
    measure_run.py compare <old-run> <new-run> [--from RE] [--to RE] [--new-from RE] [--new-to RE] [--divide N] [--md]
    measure_run.py check <skill>                      compile the skill's scripts, resolve its links
    measure_run.py trial setup <skill> [--pr N | --target REF | --copy] [--task TEXT] [--fresh]
    measure_run.py trial sync <skill>                 copy the skill's files into its trial worktree
    measure_run.py trial list
    measure_run.py help | <cmd> --help

<run> is a session id, an id prefix, an agent id, or a path to a .jsonl. Agent
transcripts live under <session>/subagents/agent-<id>.jsonl and resolve by id.
--from/--to bound a segment: from the first tool call matching RE to the last
matching --to. Both are case-insensitive regexes tested against
'<tool> <raw command>' — the tool name, a space, then the command / prompt /
path as typed (not JSON, so quotes need no escaping); `--commands` and
`find --show` print exactly that text after a row number. In compare they
bound the OLD run and --new-from/--new-to the new one; --divide scales the old
run when its segment covered several tasks; --md prints the table for a PR body.

Metrics, summed over assistant turns in the segment: turns, tool calls,
minutes (first to last timestamp), active_minutes (the same with every gap
over 5 minutes dropped — idle time between user messages), output tokens, and
input processed (prompt tokens including cache reads: what the model attends to).

<skill> is a skill name — looked up in <cwd>/.claude/skills/<skill> (a repo
skill, trialled in a git worktree) and then ~/.claude/skills/<skill> (a user
skill, trialled as a copy under ~/.claude/skill-trials) — or a path to a skill
directory. --copy trials a repo skill as a copy too, for when its repo may not
be touched; the printed prompt then tells the agent to read the copy's SKILL.md
instead of invoking the live skill.

The project directory defaults to the one Claude Code keeps for the current
working directory (~/.claude/projects/<cwd with separators as dashes>);
--project overrides. All flags are global: --project, --from, --to, --divide,
--pr, --target, --task, --md, --all, --commands, --fresh.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

METRICS = ("turns", "tool_uses", "minutes", "active_minutes", "output", "input_processed")
VALUE_FLAGS = ("--from", "--to", "--new-from", "--new-to", "--divide", "--project", "--pr", "--target", "--task")
BOOL_FLAGS = ("--all", "--show", "--commands", "--md", "--fresh", "--copy", "--help", "-h")
IDLE_GAP_MIN = 5
TRIALS = Path.home() / ".claude" / "skill-trials"
HELP = {
    "find": "find <text> [--all] [--show]\n  --all   search every project under ~/.claude/projects, not just this one\n  --show  print the matching rows under each transcript: row number and call text, ready for --from/--to",
    "measure": "measure <run> [--from RE] [--to RE] [--commands]\n  --from/--to  bound the segment: regex on '<tool> <raw command>', the text --commands prints after the row number\n  --commands   list every tool call in the segment with its row number",
    "compare": "compare <old-run> <new-run> [--from RE] [--to RE] [--new-from RE] [--new-to RE] [--divide N] [--md]\n  --from/--to          bound the OLD run\n  --new-from/--new-to  bound the NEW run (leave the trial agent's report out)\n  --divide N           scale the old run when its segment covered N tasks\n  --md                 print a Markdown table with the caveats for the PR body",
    "check": "check <skill>\n  <skill> is a name (looked up in <cwd>/.claude/skills, then ~/.claude/skills) or a path to a skill directory\n  compiles every .py under the skill, resolves every relative link in its .md files",
    "trial": "trial setup <skill> [--pr N | --target REF | --copy] [--task TEXT] [--fresh]\n  <skill>      a name or a path to a skill directory\n  --pr N       the PR whose head becomes the trial branch (needs gh)\n  --target REF a ref instead (default origin/<default branch>)\n  --copy       no worktree: copy the skill to ~/.claude/skill-trials/<name>; the trial agent reads the copy's SKILL.md\n               (what a user skill gets always, and a repo skill gets when its repo may not be touched)\n  --task TEXT  what the subagent is to do; left as a placeholder otherwise\n  --fresh      discard an existing trial first\ntrial sync <skill>   copy the skill's files from this checkout into the trial worktree (a copy is edited in place)\ntrial list           the trials that exist",
}


# ---------------------------------------------------------------- transcripts

def project_dir(override: str | None) -> Path:
    if override:
        return Path(override)
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(Path.cwd().resolve()))
    return Path.home() / ".claude" / "projects" / slug


def load(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def tool_uses_of(row: dict):
    if row.get("type") != "assistant":
        return []
    content = row.get("message", {}).get("content")
    return [c for c in content if c.get("type") == "tool_use"] if isinstance(content, list) else []


def call_text(call: dict) -> str:
    """The text a tool call is matched and listed by: name, then the raw command."""
    inp = call.get("input", {})
    text = inp.get("command") or inp.get("skill") or inp.get("prompt") or inp.get("file_path") or json.dumps(inp)
    return f"{call['name']} {text}"


def mentions(rows: list[dict], needle: str) -> int:
    """Tool calls and user messages that name the needle. The system-reminder blocks
    (which list every available skill) are stripped, so a name in the catalogue is not a run."""
    n = 0
    for r in rows:
        n += sum(1 for c in tool_uses_of(r) if needle in call_text(c))
        if r.get("type") == "user":
            content = r.get("message", {}).get("content")
            texts = [content] if isinstance(content, str) else [c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text"]
            for t in texts:
                if needle in re.sub(r"<system-reminder>.*?</system-reminder>", "", t, flags=re.S):
                    n += 1
    return n


def ts(row: dict) -> datetime | None:
    t = row.get("timestamp")
    return datetime.fromisoformat(t.replace("Z", "+00:00")) if t else None


def transcripts(proj: Path) -> list[Path]:
    return sorted(list(proj.glob("*.jsonl")) + list(proj.glob("*/subagents/agent-*.jsonl")), key=lambda p: p.stat().st_mtime)


def resolve(run: str, proj: Path) -> Path:
    p = Path(run)
    if p.suffix == ".jsonl" and p.exists():
        return p
    hits = [f for f in proj.glob("*.jsonl") if f.stem.startswith(run)]
    hits += [f for f in proj.glob("*/subagents/agent-*.jsonl") if run in f.stem]
    if len(hits) != 1:
        print(f"error: {len(hits)} transcripts match {run!r}" + (": " + ", ".join(h.name for h in hits[:5]) if hits else ""))
        print("help[1]:")
        print(f"  Run `measure_run.py find <text>` to list transcripts and their ids (subagents show as agent-<id>)")
        sys.exit(1 if not hits else 2)
    return hits[0]


def segment(rows: list[dict], start_re: str | None, end_re: str | None, prefix: str = "--") -> tuple[int, int]:
    start, end = 0, len(rows)
    hint = "patterns match '<tool> <raw command>', the text `--commands` prints after the row number (a space after the tool name, not a pipe; not JSON)"
    if start_re:
        rx = re.compile(start_re, re.I)
        start = next((i for i, r in enumerate(rows) if any(rx.search(call_text(c)) for c in tool_uses_of(r))), None)
        if start is None:
            print(f"error: no tool call matches {prefix}from {start_re!r} — {hint}")
            sys.exit(1)
    if end_re:
        rx = re.compile(end_re, re.I)
        ends = [i for i, r in enumerate(rows) if any(rx.search(call_text(c)) for c in tool_uses_of(r))]
        if not ends:
            print(f"error: no tool call matches {prefix}to {end_re!r} — {hint}")
            sys.exit(1)
        end = ends[-1] + 1
    return start, end


def measure(rows: list[dict]) -> dict:
    m = dict.fromkeys(METRICS, 0)
    first = last = prev = None
    active = 0.0
    for r in rows:
        t = ts(r)
        if t:
            first = first or t
            if prev:
                gap = (t - prev).total_seconds()
                active += gap if gap <= IDLE_GAP_MIN * 60 else 0
            prev = last = t
        if r.get("type") != "assistant":
            continue
        u = r.get("message", {}).get("usage") or {}
        if u:
            m["turns"] += 1
            m["output"] += u.get("output_tokens", 0)
            m["input_processed"] += (u.get("input_tokens", 0) + u.get("cache_read_input_tokens", 0)
                                     + u.get("cache_creation_input_tokens", 0))
        m["tool_uses"] += len(tool_uses_of(r))
    m["minutes"] = round((last - first).total_seconds() / 60, 1) if first and last else 0
    m["active_minutes"] = round(active / 60, 1)
    return m


def fmt(v: float) -> str:
    if isinstance(v, float) and not v.is_integer() and v < 1000:
        return f"{v:.1f}"
    v = int(round(v))
    return f"{v / 1_000_000:.1f}M" if v >= 1_000_000 else f"{v / 1000:.0f}k" if v >= 10_000 else str(v)


def print_metrics(label: str, m: dict) -> None:
    print(f"{label}:")
    for k in METRICS:
        print(f"  {k}: {fmt(m[k])}")
    if m["minutes"] > m["active_minutes"] * 3 and m["minutes"] > 30:
        print(f"  note: minutes is wall clock and {fmt(m['minutes'] - m['active_minutes'])} of it is idle gaps over {IDLE_GAP_MIN} min; compare active_minutes")


def is_open(f: Path) -> bool:
    return datetime.now().timestamp() - f.stat().st_mtime < 120


def run_label(f: Path) -> str:
    return f.stem if f.parent.name != "subagents" else f"{f.parent.parent.name[:8]}/{f.stem}"


# ---------------------------------------------------------------- arguments

def flag(args: list[str], name: str) -> str | None:
    for i, a in enumerate(args):
        if a == name and i + 1 < len(args):
            return args[i + 1]
    return None


def positionals(args: list[str]) -> list[str]:
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
            continue
        if a in VALUE_FLAGS:
            skip = True
            continue
        if a.startswith("-"):
            if a not in BOOL_FLAGS:
                print(f"error: unknown flag {a}")
                print("help[1]:")
                print("  Run `measure_run.py help` for every command and flag")
                sys.exit(2)
            continue
        out.append(a)
    return out


# ---------------------------------------------------------------- commands

def cmd_find(args: list[str], proj: Path) -> int:
    pos = positionals(args)
    if not pos:
        print("usage: measure_run.py find <text> [--all]")
        return 2
    needle = pos[0]
    roots = [proj] if "--all" not in args else [p for p in proj.parent.iterdir() if p.is_dir()]
    found, open_hit = [], False
    for root in roots:
        for f in transcripts(root):
            if needle not in f.read_text(encoding="utf-8", errors="replace"):
                continue
            rows = load(f)
            hits = mentions(rows, needle)
            if not hits:
                continue  # the needle appears only in the skill listing every transcript carries
            m = measure(rows)
            day = datetime.fromtimestamp(f.stat().st_mtime).date()
            label = run_label(f) + (" (open)" if is_open(f) else "")
            open_hit |= is_open(f)
            shown = [(i, call_text(c)) for i, r in enumerate(rows) for c in tool_uses_of(r) if needle in call_text(c)] if "--show" in args else []
            found.append((day, root.name if len(roots) > 1 else "", label, hits, m, shown))
    if not found:
        where = "any project under " + str(proj.parent) if len(roots) > 1 else str(proj)
        print(f"sessions: 0 — nothing in {where} mentions {needle!r}")
        print("help[2]:")
        if len(roots) == 1:
            print(f"  Run `measure_run.py find {needle} --all` to search every project's transcripts")
        print("  Then ask the user where the skill has run (which sessions, which harness) — the one question this loop asks")
        return 0
    cols = "date,project,id,mentions,tool_uses,turns,active_min,output" if len(roots) > 1 else "date,id,mentions,tool_uses,turns,active_min,output"
    print(f"sessions[{len(found)}]{{{cols}}}:")
    for day, root, sid, hits, m, shown in found:
        cells = [str(day)] + ([root] if len(roots) > 1 else []) + [sid, str(hits), str(m["tool_uses"]), str(m["turns"]), fmt(m["active_minutes"]), fmt(m["output"])]
        print("  " + "|".join(cells))
        for i, text in shown[:12]:
            print(f"      row {i}: {text.replace(chr(10), ' ')[:120]}")
        if len(shown) > 12:
            print(f"      … {len(shown) - 12} more matching calls (measure <id> --commands lists them all)")
    print("  mentions: the user's messages and the tool calls naming the needle — the skill catalogue every transcript carries is ignored"
          + ("" if "--show" in args else "; --show prints the matching calls with row numbers"))
    if open_hit:
        print("  note: (open) is the session you are in — it mentions the needle because you typed it; its earlier rows may still be the past run you want, so bound them with --from/--to")
    print("help[1]:")
    print('  Run `measure_run.py measure <id> --from "<first command>" --to "<last command>" --commands` to bound the segment')
    return 0


def cmd_measure(args: list[str], proj: Path) -> int:
    pos = positionals(args)
    if not pos:
        print("usage: measure_run.py measure <run> [--from RE] [--to RE] [--commands]")
        return 2
    path = resolve(pos[0], proj)
    rows = load(path)
    s, e = segment(rows, flag(args, "--from"), flag(args, "--to"))
    seg = rows[s:e]
    print(f"transcript: {path}")
    print(f"segment: rows {s}-{e} of {len(rows)}")
    if s == 0 and e == len(rows) and is_open(path) and path.parent.name != "subagents":
        print("  note: whole transcript, and it is still open — your own calls are counted; bound with --from/--to")
    print_metrics("metrics", measure(seg))
    if "--commands" in args:
        calls = [(i, c) for i, r in enumerate(rows[s:e], s) for c in tool_uses_of(r)]
        print(f"commands[{len(calls)}]{{row,tool input}}: (--from/--to are matched against the text after the row number)")
        for i, c in calls:
            print(f"  {i}|{call_text(c).replace(chr(10), ' ')[:140]}")
        print("help[1]:")
        print("  Classify each line as work or plumbing; the plumbing list with counts is step 0's deliverable")
    else:
        print("help[1]:")
        print(f"  Run `measure_run.py measure {pos[0]} --commands` to list the calls in this segment")
    return 0


def cmd_compare(args: list[str], proj: Path) -> int:
    pos = positionals(args)
    if len(pos) < 2:
        print("usage: measure_run.py compare <old-run> <new-run> [--from RE] [--to RE] [--divide N] [--md]")
        return 2
    old_rows = load(resolve(pos[0], proj))
    s, e = segment(old_rows, flag(args, "--from"), flag(args, "--to"))
    old = measure(old_rows[s:e])
    new_rows = load(resolve(pos[1], proj))
    ns, ne = segment(new_rows, flag(args, "--new-from"), flag(args, "--new-to"), prefix="--new-")
    new = measure(new_rows[ns:ne])
    div = float(flag(args, "--divide") or 1)
    bounded_new = f", new rows {ns}-{ne} of {len(new_rows)}" if (ns, ne) != (0, len(new_rows)) else ""
    rows = []
    for k in METRICS:
        o = old[k] / div
        saving = f"{(1 - new[k] / o) * 100:.0f}%" if o else "n/a"
        rows.append((k, fmt(old[k]), fmt(o), fmt(new[k]), saving))
    if "--md" in args:
        per = " | old ÷ %g" % div if div != 1 else ""
        print(f"| metric | old (rows {s}-{e}){per} | trial | saving |")
        print("|---|---|" + ("---|" if div != 1 else "") + "---|---|")
        for k, o, od, n, sv in rows:
            print(f"| {k} | {o} |" + (f" {od} |" if div != 1 else "") + f" {n} | {sv} |")
        print()
        print(f"Caveats: the old segment (rows {s}-{e}) also carried <what else the old run did there, or 'nothing'>;"
              + (" the trial run is measured whole, so its report and deliverable write are counted;" if not bounded_new else "")
              + " one trial is one data point.")
        if new["tool_uses"] >= old["tool_uses"] / div:
            print("The call count did not fall: say what each call no longer contains (hand arithmetic, a retry, a trap now caught).")
    else:
        print(f"compare{{metric,old,old_per_task,new,saving}}: (old segment rows {s}-{e}{bounded_new}, divided by {div:g})")
        for r in rows:
            print("  " + "|".join(r))
        print("help[2]:")
        print("  Add --md for the table as the PR body carries it, caveats included")
        print("  Add --new-from/--new-to to bound the trial run to the skill's own steps, leaving its report out")
    return 0


# ---------------------------------------------------------------- skills and trials

def git(*a: str, cwd: Path | None = None) -> str:
    r = subprocess.run(["git", *a], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        raise RuntimeError((r.stdout + r.stderr).strip())
    return r.stdout.strip()


def win(p: Path | str) -> str:
    """Forward-slash form of a path: what both shells and the Read/Edit tools accept."""
    return str(p).replace("\\", "/")


def posix(p: Path | str) -> str:
    return re.sub(r"^([A-Za-z]):/", lambda m: f"/{m.group(1).lower()}/", win(p))


def locate_skill(name: str) -> tuple[Path, str] | None:
    """(skill dir, kind) where kind is 'repo' or 'user'; a path to a skill directory is taken as is."""
    p = Path(name)
    if (p / "SKILL.md").exists():
        p = p.resolve()
        try:
            git("rev-parse", "--show-toplevel", cwd=p)
            return p, "repo"
        except RuntimeError:
            return p, "user"
    for base, kind in ((Path.cwd() / ".claude" / "skills", "repo"), (Path.home() / ".claude" / "skills", "user")):
        if (base / name / "SKILL.md").exists():
            return base / name, kind
    return None


def cmd_check(args: list[str], proj: Path) -> int:
    pos = positionals(args)
    if not pos:
        print("usage: measure_run.py check <skill>")
        return 2
    hit = locate_skill(pos[0])
    if not hit:
        print(f"error: no skill {pos[0]!r} under {Path.cwd() / '.claude/skills'} or {Path.home() / '.claude/skills'}")
        return 1
    skill, _ = hit
    fails = 0
    pys = sorted(f for f in skill.rglob("*.py") if "__pycache__" not in f.parts)
    for f in pys:
        try:
            compile(f.read_text(encoding="utf-8"), str(f), "exec")
        except SyntaxError as ex:
            fails += 1
            print(f"compile_error: {f.relative_to(skill)}:{ex.lineno}: {ex.msg}")
    mds = sorted(skill.rglob("*.md"))
    broken = 0
    for md in mds:
        for target in re.findall(r"\]\(([^)#\s]+)", md.read_text(encoding="utf-8", errors="replace")):
            if "://" in target or target.startswith("~"):
                continue
            if not (md.parent / target).exists():
                broken += 1
                print(f"broken_link: {md.relative_to(skill)} -> {target}")
    print(f"skill: {skill}")
    print(f"scripts: {len(pys)} compiled, {fails} failed")
    print(f"links: {len(mds)} files scanned, {broken} broken")
    print("help[1]:")
    print(f"  Run `measure_run.py trial setup {pos[0]}` when the checks are clean")
    return 1 if fails or broken else 0


def trial_dir(name: str, kind: str, repo: Path | None) -> Path:
    return TRIALS / (name if kind == "user" else f"{repo.name}-{name}")


def existing_trials() -> list[tuple[str, Path, str]]:
    out = []
    if TRIALS.exists():
        for d in sorted(TRIALS.iterdir()):
            if not d.is_dir():
                continue
            if (d / ".git").exists():
                try:
                    branch = git("branch", "--show-current", cwd=d)
                except RuntimeError:
                    branch = "?"
                out.append(("worktree", d, branch))
            else:
                out.append(("copy", d, ""))
    return out


def fill_prompt(values: dict) -> str:
    tpl = Path(__file__).resolve().parent.parent / "references" / "trial-prompt.md"
    text = tpl.read_text(encoding="utf-8")
    body = text.split("---", 2)[1] if text.count("---") >= 2 else text
    for k, v in values.items():
        body = body.replace("{" + k + "}", v)
    return body.strip()


def cmd_trial(args: list[str], proj: Path) -> int:
    pos = positionals(args)
    sub = pos[0] if pos else "list"
    if sub == "list":
        rows = existing_trials()
        if not rows:
            print(f"trials: 0 — nothing under {TRIALS}")
        else:
            print(f"trials[{len(rows)}]{{kind,path,branch}}:")
            for kind, d, b in rows:
                print(f"  {kind}|{d}|{b}")
        print("help[1]:")
        print("  Run `measure_run.py trial setup <skill> [--pr N | --target REF] [--task TEXT]` to prepare one")
        return 0
    if sub not in ("setup", "sync") or len(pos) < 2:
        print("usage: measure_run.py trial setup <skill> [--pr N | --target REF] [--task TEXT] [--fresh] | trial sync <skill> | trial list")
        return 2
    name = pos[1]
    hit = locate_skill(name)
    if not hit:
        print(f"error: no skill {name!r} under {Path.cwd() / '.claude/skills'} or {Path.home() / '.claude/skills'}")
        return 1
    skill, kind = hit
    name = skill.name
    repo = None
    if "--copy" in args:
        kind = "user"
    if kind == "repo":
        try:
            repo = Path(git("rev-parse", "--show-toplevel", cwd=skill))
        except RuntimeError as ex:
            print(f"error: {ex}")
            return 1
    dest = trial_dir(name, kind, repo)
    return trial_setup(args, name, skill, kind, repo, dest) if sub == "setup" else trial_sync(skill, kind, repo, dest)


def trial_sync(skill: Path, kind: str, repo: Path | None, dest: Path) -> int:
    if kind == "user":
        print(f"error: the trial of {skill.name} at {dest} is a copy, edited in place — there is nothing to sync")
        return 1
    if not dest.exists():
        print(f"error: no trial at {dest}")
        print("help[1]:")
        print(f"  Run `measure_run.py trial setup {skill.name}` first")
        return 1
    rel = skill.relative_to(repo)
    target = dest / rel
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(skill, target, ignore=shutil.ignore_patterns("__pycache__"))
    copied = sum(1 for _ in target.rglob("*") if _.is_file())
    print(f"synced: {rel} -> {dest} ({copied} files)")
    for extra in ("package.json",):
        src = repo / extra
        if src.exists() and (dest / extra).exists() and src.read_bytes() != (dest / extra).read_bytes():
            print(f"  note: {extra} differs between checkout and trial — copy it by hand if the skill's command lives there")
    print("help[1]:")
    print(f"  Re-run the changed subcommand inside {posix(dest)}")
    return 0


def trial_setup(args: list[str], name: str, skill: Path, kind: str, repo: Path | None, dest: Path) -> int:
    fresh = "--fresh" in args
    task = flag(args, "--task") or "<the skill's job on a real target, named>"
    if dest.exists() and fresh:
        if (dest / ".git").exists() and repo:
            subprocess.run(["git", "worktree", "remove", "--force", str(dest)], cwd=repo, capture_output=True)
        shutil.rmtree(dest, ignore_errors=True)
    TRIALS.mkdir(parents=True, exist_ok=True)
    values = {"skill": name, "task": task, "trial": win(dest), "posix": posix(dest),
              "start": f"Start by invoking the skill with the Skill tool (`{name}`) and follow it as written."}
    if kind == "user":
        if dest.resolve() == skill.resolve():
            print(f"trial: {dest} (this path is already a trial copy — the live skill it came from is not recorded; --task should name it)")
        elif dest.exists():
            print(f"trial: {dest} (exists — --fresh to recopy)")
        else:
            shutil.copytree(skill, dest, ignore=shutil.ignore_patterns("__pycache__"))
            print(f"trial: {dest} (copied from {skill})")
        if flag(args, "--pr"):
            print(f"  note: --pr {flag(args, '--pr')} is ignored for a copy — there is no worktree; name the PR in --task")
        values.update(live=win(skill), branch="", main=win(skill), deliverable=f"{posix(dest)}/TRIAL-RESULT.md")
        values["start"] = (f"The version under test is the copy at `{win(dest)}`: read its `SKILL.md` and follow it as written, "
                           f"running its scripts from that copy wherever it names a command. Do not invoke `{name}` through the Skill tool — "
                           f"that loads the live version at `{win(skill)}`, not the one under test.")
        where = (f"Where to work: the copy of the skill at `{win(dest)}` (Git Bash path `{posix(dest)}`). Edit nothing under it "
                 f"or under `{win(skill)}`; the deliverable goes to the path below.")
    else:
        branch = f"trial/{name}"
        skill_branch = git("branch", "--show-current", cwd=repo) or "HEAD"
        if dest.exists():
            print(f"trial: {dest} (exists on {git('branch', '--show-current', cwd=dest)} — --fresh to rebuild)")
        else:
            pr, target = flag(args, "--pr"), flag(args, "--target")
            try:
                git("fetch", "-q", "origin", cwd=repo)
                if pr:
                    r = subprocess.run(["gh", "api", f"repos/{{owner}}/{{repo}}/pulls/{pr}", "--jq", ".head.ref"], cwd=repo, capture_output=True, text=True)
                    if r.returncode:
                        print(f"error: gh could not resolve PR {pr}: {(r.stdout + r.stderr).strip()}")
                        return 1
                    target = "origin/" + r.stdout.strip()
                    branch = f"trial/{name}-pr{pr}"
                if not target:
                    try:
                        target = git("symbolic-ref", "refs/remotes/origin/HEAD", cwd=repo).replace("refs/remotes/", "")
                    except RuntimeError:
                        target = next((r for r in ("origin/main", "origin/master") if subprocess.run(["git", "rev-parse", "--verify", "-q", r], cwd=repo, capture_output=True).returncode == 0), None)
                        if not target:
                            print("error: origin has no HEAD, main or master — pass --target REF")
                            return 1
                git("worktree", "add", "-q", "-B", branch, str(dest), target, cwd=repo)
                print(f"trial: {dest} (branch {branch} from {target})")
                try:
                    git("merge", "-q", "--no-edit", "-Xrenormalize", skill_branch, cwd=dest)
                    print(f"merged: {skill_branch}")
                except RuntimeError as ex:
                    print(f"merge_conflict: {ex.splitlines()[-1] if ex else 'see git status in the trial'} — resolve in {dest} before spawning")
            except RuntimeError as ex:
                print(f"error: {ex}")
                return 1
            for cfg in (".env.local", ".env"):
                if (repo / cfg).exists() and not (dest / cfg).exists():
                    shutil.copy2(repo / cfg, dest / cfg)
                    print(f"copied: {cfg}")
            installer = next((cmd for lock, cmd in (("bun.lock", "bun install"), ("bun.lockb", "bun install"), ("pnpm-lock.yaml", "pnpm install"),
                                                     ("yarn.lock", "yarn install"), ("package-lock.json", "npm ci"), ("uv.lock", "uv sync")) if (dest / lock).exists()), None)
            if installer:
                r = subprocess.run(installer, cwd=dest, shell=True, capture_output=True, text=True)
                print(f"installed: {installer}" + ("" if r.returncode == 0 else f" FAILED: {(r.stdout + r.stderr).strip()[-300:]}"))
        values.update(branch=git("branch", "--show-current", cwd=dest), main=win(repo), live=win(skill),
                      deliverable=f"{posix(dest)}/TRIAL-RESULT.md")
        where = (f"Where to work: the worktree `{win(dest)}` (Git Bash path `{posix(dest)}`), on local branch `{values['branch']}`, "
                 f"which is the target with the skill's tooling merged in. Dependencies are installed and configuration is in place. "
                 f"Run every command from inside that worktree (`cd {posix(dest)} && ...` at the start of each Bash call, since cwd does not persist). "
                 f"Do not touch `{win(repo)}` or any other worktree.")
    values["where"] = where
    print()
    print("prompt: (paste as the Agent prompt; fill anything still in <angle brackets>)")
    print("----")
    print(fill_prompt(values))
    print("----")
    print("help[2]:")
    print(f"  Spawn a general-purpose subagent, foreground, with the prompt above; do not coach it mid-run")
    print(f"  Run `measure_run.py trial sync {name}` after each fix to carry it into the trial" if kind == "repo" else
          f"  Fix in {win(dest)} during the trial; diff it against {win(skill)} afterwards and carry the diff home")
    return 0


def cmd_dashboard(proj: Path) -> int:
    print(f"project: {proj}" + ("" if proj.exists() else " (missing — pass --project)"))
    if proj.exists():
        files = transcripts(proj)
        print(f"transcripts: {len(files)} ({sum(1 for f in files if f.parent.name == 'subagents')} subagent)")
        print("latest[3]{date,id,tool_uses,active_min}:")
        for f in files[-3:][::-1]:
            m = measure(load(f))
            print(f"  {datetime.fromtimestamp(f.stat().st_mtime).date()}|{run_label(f)}{' (open)' if is_open(f) else ''}|{m['tool_uses']}|{fmt(m['active_minutes'])}")
    rows = existing_trials()
    print(f"trials: {len(rows)}" + (" — none under " + str(TRIALS) if not rows else ""))
    for kind, d, b in rows:
        print(f"  {kind}|{d}|{b}")
    print("help[3]:")
    print("  Run `measure_run.py find <skill-name>` to list the runs of a skill")
    print("  Run `measure_run.py check <skill>` before a trial; `trial setup <skill> --pr N` to prepare it")
    print("  Run `measure_run.py help` for every command and flag")
    return 0


def main(argv: list[str]) -> int:
    if argv and argv[0] in ("-h", "--help", "help"):
        if len(argv) > 1 and argv[1] in HELP:
            print(HELP[argv[1]])
        else:
            print(__doc__.strip())
        return 0
    if len(argv) > 1 and argv[0] in HELP and argv[1] in ("-h", "--help"):
        print(HELP[argv[0]])
        return 0
    proj = project_dir(flag(argv, "--project"))
    if not argv or (len(argv) == 2 and argv[0] == "--project"):
        return cmd_dashboard(proj)
    if not proj.exists() and argv[0] in ("find", "measure", "compare"):
        print(f"error: no project directory at {proj} — pass --project")
        return 1
    cmds = {"find": cmd_find, "measure": cmd_measure, "compare": cmd_compare, "check": cmd_check, "trial": cmd_trial}
    fn = cmds.get(argv[0])
    if fn is None:
        print(f"error: unknown command {argv[0]!r}; commands: {', '.join(cmds)}")
        return 2
    return fn(argv[1:], proj)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
