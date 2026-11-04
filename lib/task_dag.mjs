/**
 * @fileoverview Core Task DAG engine, trajectory step folder, radius filter,
 * list sorter, and spanning-tree Markdown exporter for `task-progress`.
 *
 * Semantics:
 * - If task A has subtask dependencies B and C (`A.dependsOn = ['B', 'C']`)
 *   and B has subtask dependency D (`B.dependsOn = ['D']`), then B, C, and D
 *   must all be `completed` before A can be marked `completed`.
 * - Tree structure follows `A > B > D` and `A > C` (from parent task A down to
 *   its subtask dependencies).
 * - All task state is persisted natively inside the per-conversation trajectory
 *   via `task_*` MCP tool steps, so it is automatically inherited across
 *   client-side session forks with zero filesystem clutter.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();

export const VALID_TASK_STATUSES = new Set([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

const TASK_TOOL_RE =
  /(?:^|_)(task_(?:register|update|complete|delete|focus|list|export_tree))$/;

let cachedRuntimeEnv = null;

/**
 * Normalizes a task ID string.
 */
export function normalizeTaskId(raw) {
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

/**
 * Normalizes and deduplicates an array of task IDs while preserving order.
 */
export function normalizeTaskIdList(rawList) {
  if (!rawList) return [];
  const items = Array.isArray(rawList)
    ? rawList
    : typeof rawList === 'string'
    ? rawList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = normalizeTaskId(item);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Normalizes a task status string, returning null if invalid.
 */
export function normalizeTaskStatus(rawStatus, fallback = 'pending') {
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
    return fallback;
  }
  const clean = String(rawStatus).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (clean === 'done' || clean === 'complete') return 'completed';
  if (clean === 'todo' || clean === 'open') return 'pending';
  if (clean === 'canceled') return 'cancelled';
  if (clean === 'active' || clean === 'working' || clean === 'running') {
    return 'in_progress';
  }
  if (VALID_TASK_STATUSES.has(clean)) {
    return clean;
  }
  return null;
}

/**
 * Discovers the running Language Server address, CSRF token, and appDataDir
 * from process environment, `/proc/<pid>/environ`, or `~/.gemini/*`.
 */
export function resolveLanguageServerConnection() {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const envAppData = (process.env.ANTIGRAVITY_APP_DATA_DIR || '').trim();

  if (envAddr && envCsrf && envAppData) {
    return {
      address: envAddr,
      csrfToken: envCsrf,
      appDataDirs: [envAppData],
    };
  }
  if (
    cachedRuntimeEnv?.address &&
    cachedRuntimeEnv?.csrfToken &&
    cachedRuntimeEnv?.appDataDirs?.length
  ) {
    return {
      address: envAddr || cachedRuntimeEnv.address,
      csrfToken: envCsrf || cachedRuntimeEnv.csrfToken,
      appDataDirs: envAppData
        ? [envAppData, ...cachedRuntimeEnv.appDataDirs]
        : cachedRuntimeEnv.appDataDirs,
    };
  }

  let procAddr = '';
  let procCsrf = '';
  let procAppData = '';

  try {
    const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    for (const pid of pids) {
      try {
        const raw = readFileSync(`/proc/${pid}/environ`, 'utf-8');
        if (
          !raw.includes('ANTIGRAVITY_LS_ADDRESS=') &&
          !raw.includes('ANTIGRAVITY_APP_DATA_DIR=')
        ) {
          continue;
        }
        for (const entry of raw.split('\0')) {
          if (!procAddr && entry.startsWith('ANTIGRAVITY_LS_ADDRESS=')) {
            procAddr = entry.slice('ANTIGRAVITY_LS_ADDRESS='.length).trim();
          } else if (!procCsrf && entry.startsWith('ANTIGRAVITY_CSRF_TOKEN=')) {
            procCsrf = entry.slice('ANTIGRAVITY_CSRF_TOKEN='.length).trim();
          } else if (
            !procAppData &&
            entry.startsWith('ANTIGRAVITY_APP_DATA_DIR=')
          ) {
            procAppData = entry
              .slice('ANTIGRAVITY_APP_DATA_DIR='.length)
              .trim();
          }
        }
        if (procAddr && procCsrf && procAppData) {
          break;
        }
      } catch {
        // Ignore unreadable /proc entries
      }
    }
  } catch {
    // Ignore /proc scan errors on non-Linux systems
  }

  const candidateDirs = [];
  const addDir = (d) => {
    if (d && !candidateDirs.includes(d)) candidateDirs.push(d);
  };

  addDir(envAppData);
  addDir(procAppData);

  const geminiRoot = join(HOME, '.gemini');
  try {
    const subdirs = readdirSync(geminiRoot, { withFileTypes: true });
    for (const dirent of subdirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith('config')) continue;
      const candidate = join(geminiRoot, dirent.name);
      if (
        existsSync(join(candidate, 'brain')) ||
        existsSync(join(candidate, 'conversations')) ||
        existsSync(join(candidate, 'conversation_summaries.db'))
      ) {
        addDir(candidate);
      }
    }
  } catch {
    // Ignore scan errors
  }

  addDir(join(HOME, '.gemini', 'antigravity'));

  cachedRuntimeEnv = {
    address: envAddr || procAddr,
    csrfToken: envCsrf || procCsrf,
    appDataDirs: candidateDirs,
  };
  return cachedRuntimeEnv;
}

/**
 * Calls a method on `exa.language_server_pb.LanguageServerService`.
 */
export async function callLanguageServerRpc(
  method,
  payload = {},
  timeoutMs = 4000
) {
  const { address, csrfToken } = resolveLanguageServerConnection();
  if (!address) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Language Server address not found',
    };
  }
  let baseUrl = address;
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `http://${baseUrl}`;
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`;

  const headers = { 'Content-Type': 'application/json' };
  if (csrfToken) {
    headers['x-codeium-csrf-token'] = csrfToken;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    cachedRuntimeEnv = null;
    return {
      ok: false,
      status: 0,
      data: null,
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches all trajectory steps, metadata, and fork lineage for `conversationId`.
 */
export async function fetchConversationTrajectory(conversationId) {
  if (!conversationId) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }
  const res = await callLanguageServerRpc('GetCascadeTrajectory', {
    cascadeId: conversationId,
  });
  if (!res.ok || !res.data?.trajectory) {
    return { ok: false, steps: [], parentReferences: [], metadata: {} };
  }

  const trajectory = res.data.trajectory;
  const steps = Array.isArray(trajectory.steps) ? [...trajectory.steps] : [];
  const totalSteps = Number(
    res.data.numTotalSteps ??
      res.data.num_total_steps ??
      trajectory.numTotalSteps ??
      steps.length
  );

  while (steps.length < totalSteps) {
    const pageRes = await callLanguageServerRpc('GetCascadeTrajectorySteps', {
      cascadeId: conversationId,
      stepOffset: steps.length,
    });
    const pageSteps = pageRes.data?.steps;
    if (!pageRes.ok || !Array.isArray(pageSteps) || pageSteps.length === 0) {
      break;
    }
    steps.push(...pageSteps);
  }

  return {
    ok: true,
    steps,
    parentReferences: Array.isArray(trajectory.parentReferences)
      ? trajectory.parentReferences
      : Array.isArray(trajectory.parent_references)
      ? trajectory.parent_references
      : [],
    metadata: trajectory.metadata || {},
  };
}

/**
 * Extracts a normalized `task_*` action from a trajectory step, or null.
 */
export function extractTaskStepAction(step) {
  if (!step) return null;
  const status = step.status || '';
  if (
    status === 'CORTEX_STEP_STATUS_ERROR' ||
    status === 'CORTEX_STEP_STATUS_FAILED' ||
    status === 'CORTEX_STEP_STATUS_CANCELED'
  ) {
    return null;
  }

  if (
    step.type === 'CORTEX_STEP_TYPE_MCP_TOOL' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const mcpTool = step.mcpTool || step.mcp_tool;
    if (mcpTool?.isError || mcpTool?.is_error) {
      return null;
    }
    const toolCall =
      mcpTool?.toolCall ||
      mcpTool?.tool_call ||
      step.metadata?.toolCall ||
      step.metadata?.tool_call;
    const rawName = toolCall?.name || '';
    const match = TASK_TOOL_RE.exec(rawName);
    if (match) {
      const canonicalTool = match[1];
      let args = {};
      const argsJson =
        toolCall?.argumentsJson ?? toolCall?.arguments_json ?? '';
      if (typeof argsJson === 'string' && argsJson.trim()) {
        try {
          args = JSON.parse(argsJson);
        } catch {
          return null;
        }
      } else if (argsJson && typeof argsJson === 'object') {
        args = argsJson;
      }

      return {
        toolCallId: toolCall?.id || '',
        toolName: canonicalTool,
        args,
        createdAt: step.metadata?.createdAt || step.metadata?.created_at || '',
      };
    }
  }

  // Fallback for CLI invocation (`task_mcp.mjs --cli task_register '<json>'`)
  if (
    step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
    step.type === 'CORTEX_STEP_TYPE_GENERIC'
  ) {
    const metaToolCall = step.metadata?.toolCall || step.metadata?.tool_call;
    const argsJson =
      metaToolCall?.argumentsJson ?? metaToolCall?.arguments_json ?? '';
    let cmdLine = '';
    if (typeof argsJson === 'string' && argsJson.includes('task_')) {
      try {
        const parsed = JSON.parse(argsJson);
        cmdLine = parsed.CommandLine || '';
      } catch {
        return null;
      }
    }
    if (!cmdLine) return null;
    const cliMatch =
      /--cli\s+(?:[a-z0-9_]*_)?(task_(?:register|update|complete|delete|focus|list|export_tree))\s+'([^']+)'/.exec(
        cmdLine
      );
    if (!cliMatch) return null;
    try {
      const args = JSON.parse(cliMatch[2]);
      return {
        toolCallId: metaToolCall?.id || '',
        toolName: cliMatch[1],
        args,
        createdAt: step.metadata?.createdAt || step.metadata?.created_at || '',
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Checks whether setting `taskId`'s dependencies to `nextDependsOn` would
 * create a cycle in `tasksMap`. Returns the cycle path array (e.g.
 * `['A', 'B', 'D', 'A']`) if a cycle exists, or `null` if acyclic.
 */
export function findCycleWithNewDeps(tasksMap, taskId, nextDependsOn) {
  const normId = normalizeTaskId(taskId);
  if (!normId) return null;

  for (const depId of nextDependsOn) {
    if (depId === normId) {
      return [normId, normId];
    }
  }

  // Check if `normId` is reachable starting from any `depId` in `nextDependsOn`
  const getDeps = (id) => {
    if (id === normId) return nextDependsOn;
    const node = tasksMap.get(id);
    return node ? node.dependsOn : [];
  };

  for (const startDep of nextDependsOn) {
    const queue = [[normId, startDep]];
    const visited = new Set([startDep]);

    while (queue.length > 0) {
      const path = queue.shift();
      const curr = path[path.length - 1];
      const deps = getDeps(curr);
      for (const next of deps) {
        if (next === normId) {
          return [...path, normId];
        }
        if (!visited.has(next)) {
          visited.add(next);
          queue.push([...path, next]);
        }
      }
    }
  }

  return null;
}

/**
 * Finds all reachable incomplete subtasks under `taskId` (using `overrideDeps`
 * for `taskId` if provided) in BFS order, returning `{ id, title, status, path }[]`.
 */
export function findIncompleteSubtasks(tasksMap, taskId, overrideDeps = null) {
  const normId = normalizeTaskId(taskId);
  const startNode = tasksMap.get(normId);
  const rootDeps =
    overrideDeps !== null
      ? overrideDeps
      : startNode
      ? startNode.dependsOn
      : [];

  const incomplete = [];
  const visited = new Set([normId]);
  const queue = [];

  for (const depId of rootDeps) {
    if (!visited.has(depId)) {
      visited.add(depId);
      queue.push({ id: depId, path: [normId, depId] });
    }
  }

  while (queue.length > 0) {
    const { id, path } = queue.shift();
    const depTask = tasksMap.get(id);
    const status = depTask ? depTask.status : 'missing';
    const title = depTask ? depTask.title : id;

    if (status !== 'completed') {
      incomplete.push({
        id,
        title,
        status,
        path,
        pathString: path.join(' > '),
      });
    }

    if (depTask && Array.isArray(depTask.dependsOn)) {
      for (const childDepId of depTask.dependsOn) {
        if (!visited.has(childDepId)) {
          visited.add(childDepId);
          queue.push({ id: childDepId, path: [...path, childDepId] });
        }
      }
    }
  }

  return incomplete;
}

/**
 * Validates that incoming metadata is a plain object mapping string keys to
 * string values (or `null` when `allowNullDelete` is true to delete keys).
 */
export function validateStringMetadata(incomingMeta, allowNullDelete = false) {
  if (incomingMeta === undefined || incomingMeta === null) {
    return { ok: true };
  }
  if (typeof incomingMeta !== 'object' || Array.isArray(incomingMeta)) {
    return {
      ok: false,
      error:
        'Invalid metadata: expected a string-to-string key-value object (Record<string, string>).',
    };
  }
  for (const [k, v] of Object.entries(incomingMeta)) {
    const key = String(k).trim();
    if (!key) continue;
    if (allowNullDelete && v === null) continue;
    if (typeof v !== 'string') {
      const actualType = Array.isArray(v)
        ? 'array'
        : v === null
        ? 'null'
        : typeof v;
      return {
        ok: false,
        error: `Invalid metadata value for key '${key}': expected a string (metadata is strictly a str -> str mapping), got ${actualType}.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Merges incoming string-to-string metadata into existing metadata.
 * Keys with `null` or `""` are removed.
 */
function mergeMetadata(prevMeta = {}, incomingMeta = {}, replace = false) {
  const base = replace ? {} : { ...prevMeta };
  if (!incomingMeta || typeof incomingMeta !== 'object' || Array.isArray(incomingMeta)) {
    return base;
  }
  for (const [k, v] of Object.entries(incomingMeta)) {
    const key = String(k).trim();
    if (!key) continue;
    if (v === null || v === undefined || v === '') {
      delete base[key];
    } else if (typeof v === 'string') {
      base[key] = v;
    } else if (Array.isArray(v)) {
      base[key] = v.map((item) => String(item)).join(', ');
    } else if (typeof v === 'object') {
      base[key] = JSON.stringify(v);
    } else {
      base[key] = String(v);
    }
  }
  return base;
}

/**
 * Creates an empty fold state container for folding trajectory task steps.
 */
export function createEmptyFoldState() {
  return {
    tasks: new Map(),
    focusedTaskId: '',
    focusedStep: -1,
    nextCreatedOrder: 0,
    seenToolCallIds: new Set(),
  };
}

/**
 * Validates and applies a single `task_*` action onto `foldState`.
 * Returns `{ ok: boolean, error?: string, task?: Object, deletedTaskId?: string }`.
 */
export function applyTaskAction(
  foldState,
  action,
  stepIndex = 0,
  isInheritedFromFork = false,
  options = {}
) {
  if (!action || typeof action !== 'object') {
    return { ok: false, error: 'Invalid task action payload.' };
  }

  const { toolName, args = {}, createdAt = '' } = action;
  const allowLegacyMetadata = options.allowLegacyMetadata === true;
  const rawId = args.id ?? args.task_id ?? args.taskId ?? '';
  const taskId = normalizeTaskId(rawId);

  const listExistingIdsHint = () => {
    const ids = [...foldState.tasks.keys()];
    return ids.length > 0
      ? `Existing task IDs: ${ids.map((x) => `'${x}'`).join(', ')}.`
      : 'No tasks are currently registered in this session.';
  };

  if (toolName === 'task_register') {
    if (!taskId) {
      return {
        ok: false,
        error:
          "Missing required argument 'id' for task_register. Provide a unique non-empty task identifier (e.g. 'design-api' or 'task-1').",
      };
    }

    const prev = foldState.tasks.get(taskId);
    const title = String(args.title ?? prev?.title ?? taskId).trim() || taskId;
    const description =
      args.description !== undefined
        ? String(args.description ?? '').trim()
        : prev?.description ?? '';

    const status = normalizeTaskStatus(
      args.status,
      prev ? prev.status : 'pending'
    );
    if (!status) {
      return {
        ok: false,
        error: `Invalid status '${args.status}' for task '${taskId}'. Allowed values: 'pending', 'in_progress', 'completed', 'cancelled'.`,
      };
    }

    const rawDeps =
      args.depends_on ?? args.dependsOn ?? (prev ? prev.dependsOn : []);
    const nextDependsOn = normalizeTaskIdList(rawDeps);

    if (nextDependsOn.includes(taskId)) {
      return {
        ok: false,
        error: `Task '${taskId}' cannot depend on itself ('${taskId}' found in depends_on). Remove '${taskId}' from depends_on.`,
      };
    }

    const createMissing =
      args.create_missing_dependencies === true ||
      args.createMissingDependencies === true;

    const missingDeps = nextDependsOn.filter(
      (depId) => !foldState.tasks.has(depId)
    );
    if (missingDeps.length > 0 && !createMissing) {
      return {
        ok: false,
        error: `Unknown subtask dependency ID(s) in depends_on for task '${taskId}': ${missingDeps
          .map((d) => `'${d}'`)
          .join(
            ', '
          )}. Register subtask dependencies first using task_register (remember: if A has subtask B, B must be registered so A > B can be linked), or pass create_missing_dependencies: true. ${listExistingIdsHint()}`,
      };
    }

    if (missingDeps.length > 0 && createMissing) {
      for (const depId of missingDeps) {
        const order = foldState.nextCreatedOrder++;
        foldState.tasks.set(depId, {
          id: depId,
          title: depId,
          description: '',
          status: 'pending',
          dependsOn: [],
          metadata: {},
          createdOrder: order,
          createdStep: stepIndex,
          updatedStep: stepIndex,
          createdAt: createdAt || '',
          updatedAt: createdAt || '',
          completedAt: '',
          inheritedFromFork: isInheritedFromFork,
        });
      }
    }

    const cycle = findCycleWithNewDeps(foldState.tasks, taskId, nextDependsOn);
    if (cycle) {
      return {
        ok: false,
        error: `Dependency cycle detected: ${cycle.join(
          ' > '
        )}. Tasks must form a Directed Acyclic Graph (DAG). Remove the cyclic dependency edge from depends_on.`,
      };
    }

    const force = args.force === true;
    if (status === 'completed' && !force) {
      const incomplete = findIncompleteSubtasks(
        foldState.tasks,
        taskId,
        nextDependsOn
      );
      if (incomplete.length > 0) {
        const details = incomplete
          .map(
            (item) =>
              `'${item.id}' ("${item.title}", status: ${item.status}, path: ${item.pathString})`
          )
          .join('; ');
        return {
          ok: false,
          error: `Cannot register task '${taskId}' ("${title}") with status 'completed' because ${incomplete.length} subtask dependency(ies) are not completed: ${details}. Complete all subtasks first via task_complete, register '${taskId}' as 'pending'/'in_progress', or pass force: true to override.`,
        };
      }
    }

    if (!allowLegacyMetadata && args.metadata !== undefined) {
      const metaCheck = validateStringMetadata(args.metadata, true);
      if (!metaCheck.ok) {
        return metaCheck;
      }
    }

    const metadata = mergeMetadata(
      prev?.metadata || {},
      args.metadata,
      args.replace_metadata === true || args.replaceMetadata === true
    );

    const taskRecord = {
      id: taskId,
      title,
      description,
      status,
      dependsOn: nextDependsOn,
      metadata,
      createdOrder: prev ? prev.createdOrder : foldState.nextCreatedOrder++,
      createdStep: prev ? prev.createdStep : stepIndex,
      updatedStep: stepIndex,
      createdAt: prev?.createdAt || createdAt || '',
      updatedAt: createdAt || prev?.updatedAt || '',
      completedAt:
        status === 'completed' || status === 'cancelled'
          ? prev?.completedAt || createdAt || ''
          : '',
      inheritedFromFork: prev ? prev.inheritedFromFork : isInheritedFromFork,
    };

    foldState.tasks.set(taskId, taskRecord);

    const shouldFocus = args.focus !== false;
    if (shouldFocus || !foldState.focusedTaskId) {
      foldState.focusedTaskId = taskId;
      foldState.focusedStep = stepIndex;
    }

    return { ok: true, task: taskRecord };
  }

  if (toolName === 'task_update') {
    if (!taskId) {
      return {
        ok: false,
        error: `Missing required argument 'id' for task_update. ${listExistingIdsHint()}`,
      };
    }
    const prev = foldState.tasks.get(taskId);
    if (!prev) {
      return {
        ok: false,
        error: `Task '${taskId}' does not exist. Use task_register to create it first, or check ${listExistingIdsHint()}`,
      };
    }

    const nextTitle =
      args.title !== undefined
        ? String(args.title).trim() || prev.title
        : prev.title;
    const nextDescription =
      args.description !== undefined
        ? String(args.description ?? '').trim()
        : prev.description;

    const nextStatus =
      args.status !== undefined
        ? normalizeTaskStatus(args.status, null)
        : prev.status;
    if (!nextStatus) {
      return {
        ok: false,
        error: `Invalid status '${args.status}' for task '${taskId}'. Allowed values: 'pending', 'in_progress', 'completed', 'cancelled'.`,
      };
    }

    let nextDependsOn = [...prev.dependsOn];
    if (args.depends_on !== undefined || args.dependsOn !== undefined) {
      nextDependsOn = normalizeTaskIdList(args.depends_on ?? args.dependsOn);
    }
    if (args.add_depends_on !== undefined || args.addDependsOn !== undefined) {
      const toAdd = normalizeTaskIdList(
        args.add_depends_on ?? args.addDependsOn
      );
      for (const depId of toAdd) {
        if (!nextDependsOn.includes(depId)) {
          nextDependsOn.push(depId);
        }
      }
    }
    if (
      args.remove_depends_on !== undefined ||
      args.removeDependsOn !== undefined
    ) {
      const toRemove = new Set(
        normalizeTaskIdList(args.remove_depends_on ?? args.removeDependsOn)
      );
      nextDependsOn = nextDependsOn.filter((depId) => !toRemove.has(depId));
    }

    if (nextDependsOn.includes(taskId)) {
      return {
        ok: false,
        error: `Task '${taskId}' cannot depend on itself. Remove '${taskId}' from depends_on / add_depends_on.`,
      };
    }

    const createMissing =
      args.create_missing_dependencies === true ||
      args.createMissingDependencies === true;
    const missingDeps = nextDependsOn.filter(
      (depId) => !foldState.tasks.has(depId)
    );
    if (missingDeps.length > 0 && !createMissing) {
      return {
        ok: false,
        error: `Unknown subtask dependency ID(s) in depends_on for task '${taskId}': ${missingDeps
          .map((d) => `'${d}'`)
          .join(
            ', '
          )}. Register subtask dependencies first using task_register, or pass create_missing_dependencies: true. ${listExistingIdsHint()}`,
      };
    }

    if (missingDeps.length > 0 && createMissing) {
      for (const depId of missingDeps) {
        const order = foldState.nextCreatedOrder++;
        foldState.tasks.set(depId, {
          id: depId,
          title: depId,
          description: '',
          status: 'pending',
          dependsOn: [],
          metadata: {},
          createdOrder: order,
          createdStep: stepIndex,
          updatedStep: stepIndex,
          createdAt: createdAt || '',
          updatedAt: createdAt || '',
          completedAt: '',
          inheritedFromFork: isInheritedFromFork,
        });
      }
    }

    const cycle = findCycleWithNewDeps(foldState.tasks, taskId, nextDependsOn);
    if (cycle) {
      return {
        ok: false,
        error: `Dependency cycle detected: ${cycle.join(
          ' > '
        )}. Tasks must form a Directed Acyclic Graph (DAG). Remove the cyclic dependency edge.`,
      };
    }

    const force = args.force === true;
    if (nextStatus === 'completed' && !force) {
      const incomplete = findIncompleteSubtasks(
        foldState.tasks,
        taskId,
        nextDependsOn
      );
      if (incomplete.length > 0) {
        const details = incomplete
          .map(
            (item) =>
              `'${item.id}' ("${item.title}", status: ${item.status}, path: ${item.pathString})`
          )
          .join('; ');
        return {
          ok: false,
          error: `Cannot mark task '${taskId}' ("${nextTitle}") as completed because ${incomplete.length} subtask dependency(ies) are still incomplete: ${details}. All subtasks in the dependency tree (${taskId} > ...) must be completed before '${taskId}' can be completed, or pass force: true to override.`,
        };
      }
    }

    if (!allowLegacyMetadata && args.metadata !== undefined) {
      const metaCheck = validateStringMetadata(args.metadata, true);
      if (!metaCheck.ok) {
        return metaCheck;
      }
    }

    const nextMetadata = mergeMetadata(
      prev.metadata,
      args.metadata,
      args.replace_metadata === true || args.replaceMetadata === true
    );

    const updatedRecord = {
      ...prev,
      title: nextTitle,
      description: nextDescription,
      status: nextStatus,
      dependsOn: nextDependsOn,
      metadata: nextMetadata,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev.updatedAt || '',
      completedAt:
        nextStatus === 'completed' || nextStatus === 'cancelled'
          ? prev.completedAt || createdAt || ''
          : '',
    };

    foldState.tasks.set(taskId, updatedRecord);

    if (args.focus === true) {
      foldState.focusedTaskId = taskId;
      foldState.focusedStep = stepIndex;
    }

    return { ok: true, task: updatedRecord };
  }

  if (toolName === 'task_complete') {
    if (!taskId) {
      return {
        ok: false,
        error: `Missing required argument 'id' for task_complete. ${listExistingIdsHint()}`,
      };
    }
    const prev = foldState.tasks.get(taskId);
    if (!prev) {
      return {
        ok: false,
        error: `Task '${taskId}' does not exist and cannot be completed. ${listExistingIdsHint()}`,
      };
    }

    const force = args.force === true;
    if (!force) {
      const incomplete = findIncompleteSubtasks(
        foldState.tasks,
        taskId,
        prev.dependsOn
      );
      if (incomplete.length > 0) {
        const details = incomplete
          .map(
            (item) =>
              `'${item.id}' ("${item.title}", status: ${item.status}, path: ${item.pathString})`
          )
          .join('; ');
        return {
          ok: false,
          error: `Cannot complete task '${taskId}' ("${prev.title}") because ${incomplete.length} subtask dependency(ies) are not completed yet: ${details}. Complete those subtasks first using task_complete, or pass force: true if you intentionally want to override dependency checks.`,
        };
      }
    }

    if (!allowLegacyMetadata && args.metadata !== undefined) {
      const metaCheck = validateStringMetadata(args.metadata, true);
      if (!metaCheck.ok) {
        return metaCheck;
      }
    }

    let nextMetadata = mergeMetadata(prev.metadata, args.metadata, false);
    if (args.note !== undefined && String(args.note).trim()) {
      nextMetadata = {
        ...nextMetadata,
        completionNote: String(args.note).trim(),
      };
    }

    const completedRecord = {
      ...prev,
      status: 'completed',
      metadata: nextMetadata,
      updatedStep: stepIndex,
      updatedAt: createdAt || prev.updatedAt || '',
      completedAt: createdAt || prev.completedAt || '',
    };

    foldState.tasks.set(taskId, completedRecord);

    if (args.focus === true) {
      foldState.focusedTaskId = taskId;
      foldState.focusedStep = stepIndex;
    }

    return { ok: true, task: completedRecord };
  }

  if (toolName === 'task_delete') {
    if (!taskId) {
      return {
        ok: false,
        error: `Missing required argument 'id' for task_delete. ${listExistingIdsHint()}`,
      };
    }
    const prev = foldState.tasks.get(taskId);
    if (!prev) {
      return {
        ok: false,
        error: `Task '${taskId}' does not exist and cannot be deleted. ${listExistingIdsHint()}`,
      };
    }

    foldState.tasks.delete(taskId);

    // Clean up any incoming dependency edges referencing the deleted task
    for (const [otherId, otherTask] of foldState.tasks.entries()) {
      if (otherTask.dependsOn.includes(taskId)) {
        foldState.tasks.set(otherId, {
          ...otherTask,
          dependsOn: otherTask.dependsOn.filter((d) => d !== taskId),
        });
      }
    }

    if (foldState.focusedTaskId === taskId) {
      let nextFocus = '';
      let bestStep = -1;
      for (const item of foldState.tasks.values()) {
        if (item.updatedStep >= bestStep) {
          bestStep = item.updatedStep;
          nextFocus = item.id;
        }
      }
      foldState.focusedTaskId = nextFocus;
      foldState.focusedStep = stepIndex;
    }

    return { ok: true, deletedTaskId: taskId };
  }

  if (toolName === 'task_focus') {
    if (!taskId) {
      return {
        ok: false,
        error: `Missing required argument 'id' for task_focus. ${listExistingIdsHint()}`,
      };
    }
    const prev = foldState.tasks.get(taskId);
    if (!prev) {
      return {
        ok: false,
        error: `Cannot focus unknown task '${taskId}'. ${listExistingIdsHint()}`,
      };
    }
    foldState.focusedTaskId = taskId;
    foldState.focusedStep = stepIndex;
    return { ok: true, task: prev };
  }

  return { ok: true };
}

/**
 * Enriches raw folded tasks with DAG topology metrics:
 * - `dependents` (in-edges: parent tasks waiting on this subtask)
 * - `inDegree`, `outDegree`, `totalDegree`
 * - `incompleteDependencies`, `transitiveIncompleteDependencies`
 * - `isBlocked`, `isReady`
 * - `topologicalDepth`, `topologicalIndex`
 */
export function buildEnrichedDagState(foldState, context = {}) {
  const tasksMap = foldState.tasks;
  const dependentsMap = new Map();
  for (const id of tasksMap.keys()) {
    dependentsMap.set(id, []);
  }

  const edges = [];
  for (const task of tasksMap.values()) {
    const validDeps = task.dependsOn.filter((depId) => tasksMap.has(depId));
    for (const depId of validDeps) {
      dependentsMap.get(depId)?.push(task.id);
      const depTask = tasksMap.get(depId);
      edges.push({
        from: task.id,
        to: depId,
        depStatus: depTask?.status || 'pending',
        isBlocking: depTask?.status !== 'completed',
      });
    }
  }

  // Compute topological sort (from top-level parent tasks with inDegree=0 down to leaf subtasks)
  const inDegreeCounter = new Map();
  const depthMap = new Map();
  for (const id of tasksMap.keys()) {
    const inDeg = (dependentsMap.get(id) || []).length;
    inDegreeCounter.set(id, inDeg);
    depthMap.set(id, 0);
  }

  const roots = [...tasksMap.values()]
    .filter((t) => (inDegreeCounter.get(t.id) || 0) === 0)
    .sort((a, b) => a.createdOrder - b.createdOrder)
    .map((t) => t.id);

  const queue = [...roots];
  const topoOrder = [];
  const visitedTopo = new Set();

  while (queue.length > 0) {
    const currId = queue.shift();
    if (visitedTopo.has(currId)) continue;
    visitedTopo.add(currId);
    topoOrder.push(currId);

    const currTask = tasksMap.get(currId);
    const currDepth = depthMap.get(currId) || 0;
    for (const depId of currTask?.dependsOn || []) {
      if (!tasksMap.has(depId)) continue;
      if (currDepth + 1 > (depthMap.get(depId) || 0)) {
        depthMap.set(depId, currDepth + 1);
      }
      const nextIn = (inDegreeCounter.get(depId) || 1) - 1;
      inDegreeCounter.set(depId, nextIn);
      if (nextIn <= 0 && !visitedTopo.has(depId)) {
        queue.push(depId);
      }
    }
  }

  for (const task of tasksMap.values()) {
    if (!visitedTopo.has(task.id)) {
      topoOrder.push(task.id);
    }
  }

  const topoIndexMap = new Map();
  topoOrder.forEach((id, idx) => topoIndexMap.set(id, idx));

  // Determine effective focused task
  let effectiveFocusedTaskId = '';
  if (foldState.focusedTaskId && tasksMap.has(foldState.focusedTaskId)) {
    effectiveFocusedTaskId = foldState.focusedTaskId;
  } else if (tasksMap.size > 0) {
    // Pick most recently updated task, or first task
    let bestTask = null;
    for (const t of tasksMap.values()) {
      if (
        !bestTask ||
        t.updatedStep > bestTask.updatedStep ||
        (t.updatedStep === bestTask.updatedStep &&
          t.createdOrder > bestTask.createdOrder)
      ) {
        bestTask = t;
      }
    }
    effectiveFocusedTaskId = bestTask ? bestTask.id : '';
  }

  const summary = {
    total: 0,
    completed: 0,
    inProgress: 0,
    pending: 0,
    cancelled: 0,
    blocked: 0,
    completionPercent: 0,
  };

  const enrichedTasks = [];
  for (const task of tasksMap.values()) {
    const validDeps = task.dependsOn.filter((depId) => tasksMap.has(depId));
    const dependents = dependentsMap.get(task.id) || [];
    const directIncomplete = validDeps.filter(
      (depId) => tasksMap.get(depId)?.status !== 'completed'
    );
    const directCompletedCount = validDeps.length - directIncomplete.length;
    const transitiveIncomplete = findIncompleteSubtasks(
      tasksMap,
      task.id,
      validDeps
    );

    const isActiveOrPending =
      task.status === 'pending' || task.status === 'in_progress';
    const isBlocked = isActiveOrPending && transitiveIncomplete.length > 0;

    summary.total += 1;
    if (task.status === 'completed') summary.completed += 1;
    else if (task.status === 'in_progress') summary.inProgress += 1;
    else if (task.status === 'pending') summary.pending += 1;
    else if (task.status === 'cancelled') summary.cancelled += 1;

    if (isBlocked) summary.blocked += 1;

    enrichedTasks.push({
      ...task,
      dependsOn: validDeps,
      dependents,
      outDegree: validDeps.length,
      inDegree: dependents.length,
      totalDegree: validDeps.length + dependents.length,
      directCompletedCount,
      directTotalCount: validDeps.length,
      incompleteDependencies: directIncomplete,
      transitiveIncompleteDependencies: transitiveIncomplete,
      isBlocked,
      isFocused: task.id === effectiveFocusedTaskId,
      topologicalDepth: depthMap.get(task.id) || 0,
      topologicalIndex: topoIndexMap.get(task.id) ?? 0,
    });
  }

  const activeDenominator = summary.total - summary.cancelled;
  summary.completionPercent =
    activeDenominator > 0
      ? Math.round((summary.completed / activeDenominator) * 100)
      : summary.total > 0 && summary.cancelled === summary.total
      ? 100
      : 0;

  enrichedTasks.sort((a, b) => a.createdOrder - b.createdOrder);

  const focusedTask =
    enrichedTasks.find((t) => t.id === effectiveFocusedTaskId) || null;

  return {
    conversationId: context.conversationId || '',
    projectId: context.projectId || '',
    isForkedSession: Boolean(context.isForkedSession),
    parentConversationId: context.parentConversationId || '',
    forkBoundaryStep: context.forkBoundaryStep ?? -1,
    focusedTaskId: effectiveFocusedTaskId,
    explicitFocusedTaskId: foldState.focusedTaskId || '',
    focusedStep: foldState.focusedStep ?? -1,
    focusedTask,
    summary,
    tasks: enrichedTasks,
    edges,
  };
}

/**
 * Resolves the full session Task DAG state for `conversationId` from trajectory
 * steps, optionally validating and applying a `pendingAction`.
 */
export async function getSessionTaskState(
  conversationId,
  pendingAction = null,
  options = {}
) {
  const traj =
    options.trajectoryData ||
    (await fetchConversationTrajectory(conversationId));
  const steps = traj.steps || [];
  const metadata = traj.metadata || {};

  let forkBoundaryStep = -1;
  let parentConversationId = '';
  const parentRefs = traj.parentReferences || [];
  if (parentRefs.length > 0) {
    const lastRef = parentRefs[parentRefs.length - 1];
    parentConversationId =
      lastRef.conversationId ||
      lastRef.conversation_id ||
      lastRef.cascadeId ||
      lastRef.cascade_id ||
      '';
    const refIdx = Number(lastRef.stepIndex ?? lastRef.step_index ?? -1);
    if (Number.isFinite(refIdx) && refIdx >= 0) {
      forkBoundaryStep = refIdx;
    }
  }
  for (let i = 0; i < steps.length; i++) {
    const sysMsg = steps[i]?.systemMessage || steps[i]?.system_message;
    if (
      sysMsg?.eventType === 'FORK_NOTICE' ||
      sysMsg?.event_type === 'FORK_NOTICE'
    ) {
      forkBoundaryStep = i;
    }
  }

  const foldState = createEmptyFoldState();

  for (let i = 0; i < steps.length; i++) {
    const action = extractTaskStepAction(steps[i]);
    if (!action) continue;
    if (action.toolCallId) {
      foldState.seenToolCallIds.add(action.toolCallId);
    }
    const isInherited = forkBoundaryStep >= 0 && i <= forkBoundaryStep;
    applyTaskAction(foldState, action, i, isInherited, {
      allowLegacyMetadata: true,
    });
  }

  let pendingResult = { ok: true };
  if (
    pendingAction &&
    (!pendingAction.toolCallId ||
      !foldState.seenToolCallIds.has(pendingAction.toolCallId))
  ) {
    pendingResult = applyTaskAction(
      foldState,
      pendingAction,
      steps.length,
      false
    );
  }

  const projectId = String(
    metadata.projectId ||
      metadata.project_id ||
      process.env.ANTIGRAVITY_PROJECT_ID ||
      ''
  ).trim();

  const dagState = buildEnrichedDagState(foldState, {
    conversationId,
    projectId,
    isForkedSession: forkBoundaryStep >= 0 || Boolean(parentConversationId),
    parentConversationId,
    forkBoundaryStep,
  });

  return {
    ...dagState,
    actionOk: pendingResult.ok,
    actionError: pendingResult.error || '',
    affectedTask: pendingResult.task || null,
    deletedTaskId: pendingResult.deletedTaskId || '',
  };
}

/**
 * Sorts an array of enriched tasks by the specified criterion and order.
 *
 * Supported `sortBy`:
 * - `'created'` (default): creation sequence / timestamp
 * - `'updated'`: last updated step / creation sequence
 * - `'in_degree'` / `'inDegree'`: number of parent tasks waiting on this task
 * - `'out_degree'` / `'outDegree'`: number of subtask dependencies this task requires
 * - `'total_degree'` / `'totalDegree'`: `inDegree + outDegree`
 * - `'status'`: status priority (`in_progress`, `pending`, `completed`, `cancelled`)
 * - `'topological'`: topological DAG order (`A` before `B` before `D`)
 * - `'title'` / `'id'`: alphabetical by title/id
 */
export function sortTasks(tasks, sortBy = 'created', order = 'asc') {
  const list = Array.isArray(tasks) ? [...tasks] : [];
  const key = String(sortBy || 'created')
    .trim()
    .toLowerCase();
  const dir = String(order || 'asc').toLowerCase() === 'desc' ? -1 : 1;

  const statusRank = (t) => {
    if (t.status === 'in_progress') return t.isBlocked ? 2 : 1;
    if (t.status === 'pending') return t.isBlocked ? 4 : 3;
    if (t.status === 'completed') return 5;
    if (t.status === 'cancelled') return 6;
    return 7;
  };

  list.sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case 'created':
      case 'created_at':
      case 'createdat':
        cmp = (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'updated':
      case 'updated_at':
      case 'updatedat':
        cmp =
          (a.updatedStep ?? 0) - (b.updatedStep ?? 0) ||
          (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'in_degree':
      case 'indegree':
        cmp =
          (a.inDegree ?? 0) - (b.inDegree ?? 0) ||
          (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'out_degree':
      case 'outdegree':
        cmp =
          (a.outDegree ?? 0) - (b.outDegree ?? 0) ||
          (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'total_degree':
      case 'totaldegree':
      case 'degree':
        cmp =
          (a.totalDegree ?? 0) - (b.totalDegree ?? 0) ||
          (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'status':
        cmp =
          statusRank(a) - statusRank(b) ||
          (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'topological':
      case 'topo':
        cmp =
          (a.topologicalIndex ?? 0) - (b.topologicalIndex ?? 0) ||
          (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
      case 'title':
      case 'name':
        cmp =
          String(a.title || a.id).localeCompare(String(b.title || b.id)) ||
          String(a.id).localeCompare(String(b.id));
        break;
      case 'id':
        cmp = String(a.id).localeCompare(String(b.id));
        break;
      default:
        cmp = (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        break;
    }
    return cmp * dir;
  });

  return list;
}

/**
 * Filters the DAG around `centerTaskId` within `radius` hops (`1, 2, 3, ...`,
 * or `'all'` / `null` / `0` for the full graph).
 *
 * Returns the induced subgraph (`nodes`, `edges`, `distances`, `relations`,
 * `isFiltered`, `centerTaskId`, `radius`).
 */
export function filterGraphByRadius(dagState, options = {}) {
  const allTasks = dagState?.tasks || [];
  const allEdges = dagState?.edges || [];
  const byId = new Map(allTasks.map((t) => [t.id, t]));

  const centerId = normalizeTaskId(
    options.centerTaskId ?? dagState?.focusedTaskId ?? ''
  );
  const rawRadius = options.radius;
  const direction = String(options.direction || 'both').toLowerCase();

  const parsedRadius =
    rawRadius === 'all' ||
    rawRadius === null ||
    rawRadius === undefined ||
    rawRadius === '' ||
    rawRadius === Infinity
      ? null
      : Number.parseInt(String(rawRadius), 10);

  const hasValidCenter = Boolean(centerId && byId.has(centerId));
  const isRadiusActive =
    hasValidCenter &&
    parsedRadius !== null &&
    Number.isFinite(parsedRadius) &&
    parsedRadius > 0;

  // Compute hop distances and directional relationship from centerId whenever centerId exists
  const distances = {};
  const relations = {};

  if (hasValidCenter) {
    distances[centerId] = 0;
    relations[centerId] = 'center';

    // Track downstream (subtasks) and upstream (dependents) reachability separately too
    const downDist = new Map([[centerId, 0]]);
    const upDist = new Map([[centerId, 0]]);

    const downQ = [centerId];
    while (downQ.length > 0) {
      const curr = downQ.shift();
      const d = downDist.get(curr);
      const node = byId.get(curr);
      for (const depId of node?.dependsOn || []) {
        if (byId.has(depId) && !downDist.has(depId)) {
          downDist.set(depId, d + 1);
          downQ.push(depId);
        }
      }
    }

    const upQ = [centerId];
    while (upQ.length > 0) {
      const curr = upQ.shift();
      const d = upDist.get(curr);
      const node = byId.get(curr);
      for (const parentId of node?.dependents || []) {
        if (byId.has(parentId) && !upDist.has(parentId)) {
          upDist.set(parentId, d + 1);
          upQ.push(parentId);
        }
      }
    }

    // General undirected (or directed) BFS for radius hop count
    const bfsQ = [centerId];
    while (bfsQ.length > 0) {
      const curr = bfsQ.shift();
      const d = distances[curr];
      const node = byId.get(curr);
      if (!node) continue;

      const neighbors = [];
      if (direction === 'both' || direction === 'downstream') {
        neighbors.push(...(node.dependsOn || []));
      }
      if (direction === 'both' || direction === 'upstream') {
        neighbors.push(...(node.dependents || []));
      }

      for (const nextId of neighbors) {
        if (!byId.has(nextId)) continue;
        if (distances[nextId] === undefined) {
          distances[nextId] = d + 1;
          if (downDist.has(nextId) && !upDist.has(nextId)) {
            relations[nextId] = 'subtask';
          } else if (upDist.has(nextId) && !downDist.has(nextId)) {
            relations[nextId] = 'dependent';
          } else {
            relations[nextId] = 'neighbor';
          }
          bfsQ.push(nextId);
        }
      }
    }
  }

  if (!isRadiusActive) {
    return {
      isFiltered: false,
      centerTaskId: hasValidCenter ? centerId : '',
      radius: null,
      totalNodes: allTasks.length,
      visibleNodes: allTasks.length,
      hiddenNodes: 0,
      distances,
      relations,
      nodes: allTasks.map((t) => ({
        ...t,
        hopDistance: distances[t.id] ?? null,
        relationToCenter: relations[t.id] || 'unconnected',
      })),
      edges: allEdges,
    };
  }

  const visibleIdSet = new Set(
    allTasks
      .filter(
        (t) => distances[t.id] !== undefined && distances[t.id] <= parsedRadius
      )
      .map((t) => t.id)
  );

  const nodes = allTasks
    .filter((t) => visibleIdSet.has(t.id))
    .map((t) => ({
      ...t,
      hopDistance: distances[t.id] ?? null,
      relationToCenter: relations[t.id] || 'neighbor',
    }));

  const edges = allEdges.filter(
    (e) => visibleIdSet.has(e.from) && visibleIdSet.has(e.to)
  );

  return {
    isFiltered: true,
    centerTaskId: centerId,
    radius: parsedRadius,
    totalNodes: allTasks.length,
    visibleNodes: nodes.length,
    hiddenNodes: allTasks.length - nodes.length,
    distances,
    relations,
    nodes,
    edges,
  };
}

/**
 * Builds a spanning tree (or forest) from `dagState` starting at `rootTaskId`
 * (or all top-level tasks with `inDegree === 0` when `rootTaskId` is `'all'` or
 * omitted without a focused task), traversing `dependsOn` edges (`A > B > D`
 * and `A > C`).
 *
 * Options:
 * - `algo`: `'bfs'` (default, places shared diamond subtasks at the shallowest
 *   depth closest to root) or `'dfs'` (explores each branch deeply first).
 * - `maxDepth`: optional maximum depth (`Infinity` by default).
 */
export function buildSpanningTree(dagState, rootTaskId = '', options = {}) {
  const allTasks = dagState?.tasks || [];
  const byId = new Map(allTasks.map((t) => [t.id, t]));
  const algo =
    String(options.algo || 'bfs').toLowerCase() === 'dfs' ? 'dfs' : 'bfs';
  const maxDepth =
    options.maxDepth !== undefined &&
    options.maxDepth !== null &&
    options.maxDepth !== ''
      ? Number.parseInt(String(options.maxDepth), 10)
      : Infinity;

  const cleanRootId = normalizeTaskId(rootTaskId);
  let rootIds = [];

  if (cleanRootId && cleanRootId.toLowerCase() !== 'all') {
    if (!byId.has(cleanRootId)) {
      return {
        ok: false,
        error: `Task '${cleanRootId}' not found. Available task IDs: ${allTasks
          .map((t) => `'${t.id}'`)
          .join(', ')}.`,
        algo,
        roots: [],
        visitedCount: 0,
        deduplicatedEdges: [],
      };
    }
    rootIds = [cleanRootId];
  } else if (
    cleanRootId.toLowerCase() !== 'all' &&
    dagState?.focusedTaskId &&
    byId.has(dagState.focusedTaskId)
  ) {
    rootIds = [dagState.focusedTaskId];
  } else {
    const zeroInRoots = allTasks
      .filter((t) => (t.inDegree ?? 0) === 0)
      .map((t) => t.id);
    rootIds =
      zeroInRoots.length > 0 ? zeroInRoots : allTasks.map((t) => t.id);
  }

  const visited = new Set();
  const deduplicatedEdges = [];

  const makeTreeNode = (task, depth) => ({
    id: task.id,
    title: task.title,
    description: task.description || '',
    status: task.status,
    isBlocked: Boolean(task.isBlocked),
    metadata: task.metadata || {},
    depth,
    children: [],
  });

  const roots = [];

  if (algo === 'bfs') {
    const queue = [];
    for (const rId of rootIds) {
      if (visited.has(rId)) continue;
      const rTask = byId.get(rId);
      if (!rTask) continue;
      visited.add(rId);
      const rNode = makeTreeNode(rTask, 0);
      roots.push(rNode);
      queue.push(rNode);
    }

    while (queue.length > 0) {
      const currNode = queue.shift();
      if (currNode.depth >= maxDepth) continue;
      const currTask = byId.get(currNode.id);
      if (!currTask) continue;

      for (const depId of currTask.dependsOn || []) {
        const depTask = byId.get(depId);
        if (!depTask) continue;
        if (visited.has(depId)) {
          deduplicatedEdges.push({ from: currNode.id, to: depId });
          continue;
        }
        visited.add(depId);
        const childNode = makeTreeNode(depTask, currNode.depth + 1);
        currNode.children.push(childNode);
        queue.push(childNode);
      }
    }
  } else {
    // DFS spanning tree
    const dfsVisit = (currNode) => {
      if (currNode.depth >= maxDepth) return;
      const currTask = byId.get(currNode.id);
      if (!currTask) return;

      for (const depId of currTask.dependsOn || []) {
        const depTask = byId.get(depId);
        if (!depTask) continue;
        if (visited.has(depId)) {
          deduplicatedEdges.push({ from: currNode.id, to: depId });
          continue;
        }
        visited.add(depId);
        const childNode = makeTreeNode(depTask, currNode.depth + 1);
        currNode.children.push(childNode);
        dfsVisit(childNode);
      }
    };

    for (const rId of rootIds) {
      if (visited.has(rId)) continue;
      const rTask = byId.get(rId);
      if (!rTask) continue;
      visited.add(rId);
      const rNode = makeTreeNode(rTask, 0);
      roots.push(rNode);
      dfsVisit(rNode);
    }
  }

  return {
    ok: true,
    algo,
    rootIds,
    roots,
    visitedCount: visited.size,
    deduplicatedEdges,
  };
}

/**
 * Formats a spanning tree of tasks (`A > B > D` and `A > C`) into a GFM
 * Markdown nested list.
 */
export function exportTaskTreeMarkdown(dagState, rootTaskId = '', options = {}) {
  const treeRes = buildSpanningTree(dagState, rootTaskId, options);
  if (!treeRes.ok) {
    return {
      ok: false,
      error: treeRes.error,
      markdown: '',
      ...treeRes,
    };
  }

  const includeId = options.includeId !== false;
  const includeStatus = options.includeStatus !== false;
  const includeMetadata = options.includeMetadata !== false;
  const includeDescription = options.includeDescription === true;

  const lines = [];

  const formatNode = (node) => {
    const indent = '  '.repeat(node.depth);
    const checkbox = node.status === 'completed' ? '[x]' : '[ ]';
    const titlePart =
      node.status === 'cancelled' ? `~~${node.title}~~` : `**${node.title}**`;
    const idPart =
      includeId && node.id !== node.title ? ` (\`${node.id}\`)` : includeId ? ` (\`${node.id}\`)` : '';

    let statusPart = '';
    if (includeStatus) {
      if (node.status === 'in_progress') {
        statusPart = node.isBlocked
          ? ' *(in_progress, blocked)*'
          : ' *(in_progress)*';
      } else if (node.status === 'pending' && node.isBlocked) {
        statusPart = ' *(blocked)*';
      } else if (node.status === 'cancelled') {
        statusPart = ' *(cancelled)*';
      }
    }

    let metaPart = '';
    if (includeMetadata && node.metadata && typeof node.metadata === 'object') {
      const entries = Object.entries(node.metadata).filter(
        ([, v]) => typeof v === 'string' && v !== ''
      );
      if (entries.length > 0) {
        const formattedPairs = entries.map(([k, v]) => `${k}: ${v}`);
        metaPart = ` — [${formattedPairs.join(' | ')}]`;
      }
    }

    lines.push(
      `${indent}- ${checkbox} ${titlePart}${idPart}${statusPart}${metaPart}`
    );

    if (includeDescription && node.description) {
      const descIndent = `${indent}  `;
      for (const rawLine of String(node.description).split('\n')) {
        const trimmed = rawLine.trim();
        if (trimmed) {
          lines.push(`${descIndent}${trimmed}`);
        }
      }
    }

    for (const child of node.children) {
      formatNode(child);
    }
  };

  for (const root of treeRes.roots) {
    formatNode(root);
  }

  return {
    ok: true,
    algo: treeRes.algo,
    rootIds: treeRes.rootIds,
    visitedCount: treeRes.visitedCount,
    deduplicatedEdges: treeRes.deduplicatedEdges,
    roots: treeRes.roots,
    markdown: lines.join('\n'),
  };
}
