# AGENT_ORCHESTRATOR.md

How the **main (coordinating) session** runs multi-step work on this project.
Sub-agents don't need this file; they follow `AGENTS.md` and the prompt they're
given. Read this only when you are the session the user talks to.

## Role of the main session

The main chat coordinates; it does not do the bulk work. Keep its context for
decisions, not file contents.

- **Main session does:** plan with the user, turn decisions into `docs/SPEC.md`,
  write agent prompts, read agent reports, run the build + tests, make small
  surgical edits (a one-line default, a doc tweak), update
  `docs/SPEC.md` / `AGENTS.md`, and hand the user a browser checklist.
- **Agents do:** reading reference code and frontend/backend source,
  exploration, and all non-trivial code changes.
- Needle lookups (one grep, one file section) are fine to do directly.

## Choosing agents

- **Opus agents** (`general`, no underscore suffix): design and multi-file work
  -- engine, persistence, lifecycle/focus bugs, new tools, anything needing
  research in the ComfyUI frontend source.
- **Sonnet agents** (`explore_sonnet`): searches and investigation only (where
  is X, how does Y work). **No code changes** -- the codebase is too intricate;
  every code change goes to an opus agent (`general`), even small ones.
- **Start a fresh agent per task.** Resuming an agent (`task_id`) keeps its
  whole history; sessions grew past 400k tokens that way. Resume only for a
  tiny follow-up on work the agent just did.

## Writing agent prompts

Each prompt is self-contained (the agent has no memory of this chat):

1. What the project is, one line, and "Read `docs/SPEC.md` (sections ...) first" --
   point at the sections that are the spec. `AGENTS.md` is injected into every
   agent automatically; don't tell them to read it (you may point at a section
   by name when it matters).
2. The task, with the user's exact decisions and any repro steps.
3. Constraints: never git commit; don't edit `docs/SPEC.md` / `AGENTS.md` / `README.md`
   (report doc suggestions instead); which files are off limits.
4. Verification commands (below).
5. **Report format with a line limit** (e.g. "<= 15 lines: root cause, files,
   test results, browser checklist, doc suggestions").

Write the spec into `docs/SPEC.md` *before* launching agents when two agents (or
frontend + Python) must agree on a contract; then both read the same text.

## Parallel agents

Run agents in parallel only when their files are clearly separable. Tell each:
what the other agent is doing and which files it owns; keep edits to shared
files minimal and re-read them right before editing; run only typecheck + tests,
**not the build** (the coordinator builds once both are done).

## Verification (coordinator runs after agents finish)

```
cd ui && npm run typecheck && npm test && npm run build   # js/ must contain exactly one .js
$env:PYTHONPATH='D:\AITools\StabilityMatrixData\Packages\ComfyUI'
& 'D:\AITools\StabilityMatrixData\Packages\ComfyUI\venv\Scripts\python.exe' -m unittest discover tests
```

Also watch for CRLF line endings. File size: aim < ~500 lines, hard limit 600
(AGENTS.md). No split tasks and no "split while you're here"; don't tell agents
to avoid growing a file below 500 or to put small additions in new modules.
Only a file about to pass 600 gets a minimal split.

## Working with the user

- The user tests in the browser (LiteGraph first, then Nodes 2.0). After each
  piece, give a short summary of what changed, anything surprising, whether a
  ComfyUI restart is needed (Python changed) or a hard refresh is enough, and a
  numbered browser checklist.
- The user makes all commits. Tick `docs/SPEC.md` "Remaining work" checkboxes only after the user
  confirms in the browser ("code done, needs browser check" until then).
- Ask questions in plain text, not via the question tool.
- Push back when an idea has a real cost (e.g. positional output links,
  destructive vs non-destructive transforms); offer a recommendation and the
  trade-off.
- Record every agreed decision by updating the section of `docs/SPEC.md` that describes the behaviour (it is a spec, not a log; no Decisions Log). Keep a one-line "Why:" only where it stops a known mistake.
