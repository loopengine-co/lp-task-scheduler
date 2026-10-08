import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCheckpointStore, createSessionStore, discoverAgents, runAgent, type Message, type OutstandingItem, type ToolDefinition } from 'loopengine'

// This file's own top-level code (startScheduler() at the bottom) is
// what actually runs the scheduler — not the schedule_task tool's own
// execute() below, which only ever writes a task record. add-ability
// copies this file into agents/<name>/tools/schedule_task.ts, which
// tools/index.ts imports once at server startup; Node's ESM module
// cache guarantees that import only ever runs this file's own top-level
// code once per process, for as long as the process lives — the same
// "runs forever once loaded" property every other long-lived piece of
// this server (the HTTP listener itself, SessionStore's own file
// watchers) already relies on. No cron-expression parsing library is
// used or needed — schedule is either a one-off ISO timestamp
// (`run_at`) or a plain interval (`every`, e.g. "15m"/"1h"/"1d"), both
// trivial to compute "next run" from without a dependency.
//
// Each agent that installs this ability gets its OWN copy of this file
// at a different path (agents/agentA/tools/schedule_task.ts vs
// agents/agentB/tools/schedule_task.ts are different ES module
// specifiers, so Node instantiates — and starts a scheduler loop for —
// each one separately), even when both agents run inside the exact
// same process. Two such loops polling the identical SCHEDULER_STORE_DIR
// means every due task fires twice — confirmed live while testing this
// exact file. SCHEDULER_STORE_DIR's own default (see inferAgentName
// below) is a per-agent subdirectory specifically to close this: two
// agents installing this ability in the same project get two
// naturally-separate task stores with zero configuration needed,
// instead of silently racing on one shared file the moment a second
// agent installs it. Setting SCHEDULER_STORE_DIR explicitly still wins
// outright over this inferred default — for a deployment that
// deliberately wants every installed copy to share one task store
// (watch for the exact same double-fire risk this default exists to
// avoid if more than one agent's own loop ends up pointed at it), or
// one that runs each agent as a fully separate process anyway (where
// the inferred default already differs automatically, but an explicit
// value works just as well). A scheduled task's own `agent` field can
// still target any agent in the project regardless of which one (or
// how many) host this ability.
//
// An 'ask' decision a fired task hits can become a real, later-
// resolvable durable approval — not just an immediate auto-deny — when
// the *target* agent has its own httpNotifier configured (see
// fireTask/checkResolution below). This needed no changes to
// loopengine core or adapters/http.ts at all to support: createCheckpointStore()/
// createSessionStore() both resolve their backing purely from env vars
// (REDIS_URL, or a fixed local path) at construction time — since this
// file runs inside the exact same process as adapters/http.ts, reading
// the exact same env vars, an instance created here and that file's own
// already-running equivalent resolve to the identical backing store.
// adapters/http.ts's own already-existing /pending-approvals/:id/resolve
// route, completely unmodified, is what actually resolves a checkpoint
// this file creates — confirmed live, across two separate Node
// processes, that a scheduled run's own durable approval round-trips
// correctly through it, including a chained second approval spawned by
// resolving the first.

interface TaskRunRecord {
  ran_at: string
  status: 'ok' | 'error'
  result?: string
  error?: string
}

interface TaskRecord {
  task_id: string
  task_name?: string
  agent: string
  message: string
  schedule: { run_at: string } | { every: string }
  // 'done' only ever applies to a one-off (run_at) task after it fires
  // once — a recurring (every) task stays 'scheduled' indefinitely
  // until cancelled. 'awaiting_approval' — see fireTask's own doc
  // comment — means the fire that just happened hit a durable ('ask')
  // decision with nobody live to answer it; a recurring task doesn't
  // compute a fresh next_run_at or fire again while in this state, so
  // a slow-to-resolve approval can't pile up duplicate pending requests
  // for the same recurring task.
  status: 'scheduled' | 'cancelled' | 'done' | 'awaiting_approval'
  created_at: string
  // Absent once status is 'cancelled'/'done'/'awaiting_approval' —
  // nothing left to wait for on a fixed clock in any of those states.
  next_run_at?: string
  run_count: number
  last_run_at?: string
  last_status?: 'ok' | 'error'
  last_result?: string
  last_error?: string
  // Only set while status is 'awaiting_approval' — see fireTask's own
  // doc comment for what each identifies and why both are needed to
  // eventually resolve it. ran_at is when this fire actually happened,
  // not whenever it eventually gets noticed as resolved — checkResolution
  // uses it to record the real run time, same as every other fire's own
  // history entry already does.
  pending?: { ran_at: string; session_id: string; pending_ids: string[] }
  // Capped to HISTORY_LIMIT most recent runs — see fireTask below. A
  // task left running for months at a short interval would otherwise
  // grow this file without bound.
  history: TaskRunRecord[]
}

// Reads this exact file's own real location on disk (see the
// top-of-file doc comment on why) — agents/<name>/tools/schedule_task.ts
// is the fixed path every ability install already follows, so
// basename(dirname(dirname(<this file>))) recovers <name> reliably.
// Returns undefined for anything that doesn't match that exact shape —
// this file run standalone, outside an agents/<name>/tools/ directory
// (every test harness this ability was built and verified against, for
// instance) — rather than guessing at a name that isn't really there;
// STORE_DIR's own fallback below treats that the same as "no agent
// name available," not an error.
function inferAgentName(): string | undefined {
  try {
    const toolsDir = dirname(fileURLToPath(import.meta.url))
    const agentDir = dirname(toolsDir)
    if (basename(dirname(agentDir)) !== 'agents') return undefined
    return basename(agentDir)
  } catch {
    return undefined
  }
}

const STORE_DIR = process.env.SCHEDULER_STORE_DIR || join('./generated/scheduled-tasks', inferAgentName() ?? '')
// Matches every other ability this session's own AD_IMAGE_OUTPUT_DIR/
// ARCHIVE_OUTPUT_DIR convention: process.cwd() is this server process's
// own working directory (the project root, normally), not this file's
// location — agents/ lives there by the same fixed convention
// run-agent.ts's own loadRules/loadDefaultTools already assume
// (agents/<name>/...), so there's no separate env var for it. Unlike
// STORE_DIR above, this one every agent's own copy of this file
// legitimately needs to resolve to the *same* real directory — it's
// how a scheduled task reaches a *different* agent than whichever one
// is hosting this ability, not something to keep separate per install.
const AGENTS_DIR = join(process.cwd(), 'agents')
// How often the background loop checks for due tasks — deliberately
// finer than a minute (unlike real cron) so a short "every": "30s"
// interval is actually honored close to on time, not held up to a
// whole minute's own granularity.
const TICK_INTERVAL_MS = Number(process.env.SCHEDULER_TICK_INTERVAL_MS) || 10_000
const HISTORY_LIMIT = 20

function taskFilePath(taskId: string): string {
  return join(STORE_DIR, '.tasks', `${taskId}.json`)
}

async function writeTask(task: TaskRecord): Promise<void> {
  await mkdir(join(STORE_DIR, '.tasks'), { recursive: true })
  await writeFile(taskFilePath(task.task_id), JSON.stringify(task, null, 2))
}

async function readTask(taskId: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await readFile(taskFilePath(taskId), 'utf8')) as TaskRecord
  } catch {
    return undefined
  }
}

async function listTaskIds(): Promise<string[]> {
  const entries = await readdir(join(STORE_DIR, '.tasks')).catch(() => [] as string[])
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
}

const EVERY_PATTERN = /^(\d+)(s|m|h|d)$/
const EVERY_UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

function parseEvery(every: string): number {
  const match = EVERY_PATTERN.exec(every.trim())
  if (!match) {
    throw new Error(`schedule_task: "${every}" is not a valid interval — use a number followed by s/m/h/d, e.g. "30s", "15m", "1h", "1d"`)
  }
  return Number(match[1]) * EVERY_UNIT_MS[match[2]]
}

const NO_HUMAN_AVAILABLE_ANSWER =
  'No human is available to answer — this is an unattended scheduled run. Use your own best judgement and proceed without waiting for a response.'

// Both zero-argument factories — each resolves its own backing purely
// from REDIS_URL (or a fixed local path) at construction time, with no
// config passed in at all. That's what makes a *durable* ('ask' with a
// webhook/Slack-configured target agent) approval work with zero
// coordination: this ability runs inside the exact same process as
// adapters/http.ts, reading the exact same env vars, so this instance
// and that file's own already-running `checkpoints`/`sessions`
// variables resolve to the identical backing store (the same Redis
// instance, or the same .checkpoints/.sessions directory on disk) —
// adapters/http.ts's own already-existing /pending-approvals/:id/resolve
// and /approvals/:id/approve routes, completely unmodified, are what
// actually resolve a checkpoint this file creates; this file never
// needs to serve that resolution itself.
const checkpoints = createCheckpointStore()
const sessions = createSessionStore()
// Same default tenant/environment runAgent()/adapters/http.ts itself
// falls back to when neither is given a real one from a live request —
// a scheduled fire has no request to resolve either from, so this is
// the only sensible, fixed choice; see RunAgentOptions.tenant's own doc
// comment ("Default 'default'... every standalone/CLI caller... gets
// that default automatically").
const TENANT = 'default'
const ENVIRONMENT = process.env.LOOPENGINE_ENV ?? 'production'

// Mirrors adapters/http.ts's own storageSessionId composition exactly
// (handleSessionGet/respondAfterResolution) — this is the one thing
// that has to match byte-for-byte for sessions.getHistory below to ever
// find what a resolved checkpoint's own resumed turn wrote.
function storageSessionId(agent: string, rawSessionId: string): string {
  return `${TENANT}:${ENVIRONMENT}:${agent}:${rawSessionId}`
}

// Guards against firing the same task twice if a run is still mid-flight
// when a later tick notices the same (stale, not-yet-updated) next_run_at
// on disk — module-scope, in-memory, deliberately not persisted: it only
// ever needs to mean "don't double-fire *right now*," not survive a
// restart.
const inFlight = new Set<string>()

// Settles a completed (approved, denied, or never hit an 'ask' at all)
// run's own final outcome into the task record — shared by fireTask
// (the immediate, no-pending-approval case) and checkResolution below
// (the delayed case, once a previously-pending approval finally
// settles). `ranAt` is when the *original* fire happened, not when
// this particular settlement is observed — a run resolved three days
// after it fired should still record when it actually ran, not when
// someone happened to click Approve.
async function settleRun(taskId: string, ranAt: string, status: 'ok' | 'error', result: string | undefined, error: string | undefined): Promise<void> {
  // Re-read from disk right before writing back, rather than trusting
  // an in-memory copy from whenever this run actually started — a
  // long-running (or long-pending) run can overlap a
  // cancel_scheduled_task call that landed while it was in flight;
  // writing back a stale copy would silently undo that cancellation.
  const current = await readTask(taskId)
  if (!current || current.status === 'cancelled') return

  current.run_count++
  current.last_run_at = ranAt
  current.last_status = status
  current.last_result = result
  current.last_error = error
  current.pending = undefined
  current.history.push({ ran_at: ranAt, status, result, error })
  if (current.history.length > HISTORY_LIMIT) current.history = current.history.slice(-HISTORY_LIMIT)

  if ('run_at' in current.schedule) {
    current.status = 'done'
    current.next_run_at = undefined
  } else {
    current.status = 'scheduled'
    // Resumes from *now*, not from however many intervals were missed
    // while the server happened to be down (or this one run sat
    // awaiting approval) — a long gap fires the task once and schedules
    // fresh from there, instead of bursting through everything it
    // missed.
    current.next_run_at = new Date(Date.now() + parseEvery(current.schedule.every)).toISOString()
  }
  await writeTask(current)
}

async function fireTask(task: TaskRecord): Promise<void> {
  const ranAt = new Date().toISOString()
  const rawSessionId = `${task.task_id}-run-${task.run_count + 1}`
  try {
    const agents = await discoverAgents(AGENTS_DIR)
    const agentModule = agents.get(task.agent)
    if (!agentModule) throw new Error(`no such agent "${task.agent}" in this project`)
    const runResult = await runAgent(agentModule.config, agentModule.createModelCall(), task.message, [], {
      tenant: TENANT,
      sessionId: rawSessionId,
      // 'http' is what lets the target agent's own AgentConfig.httpNotifier
      // (a real webhook/Slack/webchat target the operator configured on
      // *that* agent) actually get consulted for an 'ask' decision — see
      // RunAgentOptions.approver's own doc comment: an agent's own
      // httpNotifier, if it covers 'approval'/'question', wins outright
      // over whatever's passed below, which only ever applies as a
      // fallback for a target agent that configured neither. That
      // fallback resolves immediately (deny / a fixed answer) rather
      // than risk hanging on a human who was never going to answer —
      // same reasoning as this file's own top-of-file doc comment, now
      // scoped to exactly the agents that haven't opted into durable
      // approval at all.
      channel: 'http',
      approver: { requestApproval: async () => false },
      questionHandler: { requestQuestion: async () => NO_HUMAN_AVAILABLE_ANSWER },
    })

    if (runResult.pending) {
      // Hit a durable ('ask', with the target agent's own httpNotifier
      // covering it) decision instead of resolving immediately — the
      // turn is genuinely paused, possibly for days, waiting for a
      // human to click Approve/Deny wherever that agent's own
      // httpNotifier actually delivers to. Persist exactly what
      // adapters/http.ts's own createCheckpointFromPending persists for
      // a live request hitting the same situation — its own, already-
      // running /pending-approvals/:id/resolve route (reading from this
      // same checkpoint store, per this file's own top-of-file doc
      // comment) is what actually resolves this later; nothing further
      // happens here until checkResolution notices it's gone.
      const outstanding: Record<string, OutstandingItem> = {}
      for (const item of runResult.pending.outstanding) {
        outstanding[item.pendingId] = { kind: item.kind, toolUseId: item.toolUseId, tool: item.tool, args: item.args, reason: item.reason }
      }
      await checkpoints.create({ sessionId: rawSessionId, agent: task.agent, tenant: TENANT, resultsSoFar: runResult.pending.resultsSoFar, outstanding })

      const current = await readTask(task.task_id)
      if (!current || current.status === 'cancelled') return
      current.status = 'awaiting_approval'
      current.next_run_at = undefined
      current.pending = { ran_at: ranAt, session_id: rawSessionId, pending_ids: runResult.pending.outstanding.map((o) => o.pendingId) }
      await writeTask(current)
      return
    }

    await settleRun(task.task_id, ranAt, 'ok', runResult.text, undefined)
  } catch (err) {
    await settleRun(task.task_id, ranAt, 'error', undefined, err instanceof Error ? err.message : String(err))
  }
}

// For a task currently 'awaiting_approval' — checks whether every
// outstanding pendingId from that fire has resolved (the checkpoint
// they belonged to is gone — see CheckpointStore.withCheckpoint's own
// doc comment: a resolved checkpoint is deleted, "nothing revisits a
// closed checkpoint again"), and if so, pulls the resumed turn's own
// final text out of the session store and settles the run exactly like
// an immediate (non-pending) fire would have. withCheckpoint is
// otherwise a mutating, exclusive-access API (it persists whatever `fn`
// returns) — passing it straight back unchanged is what makes this a
// safe, side-effect-free peek rather than an accidental resolution of
// its own.
// Checking whether task.pending's own tracked pendingIds are gone from
// the checkpoint store is NOT a reliable completion signal on its own —
// confirmed live: resumeAgent's own doc comment says a resumed turn
// "can itself return with stopReason 'pending_approval' again," and
// adapters/http.ts's own respondAfterResolution does exactly that
// (createCheckpointFromPending again, for a brand new pendingId my own
// task record never learns about) — so "the *original* pendingId is
// gone" can mean "fully done" or "immediately replaced by a second,
// untracked approval request three seconds later," and there's no way
// to tell those apart from the checkpoint store alone. The one
// unambiguous signal is the session's own history: still-pending (one
// hop or five) always ends in the dangling assistant tool_use message
// that triggered whichever approval is currently outstanding — a
// genuinely finished turn is the only case that ends in a plain-string
// final assistant message instead. task.pending.pending_ids is
// therefore purely informational after the *first* hop — accurate for
// a single-approval turn, possibly stale for a chained one — see
// check_scheduled_task's own description.
// A plain-text final answer isn't necessarily stored as a plain
// string — confirmed live: SessionStore's own on-disk JSONL
// reconstruction round-trips it as content: [{ type: 'text', text:
// '...' }] instead, even though runLoop's own in-memory pushMessage
// uses a bare string for exactly this case. Any tool_use block present
// means the turn is still mid-flight (a dangling call about to get a
// tool_result, not an actual final answer yet) regardless of which
// shape the text itself takes.
function extractFinalText(message: Message | undefined): string | undefined {
  if (!message || message.role !== 'assistant') return undefined
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content) || message.content.some((b) => b.type !== 'text')) return undefined
  const text = message.content
    .map((b) => b.text)
    .filter((t): t is string => typeof t === 'string')
    .join('\n')
  return text || undefined
}

async function checkResolution(task: TaskRecord): Promise<void> {
  if (!task.pending) return
  const history = await sessions.getHistory(storageSessionId(task.agent, task.pending.session_id))
  const text = extractFinalText(history[history.length - 1])
  if (text === undefined) return
  await settleRun(task.task_id, task.pending.ran_at, 'ok', text, undefined)
}

async function tick(): Promise<void> {
  const now = Date.now()
  for (const taskId of await listTaskIds()) {
    if (inFlight.has(taskId)) continue
    const task = await readTask(taskId)
    if (!task) continue

    if (task.status === 'awaiting_approval') {
      inFlight.add(taskId)
      checkResolution(task)
        .catch((err) => console.error(`[schedule_task] unexpected error checking resolution for task ${taskId}:`, err))
        .finally(() => inFlight.delete(taskId))
      continue
    }

    if (task.status !== 'scheduled' || !task.next_run_at) continue
    if (new Date(task.next_run_at).getTime() > now) continue
    inFlight.add(taskId)
    fireTask(task)
      .catch((err) => console.error(`[schedule_task] unexpected error firing task ${taskId}:`, err))
      .finally(() => inFlight.delete(taskId))
  }
}

function startScheduler(): void {
  setInterval(() => {
    tick().catch((err) => console.error('[schedule_task] tick failed:', err))
  }, TICK_INTERVAL_MS)
}
startScheduler()

export const scheduleTask: ToolDefinition = {
  name: 'schedule_task',
  description:
    'Schedule a message to be sent to an agent later — once at a specific time, or on a recurring interval — the same way a cron job runs a command on a timer. The target agent runs exactly as if a user had just sent it that message: it can call its own tools, just with no human live in the conversation. If the target agent has its own httpNotifier configured, an "ask" decision becomes a real durable approval (the run pauses, check_scheduled_task reports "awaiting_approval", and it resumes once a human decides via whatever that agent\'s own httpNotifier delivers to) — otherwise it auto-resolves immediately (denied / a fixed "no human available" answer) instead of ever actually asking anyone. Returns a task_id immediately; the task itself fires later, in the background, independent of this conversation. Poll check_scheduled_task to see whether/how it ran.',
  input_schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'The exact name of an existing agent in this project — the one the scheduled message gets sent to.',
      },
      message: {
        type: 'string',
        description: 'The message to send to that agent when this task fires, exactly as if a user had typed it.',
      },
      schedule: {
        type: 'object',
        description:
          'Either { "run_at": "<ISO 8601 timestamp>" } for a one-off (fires once, then the task is done), or { "every": "<interval>" } for a recurring task (fires repeatedly forever until cancelled) — interval is a number plus s/m/h/d, e.g. "30s", "15m", "1h", "1d". Exactly one of the two, not both.',
        properties: {
          run_at: { type: 'string' },
          every: { type: 'string' },
        },
      },
      task_name: {
        type: 'string',
        description: 'Optional human-readable label for this task, purely for list_scheduled_tasks\' own output — has no effect on behavior.',
      },
    },
    required: ['agent', 'message', 'schedule'],
  },
  execute: async (input) => {
    const agent = String(input.agent ?? '')
    const message = String(input.message ?? '')
    const taskName = typeof input.task_name === 'string' ? input.task_name : undefined
    const scheduleInput = input.schedule as Record<string, unknown> | undefined
    if (!agent) throw new Error('schedule_task: agent is required')
    if (!message) throw new Error('schedule_task: message is required')
    if (!scheduleInput || (typeof scheduleInput.run_at !== 'string' && typeof scheduleInput.every !== 'string')) {
      throw new Error('schedule_task: schedule must be { "run_at": "<ISO timestamp>" } or { "every": "<interval, e.g. \\"1h\\">" }')
    }

    // Checked up front, not left to surface only the next time this
    // task happens to become due — a typo'd agent name should fail the
    // schedule_task call itself, not silently log an error deep inside
    // fireTask minutes or hours later with nobody watching.
    const agents = await discoverAgents(AGENTS_DIR)
    if (!agents.has(agent)) {
      throw new Error(`schedule_task: no such agent "${agent}" — known agents: ${[...agents.keys()].join(', ') || '(none found)'}`)
    }

    let schedule: TaskRecord['schedule']
    let nextRunAt: string
    if (typeof scheduleInput.run_at === 'string') {
      const runAtMs = Date.parse(scheduleInput.run_at)
      if (Number.isNaN(runAtMs)) throw new Error(`schedule_task: schedule.run_at "${scheduleInput.run_at}" is not a valid ISO timestamp`)
      schedule = { run_at: scheduleInput.run_at }
      nextRunAt = new Date(runAtMs).toISOString()
    } else {
      const every = String(scheduleInput.every)
      schedule = { every }
      nextRunAt = new Date(Date.now() + parseEvery(every)).toISOString()
    }

    const task: TaskRecord = {
      task_id: randomUUID(),
      task_name: taskName,
      agent,
      message,
      schedule,
      status: 'scheduled',
      created_at: new Date().toISOString(),
      next_run_at: nextRunAt,
      run_count: 0,
      history: [],
    }
    await writeTask(task)
    return JSON.stringify({ task_id: task.task_id, agent, next_run_at: nextRunAt })
  },
  // Writes only its own uniquely-named (randomUUID) task file — no risk
  // of two calls conflicting. The real latent cost this creates (a
  // recurring task keeps billing model calls forever until cancelled)
  // isn't a destructive action to gate, same reasoning
  // lp-file-archiver's own create-zip-archive-allowed rule already
  // documents for its own actauth rule.
  safe: true,
}
