/**
 * @fileoverview Stdio MCP Server for `task-progress`.
 *
 * Exposes `task_*` tools so the agent can register, update, complete, delete,
 * focus, list, and export task dependency trees (DAGs) for the active chat
 * session.
 *
 * All session task state is persisted natively inside the per-conversation
 * Trajectory (`CortexStepMcpTool` steps) rather than on the filesystem, so it
 * is automatically inherited when a chat session is forked in the client.
 */

import {
  exportTaskTreeMarkdown,
  getSessionTaskState,
  normalizeTaskId,
  sortTasks,
} from '../lib/task_dag.mjs';

const SERVER_INFO = {
  name: 'task',
  version: '0.1.0',
};

const TOOLS = [
  {
    name: 'task_register',
    description:
      'Register a new task (or update an existing task by ID) in the current chat session Task Progress DAG, and focus it by default. If task A has subtask dependencies B and C (`depends_on: ["B", "C"]`), register B and C first (or set `create_missing_dependencies: true`) so A > B and A > C form a valid DAG.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Unique task identifier slug (e.g. "design-schema", "impl-api", "task-1").',
        },
        title: {
          type: 'string',
          description: 'Concise human-readable title of the task.',
        },
        description: {
          type: 'string',
          description:
            'Optional detailed description, notes, or acceptance criteria.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          description:
            'Initial status of the task (defaults to "pending"). Note: setting "completed" requires all subtasks in `depends_on` to be completed unless `force: true`.',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of subtask/dependency task IDs that must be completed before this task can be completed (tree structure: this_task > subtask).',
        },
        metadata: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional string-to-string key-value metadata mapping (e.g. {"priority": "high", "file": "/abs/path.js", "tag": "backend"}).',
        },
        focus: {
          type: 'boolean',
          description:
            'Whether to make this task the currently focused task in the Task Progress UI (defaults to true).',
        },
        create_missing_dependencies: {
          type: 'boolean',
          description:
            'If true, automatically registers placeholder "pending" tasks for any IDs in `depends_on` that do not exist yet (defaults to false).',
        },
        force: {
          type: 'boolean',
          description:
            'If true, allows registering with status "completed" even if subtasks in `depends_on` are incomplete.',
        },
      },
      required: ['id', 'title'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'task_update',
    description:
      'Update an existing task in the current chat session Task Progress DAG (title, description, status, `depends_on` / `add_depends_on` / `remove_depends_on`, metadata, or focus). Rejects cyclic dependencies and rejects setting status to "completed" if any subtask in `depends_on` is incomplete (unless `force: true`).',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID of the existing task to update.',
        },
        title: {
          type: 'string',
          description: 'Updated human-readable title.',
        },
        description: {
          type: 'string',
          description: 'Updated description or notes.',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          description:
            'Updated task status. Setting "completed" requires all subtasks in `depends_on` to be completed unless `force: true`.',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Full replacement list of subtask dependency IDs for this task.',
        },
        add_depends_on: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Subtask dependency IDs to add to this task without replacing existing dependencies.',
        },
        remove_depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Subtask dependency IDs to remove from this task.',
        },
        metadata: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'String-to-string metadata entries to merge into the task metadata (set a key to "" or null to remove it).',
        },
        replace_metadata: {
          type: 'boolean',
          description:
            'If true, replaces the entire metadata object with `metadata` instead of merging.',
        },
        focus: {
          type: 'boolean',
          description:
            'If true, focuses this task in the Task Progress AuxPane UI.',
        },
        create_missing_dependencies: {
          type: 'boolean',
          description:
            'If true, auto-creates placeholder "pending" tasks for unknown IDs in `depends_on` / `add_depends_on`.',
        },
        force: {
          type: 'boolean',
          description:
            'If true, allows marking status as "completed" even when subtasks are still incomplete.',
        },
      },
      required: ['id'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'task_complete',
    description:
      'Mark a task as "completed" in the current chat session Task Progress DAG. Validates that all direct and transitive subtask dependencies (`A > B > D`) are already completed; returns an actionable error listing incomplete subtasks unless `force: true` is passed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID of the task to mark as completed.',
        },
        note: {
          type: 'string',
          description:
            'Optional completion summary or verification note stored in `metadata.completionNote`.',
        },
        metadata: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional string-to-string metadata entries to merge upon completion.',
        },
        focus: {
          type: 'boolean',
          description:
            'If true, focuses this completed task in the Task Progress UI.',
        },
        force: {
          type: 'boolean',
          description:
            'If true, forces completion even if one or more subtask dependencies in `depends_on` are still incomplete (defaults to false).',
        },
      },
      required: ['id'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'task_delete',
    description:
      'Delete a task from the current chat session Task Progress DAG and remove it from any parent tasks `depends_on` lists.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID of the task to delete.',
        },
      },
      required: ['id'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'task_focus',
    description:
      'Set the active focused task in the Task Progress AuxPane UI (centering the Graph View radius around it and opening its details in the inspector).',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'ID of the task to focus.',
        },
      },
      required: ['id'],
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'task_list',
    description:
      'List all tasks in the current chat session Task Progress DAG with summary counts, in/out degrees, blocked status, and sorting (`created`, `updated`, `in_degree`, `out_degree`, `total_degree`, `status`, `topological`, `title`).',
    inputSchema: {
      type: 'object',
      properties: {
        sort_by: {
          type: 'string',
          enum: [
            'created',
            'updated',
            'in_degree',
            'out_degree',
            'total_degree',
            'status',
            'topological',
            'title',
          ],
          description: 'Sort field for the returned task list (defaults to "created").',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order: "asc" (default) or "desc".',
        },
        status: {
          type: 'string',
          enum: [
            'all',
            'pending',
            'in_progress',
            'completed',
            'cancelled',
            'blocked',
          ],
          description: 'Optional filter by task status or blocked state.',
        },
      },
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
  {
    name: 'task_export_tree',
    description:
      'Export a task dependency tree rooted at a task node (`A > B > D` and `A > C`) into a GFM Markdown nested list using a BFS (default) or DFS spanning tree algorithm.',
    inputSchema: {
      type: 'object',
      properties: {
        root_id: {
          type: 'string',
          description:
            'Root task ID to start the spanning tree from. Defaults to the currently focused task, or pass "all" to export from all top-level root tasks (`inDegree === 0`).',
        },
        algo: {
          type: 'string',
          enum: ['bfs', 'dfs'],
          description:
            'Spanning tree traversal algorithm: "bfs" (default, places shared diamond subtasks at the shallowest level closest to the root) or "dfs" (traverses each branch deeply first).',
        },
        max_depth: {
          type: 'integer',
          description: 'Optional maximum depth limit for the exported tree.',
        },
        include_description: {
          type: 'boolean',
          description:
            'Whether to include task descriptions indented under each list item (defaults to false).',
        },
        include_metadata: {
          type: 'boolean',
          description:
            'Whether to include inline metadata key-value tags on each list item (defaults to true).',
        },
      },
    },
    _meta: {
      'antigravity/alwaysLoad': true,
    },
  },
];

let useContentLengthFraming = false;
let inputBuffer = Buffer.alloc(0);

process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') {
    process.exit(0);
  }
});

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  if (useContentLengthFraming) {
    const byteLen = Buffer.byteLength(json, 'utf-8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

export async function handleToolCall(params, options = {}) {
  const rawToolName = params?.name || '';
  const args = params?.arguments || {};
  const meta = params?._meta || {};
  const conversationId =
    meta['antigravity.google/conversation_id'] ||
    args.conversation_id ||
    process.env.ANTIGRAVITY_CONVERSATION_ID ||
    '';

  const match =
    /(?:^|_)(task_(?:register|update|complete|delete|focus|list|export_tree))$/.exec(
      rawToolName
    );
  const toolName = match ? match[1] : rawToolName;

  if (
    toolName === 'task_register' ||
    toolName === 'task_update' ||
    toolName === 'task_complete' ||
    toolName === 'task_delete' ||
    toolName === 'task_focus'
  ) {
    const taskId = normalizeTaskId(args.id ?? args.task_id ?? args.taskId ?? '');
    const pendingAction = {
      toolName,
      args: { ...args, id: taskId },
      createdAt: new Date().toISOString(),
    };

    const state = await getSessionTaskState(
      conversationId,
      pendingAction,
      options
    );

    if (!state.actionOk) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: state.actionError || `Failed to execute ${toolName}.`,
          },
        ],
      };
    }

    const updatedTask =
      state.tasks.find((t) => t.id === taskId) || state.affectedTask || null;

    const payload = {
      ok: true,
      action: toolName,
      conversationId,
      focusedTaskId: state.focusedTaskId,
      summary: state.summary,
      task: updatedTask,
      deletedTaskId: state.deletedTaskId || undefined,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (toolName === 'task_list') {
    const state = await getSessionTaskState(conversationId, null, options);
    const sortBy = args.sort_by || args.sortBy || 'created';
    const order = args.order || 'asc';
    const statusFilter = String(args.status || 'all')
      .trim()
      .toLowerCase();

    let tasks = sortTasks(state.tasks, sortBy, order);
    if (statusFilter && statusFilter !== 'all') {
      tasks = tasks.filter((t) => {
        if (statusFilter === 'blocked') return t.isBlocked;
        return t.status === statusFilter;
      });
    }

    const payload = {
      ok: true,
      conversationId,
      isForkedSession: state.isForkedSession,
      parentConversationId: state.parentConversationId,
      focusedTaskId: state.focusedTaskId,
      sortBy,
      order,
      statusFilter,
      summary: state.summary,
      tasks,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  if (toolName === 'task_export_tree') {
    const state = await getSessionTaskState(conversationId, null, options);
    const rootId = args.root_id ?? args.rootId ?? '';
    const exported = exportTaskTreeMarkdown(state, rootId, {
      algo: args.algo || 'bfs',
      maxDepth: args.max_depth ?? args.maxDepth,
      includeDescription:
        args.include_description === true || args.includeDescription === true,
      includeMetadata:
        args.include_metadata !== false && args.includeMetadata !== false,
    });

    if (!exported.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: exported.error }],
      };
    }

    const payload = {
      ok: true,
      conversationId,
      algo: exported.algo,
      rootIds: exported.rootIds,
      visitedCount: exported.visitedCount,
      deduplicatedEdges: exported.deduplicatedEdges,
      markdown: exported.markdown,
    };

    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${rawToolName}` }],
  };
}

async function processRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  try {
    switch (msg.method) {
      case 'initialize': {
        const clientProtocol = msg.params?.protocolVersion || '2024-11-05';
        sendResult(msg.id, {
          protocolVersion: clientProtocol,
          capabilities: {
            tools: {},
          },
          serverInfo: SERVER_INFO,
        });
        break;
      }
      case 'ping': {
        sendResult(msg.id, {});
        break;
      }
      case 'tools/list': {
        sendResult(msg.id, { tools: TOOLS });
        break;
      }
      case 'tools/call': {
        const result = await handleToolCall(msg.params || {});
        sendResult(msg.id, result);
        break;
      }
      default: {
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
        break;
      }
    }
  } catch (err) {
    sendError(msg.id, -32603, err?.message || String(err));
  }
}

let rpcQueue = Promise.resolve();

function enqueueRpcMessage(msg) {
  rpcQueue = rpcQueue
    .then(() => processRpcMessage(msg))
    .catch((err) => {
      sendError(msg?.id ?? null, -32603, err?.message || String(err));
    });
}

function drainInputBuffer() {
  while (inputBuffer.length > 0) {
    const headerStart = inputBuffer.subarray(0, 32).toString('utf-8');
    if (headerStart.startsWith('Content-Length:')) {
      useContentLengthFraming = true;
      const sepIdx = inputBuffer.indexOf('\r\n\r\n');
      if (sepIdx === -1) return;
      const headerText = inputBuffer.subarray(0, sepIdx).toString('utf-8');
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      const bodyLen = match ? Number(match[1]) : 0;
      const totalLen = sepIdx + 4 + bodyLen;
      if (inputBuffer.length < totalLen) return;
      const bodyText = inputBuffer
        .subarray(sepIdx + 4, totalLen)
        .toString('utf-8');
      inputBuffer = inputBuffer.subarray(totalLen);
      try {
        enqueueRpcMessage(JSON.parse(bodyText));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
    } else {
      const nlIdx = inputBuffer.indexOf('\n');
      if (nlIdx === -1) return;
      const line = inputBuffer.subarray(0, nlIdx).toString('utf-8').trim();
      inputBuffer = inputBuffer.subarray(nlIdx + 1);
      if (!line) continue;
      try {
        enqueueRpcMessage(JSON.parse(line));
      } catch (err) {
        sendError(null, -32700, `Parse error: ${err.message}`);
      }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('task_mcp.mjs')) {
  if (process.argv[2] === '--cli') {
    const cliToolName = process.argv[3] || '';
    const cliArgsRaw = process.argv[4] || '{}';
    let cliArgs = {};
    try {
      cliArgs = JSON.parse(cliArgsRaw);
    } catch (err) {
      console.error(`Invalid JSON arguments: ${err.message}`);
      process.exit(1);
    }
    handleToolCall({
      name: cliToolName,
      arguments: cliArgs,
    }).then((res) => {
      const text = res.content?.[0]?.text || '';
      if (res.isError) {
        console.error(text);
        process.exit(1);
      }
      console.log(text);
      process.exit(0);
    });
  } else {
    process.stdin.on('data', (chunk) => {
      inputBuffer = Buffer.concat([inputBuffer, chunk]);
      drainInputBuffer();
    });
    process.stdin.on('end', () => {
      process.exit(0);
    });
  }
}
