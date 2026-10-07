---
name: task-scheduling
description: When to use schedule_task instead of just answering now, how run_at/every schedules work, what actually happens when a scheduled message fires with no human present, and how to check on or cancel a task afterward.
---

# Task scheduling

`schedule_task` sends a message into an agent later — once at a specific
time (`run_at`), or repeatedly on a fixed interval (`every`) — the same
way a cron job runs a command on a timer. It returns a `task_id`
immediately; the actual message doesn't go out until the schedule says
so, entirely independent of this conversation (which may have long since
ended by the time a recurring task fires for the tenth time).

## When to use it

Only when the request is genuinely about *later*, not *now* — "remind me
in an hour," "check this every morning at 9," "follow up on this in three
days." Don't reach for it to defer something you could just do right now
in this same turn; that's slower for the operator, not more capable, if
no actual time delay was requested.

## Choosing `run_at` vs `every`

- **`run_at`** — a specific one-off moment, an ISO 8601 timestamp (e.g.
  `"2026-10-08T09:00:00Z"`). Fires exactly once, then the task's own
  `status` becomes `"done"` — nothing further happens unless a new task
  is scheduled.
- **`every`** — a plain interval, a number plus `s`/`m`/`h`/`d` (e.g.
  `"30s"`, `"15m"`, `"1h"`, `"1d"`). Fires repeatedly, forever, until
  `cancel_scheduled_task` is called — there is no real cron-expression
  syntax here (no "every weekday at 9am"), only a fixed period. If the
  request needs something more specific than a flat interval ("every
  weekday," "the first of the month"), say so plainly rather than
  quietly approximating it with the nearest `every` value — a flat
  interval that silently also fires on Saturday is a real behavior
  difference the operator didn't ask for.

Before creating a **recurring** task, call `list_scheduled_tasks` first
and check whether a very similar one already exists for the same
agent — a recurring task has a real, ongoing cost (every single fire is
a full model turn, billed, for as long as it keeps running), so a
duplicate left running by accident is a real duplicated cost, not just
clutter. Mention that recurring cost plainly if the operator is about to
create one with a short interval (`"30s"`/`"1m"`) — confirm that's
actually intended rather than assuming it.

## What the target agent sees when a task fires

Exactly a normal message, as if a user had just typed it — the target
agent can call its own tools, reach its own final answer, all the usual
machinery. The one real difference: **no human is live in the
conversation** when a scheduled run fires unattended. What actually
happens to an "ask" decision at that point depends entirely on whether
the target agent has its own `httpNotifier` configured (a webhook,
Slack, or similar — a deployment-level setting on that agent, not
anything `schedule_task` itself controls):

- **Target agent has no `httpNotifier` configured** — any tool call
  that would normally stop and ask a live person gets auto-denied
  instead (and any `ask_user` question gets a fixed "no human
  available" answer), immediately, every single time. A target agent
  whose own rules rely heavily on live `"ask"` approval for its real
  work may do very little once scheduled this way — not a bug, just a
  mismatch between that agent's own design (built assuming a human is
  on the other end) and what an unattended run without durable approval
  configured actually is. If the operator wants a scheduled task to
  actually get something done autonomously, point out that the target
  agent's own rules may need a real `allow` for the specific tools it
  needs, not `"ask"` — or that it needs an `httpNotifier` configured
  (see below) if a real human should decide each time.
- **Target agent has its own `httpNotifier` configured** — an "ask"
  decision becomes a *real*, durable approval instead: the run pauses
  (`check_scheduled_task`'s own `status` becomes `"awaiting_approval"`),
  a notification actually goes out wherever that agent's own
  `httpNotifier` delivers to (a webhook, Slack, ...), and the run
  genuinely waits — minutes to days — for a human to decide there. Once
  decided (approved or denied), the task settles exactly like a normal
  fire would: `status` moves to `"done"`/back to `"scheduled"`, and
  `last_result` carries whatever the resumed turn's own final answer
  was. A recurring task holds off computing its next fire while one run
  is still `"awaiting_approval"` — it won't pile up a second pending
  request for the same recurring task while an earlier one is still
  unresolved.
- Either way, this isn't something to work around from inside
  `schedule_task` itself — it's a property of the target agent's own
  configuration, worth mentioning once if it's likely to matter, not
  silently working past.

Cancelling a task that's currently `"awaiting_approval"` stops it from
firing *again* later, but doesn't retract whatever approval request is
already in flight for the current fire — if a human approves it anyway
after the fact, that one call still actually happens. Mention this if
cancelling a task mid-approval comes up; it's a real, if narrow, gap.

## Checking on and cancelling a task

`check_scheduled_task(task_id)` returns the full picture: `status`,
`next_run_at`, `run_count`, and recent run history — each entry's own
`status` (`"ok"` with the target agent's own reply text, or `"error"` if
the run itself failed, e.g. a since-renamed/removed target agent).
`status: "awaiting_approval"` means the current fire is paused on a
real durable approval — see above; `pending.session_id` identifies
which run, though `pending.pending_ids` is only reliably accurate for a
single-approval turn — a target agent that needs a *second* approval
right after the first (the model trying something else once the first
is decided) spawns a new pending request `schedule_task` has no way to
surface the id of ahead of time, even though the task still correctly
settles once that one resolves too. Report a failed run's own `error`
back plainly rather than just saying "it ran" — a task that's been
silently erroring every time for days is exactly the kind of thing
`check_scheduled_task` exists to surface.

`cancel_scheduled_task(task_id)` stops a task from firing again — a
recurring task stops recurring, a one-off that hasn't fired yet never
will. History stays intact (status becomes `"cancelled"`, nothing is
deleted) so `check_scheduled_task` still answers "what did this used to
do" afterward.
