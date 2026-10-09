import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentEnv, type ToolDefinition } from 'loopengine'

// See list_scheduled_tasks.ts's own comment on why this is duplicated,
// not shared, across every tool file in this ability.
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
  status: 'scheduled' | 'cancelled' | 'done' | 'awaiting_approval'
  created_at: string
  next_run_at?: string
  run_count: number
  last_run_at?: string
  last_status?: 'ok' | 'error'
  last_result?: string
  last_error?: string
  pending?: { ran_at: string; session_id: string; pending_ids: string[] }
  history: TaskRunRecord[]
}

// See schedule_task.ts's own inferAgentName doc comment for why this
// exists at all — must stay byte-for-byte identical to that copy.
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

// The background loop below has no ToolContext to read settings from, so
// this file builds the same per-agent view itself, from its own folder —
// the agent's own .env first, then the project's (loopengine's
// createAgentEnv). Every tool file in this ability does the same, so
// they and the loop always agree on STORE_DIR.
const AGENT_ENV = createAgentEnv(inferAgentName() ?? '', dirname(dirname(fileURLToPath(import.meta.url))))
const STORE_DIR = AGENT_ENV.get('SCHEDULER_STORE_DIR') || join('./generated/scheduled-tasks', inferAgentName() ?? '')

async function readTask(taskId: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(STORE_DIR, '.tasks', `${taskId}.json`), 'utf8')) as TaskRecord
  } catch {
    return undefined
  }
}

export const checkScheduledTask: ToolDefinition = {
  name: 'check_scheduled_task',
  description:
    'Get one scheduled task\'s full detail by task_id — its schedule, current status, next_run_at, and recent run history (each entry\'s own status: "ok" with the target agent\'s own reply text, or "error" if the run itself failed — e.g. the target agent no longer exists, or every tool call it tried got auto-denied with no human present to approve it). status "awaiting_approval" means the most recent fire hit a real durable approval (the target agent has its own httpNotifier configured, e.g. Slack or a webhook) and is still waiting on a human to decide — pending.pending_ids/session_id identify exactly which; nothing else happens for this task until that\'s resolved.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The task_id returned by schedule_task.',
      },
    },
    required: ['task_id'],
  },
  execute: async (input) => {
    const taskId = String(input.task_id ?? '')
    const task = await readTask(taskId)
    if (!task) throw new Error(`check_scheduled_task: no such task_id "${taskId}"`)
    return JSON.stringify(task)
  },
  // Read-only — never writes anything, safe to run alongside anything else.
  safe: true,
}
