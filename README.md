# lp-task-scheduler

A [loopengine](https://github.com/loopengine-co/loopengine) ability: a
`schedule_task`/`list_scheduled_tasks`/`check_scheduled_task`/
`cancel_scheduled_task` tool set that fires a message into any agent in
the project later — once at a given time, or on a recurring interval —
the same way a cron job runs a command on a timer, plus a skill on how
to use it.

## What's in it

- **Tool** — `schedule_task(agent, message, schedule, task_name?)`.
  `schedule` is either `{ "run_at": "<ISO 8601 timestamp>" }` (fires
  once) or `{ "every": "<interval>" }` (fires repeatedly forever until
  cancelled — a number plus `s`/`m`/`h`/`d`, e.g. `"30s"`, `"15m"`,
  `"1h"`, `"1d"`; not real cron-expression syntax). Returns
  `{ task_id, agent, next_run_at }` immediately — the message itself
  fires later, in the background, independent of whatever conversation
  created it. The target agent runs exactly as if a user had sent that
  message, with one real difference: no human is *live in the
  conversation* when it fires unattended. What happens to an "ask"
  decision then depends on the target agent's own config: with no
  `httpNotifier` set, it auto-resolves immediately (denied / a fixed
  "no human available" answer) rather than hanging forever on someone
  who was never going to answer; with one configured (a webhook, Slack,
  ...), it becomes a *real* durable approval instead — the run genuinely
  pauses (`status: "awaiting_approval"`) until a human decides there,
  same as any other durably-gated call in this framework.
- **Tool** — `list_scheduled_tasks(status?)`. Every scheduled task
  across every agent in the project — summary fields only
  (`task_id`, `agent`, `schedule`, `status`, `next_run_at`, `run_count`,
  `last_status`); call `check_scheduled_task` for one task's own full
  run history.
- **Tool** — `check_scheduled_task(task_id)`. One task's full record —
  schedule, status, `next_run_at`, and up to the last 20 runs, each with
  its own `status` (`"ok"` with the target agent's reply text, or
  `"error"` with what went wrong). `status: "awaiting_approval"` means
  the current fire is paused on a real durable approval — `pending`
  identifies which run.
- **Tool** — `cancel_scheduled_task(task_id)`. Stops a task from firing
  again. History stays intact (`status` becomes `"cancelled"`, nothing
  is deleted) — doesn't retract an approval already in flight for a
  fire that's currently `"awaiting_approval"`.
- **Skill** — `task-scheduling`: when to actually reach for this versus
  just answering now, choosing `run_at` vs `every`, what "no human live
  in the conversation" really means for the target agent's own tool
  calls (auto-resolved vs a real durable approval, depending on that
  agent's own config), and how to report a task's run history back
  usefully.
- **actauth rules** — all four tools `decision: allow`. None has a
  destructive or irreversible side effect; the real ongoing cost (a
  recurring task billing model calls forever until cancelled) isn't
  something actauth can meaningfully gate on `schedule_task` itself —
  see the skill for how that's surfaced to the operator instead.

## How it actually runs

There's no separate scheduler process, cron daemon, or OS-level
crontab entry — `schedule_task.ts`'s own top-level code starts a
background timer (a plain `setInterval`, default every 10 seconds, no
cron-expression-parsing dependency) the moment this server process
starts, and it keeps running for as long as that process does. Each
tick checks every persisted task under `SCHEDULER_STORE_DIR` for one
whose `next_run_at` has passed, and — for each one — resolves the
target `agent` by name (via `agents/` in this project, the same place
every other agent in it already lives) and calls `runAgent` on it
directly, exactly the mechanism an HTTP request would otherwise go
through, just without one.

**Installing this ability under more than one agent is safe by
default.** Each agent that installs it gets its own copy of
`schedule_task.ts`, at a different file path — Node treats those as
separate modules and starts a separate timer loop for each, even when
both agents run inside the exact same process. Two loops polling the
*same* `SCHEDULER_STORE_DIR` would fire every due task twice —
confirmed live while building this — so `SCHEDULER_STORE_DIR`'s own
default isn't one fixed path: it's inferred from each copy's own real
location on disk (`agents/<name>/tools/schedule_task.ts`), giving every
install its own naturally-separate subdirectory
(`generated/scheduled-tasks/<name>/`) with zero configuration needed —
confirmed live, two installs sharing one process and one `.env`, each
correctly isolated. Setting `SCHEDULER_STORE_DIR` explicitly still
overrides this outright, for a deployment that deliberately wants every
installed copy to share one store (the double-fire risk above applies
again if more than one agent's own loop ends up pointed at the same
explicit value). A scheduled task's own `agent` field can target *any*
agent in the project regardless of which one (or how many) host this
ability.

**A missed run isn't caught up.** If this process was down when a
recurring task's `next_run_at` passed, it fires once on restart and
schedules fresh from that moment — not once for every interval that
was missed while it was down.

**Durable approval needs no loopengine core changes at all.** When an
'ask' decision durably pends, this ability persists a checkpoint via
`createCheckpointStore()` and reads back the resumed turn's own final
answer via `createSessionStore()` — both public `loopengine` exports
that resolve their own backing purely from env vars (`REDIS_URL`, or a
fixed local path) at construction time, with nothing passed in. Since
this file runs inside the exact same process as `adapters/http.ts`,
reading the exact same env vars, an instance created here and that
file's own already-running equivalent are backed by the identical
store — `adapters/http.ts`'s own already-existing
`/pending-approvals/:id/resolve` route, completely unmodified, is what
actually resolves a checkpoint this file creates. Verified live, across
two separate Node processes, including a chained second approval
spawned by resolving the first.

## Install

```
npx loopengine add-ability lp-task-scheduler --agent <your-agent>
```

Then optionally set:
- `SCHEDULER_STORE_DIR` — where task records and run history live.
  Defaults to `./generated/scheduled-tasks/<agent-name>` (inferred from
  where this ability is actually installed — see "How it actually
  runs" above for why that's per-agent, not one fixed path). To move
  one agent's store, set it on that agent in the Admin UI's Environment
  tab (its own `agents/<name>/.env`) rather than project-wide, which
  keeps every agent's loop on its own directory.
- `SCHEDULER_TICK_INTERVAL_MS` — how often the background loop checks
  for due tasks. Defaults to `10000` (10 seconds).

If using the default store location, add `generated/scheduled-tasks/`
to your project's own `.gitignore` if you don't want to commit task
records.

## Upgrading

```
npx loopengine upgrade-ability lp-task-scheduler --agent <your-agent>
```

See loopengine's own `ABILITIES.md` for how abilities, installs, and
upgrades work in general — and remember that upgrading only rewrites
files on disk; the server process itself needs restarting afterward to
actually run the new code (confirmed this is easy to miss — the
old code keeps running, silently, until it does).
