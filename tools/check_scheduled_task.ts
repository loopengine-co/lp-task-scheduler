import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolDefinition } from 'loopengine'

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

const STORE_DIR = process.env.SCHEDULER_STORE_DIR || './generated/scheduled-tasks'

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
