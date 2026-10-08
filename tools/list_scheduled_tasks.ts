import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolDefinition } from 'loopengine'

// Mirrors schedule_task.ts's own TaskRecord/path convention exactly —
// the two tools can't share a module (add-ability copies each tool file
// standalone, flattened, with no shared-module support), so this on-disk
// path/shape convention is the actual contract between every tool file
// in this ability, not a shared function. STORE_DIR's own inference
// below has to match schedule_task.ts's exactly, not just conceptually
// — a mismatch means this tool silently looks in the wrong directory
// and finds nothing schedule_task.ts actually created.
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

const STORE_DIR = process.env.SCHEDULER_STORE_DIR || join('./generated/scheduled-tasks', inferAgentName() ?? '')

async function listTaskIds(): Promise<string[]> {
  const entries = await readdir(join(STORE_DIR, '.tasks')).catch(() => [] as string[])
  return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
}

async function readTask(taskId: string): Promise<TaskRecord | undefined> {
  try {
    return JSON.parse(await readFile(join(STORE_DIR, '.tasks', `${taskId}.json`), 'utf8')) as TaskRecord
  } catch {
    return undefined
  }
}

export const listScheduledTasks: ToolDefinition = {
  name: 'list_scheduled_tasks',
  description:
    'List every scheduled task in this deployment — across every agent, not just the one this call is running in. Each entry is a summary (task_id, task_name, agent, schedule, status, next_run_at, run_count, last_status) — call check_scheduled_task for one task\'s own full run history. status "awaiting_approval" means that fire hit a durable approval with no human live to answer it, and is still waiting on whoever the target agent\'s own httpNotifier delivers to (Slack, a webhook, ...) to decide. Useful before creating a new recurring task, to check whether a similar one already exists rather than creating a duplicate.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['scheduled', 'cancelled', 'done', 'awaiting_approval'],
        description: 'Optional — only list tasks with this exact status. Omit to list every task regardless of status.',
      },
    },
  },
  execute: async (input) => {
    const statusFilter = typeof input.status === 'string' ? input.status : undefined
    const taskIds = await listTaskIds()
    const tasks = (await Promise.all(taskIds.map((id) => readTask(id)))).filter((t): t is TaskRecord => t !== undefined)
    const filtered = statusFilter ? tasks.filter((t) => t.status === statusFilter) : tasks
    return JSON.stringify(
      filtered.map((t) => ({
        task_id: t.task_id,
        task_name: t.task_name,
        agent: t.agent,
        schedule: t.schedule,
        status: t.status,
        next_run_at: t.next_run_at,
        run_count: t.run_count,
        last_status: t.last_status,
      })),
    )
  },
  // Read-only — never writes anything, safe to run alongside anything else.
  safe: true,
}
