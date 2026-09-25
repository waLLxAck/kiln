# Screenshots

Real screenshots of Kiln 0.18.2 on Windows, 1440 × 900, for the README and the website. They show a fictional demo library: the user, projects, video and channel are invented, and the two prompts are the examples from the marketing site.

| File | Caption |
| --- | --- |
| [skill-installs.png](skill-installs.png) | A skill with one install switch per location, and each folder it is in, including a copy edited outside Kiln. |
| [drift-compare.png](drift-compare.png) | An older copy found in the shared Agents folder, compared line by line with the approved version. |
| [video-distilled.png](video-distilled.png) | A YouTube video distilled into a prompt, techniques, an insight and a tool, each linked to its minute in the video. |
| [experiment-result.png](experiment-result.png) | The distilled prompt tested read-only on a local project, with the agent’s output and a pass verdict for that exact revision. |
| [test-dialog.png](test-dialog.png) | Test runs the exact revision read-only on a project you choose, with Codex or Claude Code. |
| [config-files.png](config-files.png) | Agent instructions, permissions and hooks in one editor, with syntax checks and previous versions. |
| [ask-agent-dark.png](ask-agent-dark.png) | Asking the agent about a distilled prompt: it answers from the video’s transcript and your library. Dark theme. |

## How they are made

The [Screenshots workflow](../../.github/workflows/screenshots.yml) runs [tests/screenshots/app.spec.ts](../../tests/screenshots/app.spec.ts) on a Windows runner when the `screenshots` branch is pushed, or by hand, and uploads the PNGs as the `screenshots` artifact. The spec builds a demo machine with its home folder at `C:\Users\dev`, launches the built app and fills the library through the app's own API. Agent runs go through Kiln's real Claude Code and yt-dlp code paths, answered by scripted stand-ins in `tests/screenshots/stubs/`, so no model or network is used. The agent's replies are therefore written for the demo, not produced by a model.

The images here were losslessly recompressed. On a machine without a display, `npx tsx tests/screenshots/preview.ts` renders the same views in headless Chromium against the real backend, with Linux paths, to check data and navigation before a Windows run.
