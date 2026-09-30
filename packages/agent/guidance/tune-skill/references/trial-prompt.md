# The trial prompt

`measure_run.py trial setup <skill>` prepares the worktree (or the copy, for a
skill under `~/.claude/skills` or with `--copy`) and prints this template filled
in. In a worktree the agent invokes the skill through the Skill tool, since the
worktree carries the version under test; for a copy it reads the copy's
`SKILL.md`, since the Skill tool would load the live version instead. Spawn a
`general-purpose` subagent, foreground, with the printed text. Keep the
three-part report and the bluntness clause when you edit it: they are what
turns a run into data.

Placeholders in braces are filled by the tool; anything left in angle brackets
is yours to fill before spawning.

---

You are {task} using the `{skill}` skill. {start}

{where} Note: <anything already running on the machine that could be mistaken
for yours, or "nothing else is running">.

Publishing is out of scope for this run. Do everything the skill says EXCEPT:
do not `git push`, do not edit the PR or issue on GitHub, do not create issues.
Instead write the finished deliverable to `{deliverable}`. <Any harmless
external step that is allowed, e.g. image upload.>

When finished, your final message must contain three parts:

1. **Result**: the path of the deliverable, and the skill's own summary table
   (e.g. claim / before / after / how observed).
2. **Step-by-step account**: for each of the skill's steps, what you did, what
   its completion criterion was, and whether you met it.
3. **Friction log**: this is the main reason you are being run. For every point
   where you were slowed down, record: what you were trying to do, the exact
   command, what happened, how many attempts it took, and what in SKILL.md, its
   references, or the tool's output was unclear, wrong, missing, or impossible
   in your position. Include places where you ignored the skill and did
   something by hand, and why. Report the total number of tool calls you made,
   split between the task and plumbing. Be blunt; do not soften.

---

Leave the worktree in place after the run: the deliverable and any probe the
agent wrote are evidence for step 4.
