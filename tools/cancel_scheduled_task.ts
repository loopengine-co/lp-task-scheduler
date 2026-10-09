import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgentEnv, type ToolDefinition } from 'loopengine'

// See list_scheduled_tasks.ts's own comment on why this is duplicated,
// not shared, across every tool file in this ability.
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
  [key: string]: unknown
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

function taskFilePath(taskId: string): string {
  return join(STORE_DIR, '.tasks', `${taskId}.json`)
}

async function readTask(taskId: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await readFile(taskFilePath(taskId), 'utf8')) as TaskRecord
  } catch {
    return undefined
  }
}

export const cancelScheduledTask: ToolDefinition = {
  name: 'cancel_scheduled_task',
  description:
    'Cancel a scheduled task by task_id — stops it from ever firing again (a recurring task stops recurring; a one-off that hasn\'t fired yet never will). Its run history stays intact and still queryable via check_scheduled_task, just with status "cancelled" instead of being deleted outright.',
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
    if (!task) throw new Error(`cancel_scheduled_task: no such task_id "${taskId}"`)
    if (task.status === 'cancelled') return JSON.stringify({ task_id: taskId, status: 'cancelled', already: true })
    task.status = 'cancelled'
    delete task.next_run_at
    await writeFile(taskFilePath(taskId), JSON.stringify(task, null, 2))
    return JSON.stringify({ task_id: taskId, status: 'cancelled', already: false })
  },
  // Cancelling is reversal-adjacent (stops future runs, keeps history) —
  // same reasoning lp-file-archiver's own create-zip-archive-allowed
  // rule already documents: no destructive side effect to gate.
  safe: true,
}
