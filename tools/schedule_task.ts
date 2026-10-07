import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { discoverAgents, runAgent, type ToolDefinition } from 'loopengine'

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
// Install this ability under only ONE agent per project. Each agent
// that installs it gets its OWN copy of this file at a different path
// (agents/agentA/tools/schedule_task.ts vs agents/agentB/tools/
// schedule_task.ts are different ES module specifiers, so Node
// instantiates — and starts a scheduler loop for — each one
// separately) — installing it twice in the same project means two
// independent loops both polling SCHEDULER_STORE_DIR, which (if left
// at its own shared default) means every due task fires twice. A
// scheduled task's own `agent` field can still target any agent in the
// project; only the *scheduler ability itself* needs a single home.

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
  // until cancelled.
  status: 'scheduled' | 'cancelled' | 'done'
  created_at: string
  // Absent once status is 'cancelled'/'done' — nothing left to wait for.
  next_run_at?: string
  run_count: number
  last_run_at?: string
  last_status?: 'ok' | 'error'
  last_result?: string
  last_error?: string
  // Capped to HISTORY_LIMIT most recent runs — see fireTask below. A
  // task left running for months at a short interval would otherwise
  // grow this file without bound.
  history: TaskRunRecord[]
}

const STORE_DIR = process.env.SCHEDULER_STORE_DIR || './generated/scheduled-tasks'
// Matches every other ability this session's own AD_IMAGE_OUTPUT_DIR/
// ARCHIVE_OUTPUT_DIR convention: process.cwd() is this server process's
// own working directory (the project root, normally), not this file's
// location — agents/ lives there by the same fixed convention
// run-agent.ts's own loadRules/loadDefaultTools already assume
// (agents/<name>/...), so there's no separate env var for it.
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

// Guards against firing the same task twice if a run is still mid-flight
// when a later tick notices the same (stale, not-yet-updated) next_run_at
// on disk — module-scope, in-memory, deliberately not persisted: it only
// ever needs to mean "don't double-fire *right now*," not survive a
// restart.
const inFlight = new Set<string>()

async function fireTask(task: TaskRecord): Promise<void> {
  const ranAt = new Date().toISOString()
  let status: 'ok' | 'error'
  let result: string | undefined
  let error: string | undefined
  try {
    const agents = await discoverAgents(AGENTS_DIR)
    const agentModule = agents.get(task.agent)
    if (!agentModule) throw new Error(`no such agent "${task.agent}" in this project`)
    const runResult = await runAgent(agentModule.config, agentModule.createModelCall(), task.message, [], {
      // Both resolve immediately rather than block this tick (and every
      // other due task behind it in the same tick, since inFlight only
      // guards *this* task) on a human who was never going to answer —
      // see this file's own top-of-file doc comment. A durable
      // approver/question handler was deliberately not used instead:
      // that would leave a pendingId nobody will ever resolve sitting in
      // actauth's/ask_user's own in-memory pending maps forever, a slow
      // leak across every recurring run that ever hits an 'ask' rule or
      // calls system_ask_user — an immediate, visible decision (denied/
      // a fixed answer) has nothing left dangling afterward.
      approver: { requestApproval: async () => false },
      questionHandler: { requestQuestion: async () => NO_HUMAN_AVAILABLE_ANSWER },
    })
    status = 'ok'
    result = runResult.text
  } catch (err) {
    status = 'error'
    error = err instanceof Error ? err.message : String(err)
  }

  // Re-read from disk right before writing back, rather than mutating
  // the in-memory `task` this function was called with — a long-running
  // run can overlap a cancel_scheduled_task call that landed while it
  // was in flight; writing back the stale in-memory copy would silently
  // undo that cancellation.
  const current = await readTask(task.task_id)
  if (!current || current.status === 'cancelled') return

  current.run_count++
  current.last_run_at = ranAt
  current.last_status = status
  current.last_result = result
  current.last_error = error
  current.history.push({ ran_at: ranAt, status, result, error })
  if (current.history.length > HISTORY_LIMIT) current.history = current.history.slice(-HISTORY_LIMIT)

  if ('run_at' in current.schedule) {
    current.status = 'done'
    current.next_run_at = undefined
  } else {
    // Resumes from *now*, not from however many intervals were missed
    // while the server happened to be down — a long outage fires the
    // task once on restart and schedules fresh from there, instead of
    // bursting through every interval it slept through.
    current.next_run_at = new Date(Date.now() + parseEvery(current.schedule.every)).toISOString()
  }
  await writeTask(current)
}

async function tick(): Promise<void> {
  const now = Date.now()
  for (const taskId of await listTaskIds()) {
    if (inFlight.has(taskId)) continue
    const task = await readTask(taskId)
    if (!task || task.status !== 'scheduled' || !task.next_run_at) continue
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
    'Schedule a message to be sent to an agent later — once at a specific time, or on a recurring interval — the same way a cron job runs a command on a timer. The target agent runs exactly as if a user had just sent it that message: it can call its own tools, just with no human able to answer an interactive approval/question (both auto-resolve immediately — see check_scheduled_task\'s own result for what actually happened). Returns a task_id immediately; the task itself fires later, in the background, independent of this conversation. Poll check_scheduled_task to see whether/how it ran.',
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
