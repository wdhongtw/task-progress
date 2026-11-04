import assert from 'node:assert/strict';
import {
  applyTaskAction,
  buildEnrichedDagState,
  buildSpanningTree,
  createEmptyFoldState,
  exportTaskTreeMarkdown,
  extractTaskStepAction,
  filterGraphByRadius,
  findCycleWithNewDeps,
  findIncompleteSubtasks,
  getSessionTaskState,
  normalizeTaskIdList,
  normalizeTaskStatus,
  sortTasks,
} from '../lib/task_dag.mjs';
import { handleToolCall } from '../mcp/task_mcp.mjs';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('normalizeTaskIdList and normalizeTaskStatus handle aliases and deduplication', () => {
  assert.deepEqual(normalizeTaskIdList(['B', ' C ', 'B', '']), ['B', 'C']);
  assert.deepEqual(normalizeTaskIdList('B, C, B'), ['B', 'C']);
  assert.equal(normalizeTaskStatus('done'), 'completed');
  assert.equal(normalizeTaskStatus('todo'), 'pending');
  assert.equal(normalizeTaskStatus('in-progress'), 'in_progress');
  assert.equal(normalizeTaskStatus('canceled'), 'cancelled');
  assert.equal(normalizeTaskStatus('invalid_state'), null);
});

test('A > B > D and A > C enforces subtask completion before parent task A can complete', () => {
  const fold = createEmptyFoldState();

  // Register leaf and intermediate subtasks first: D, B (depends on D), C, A (depends on B, C)
  assert.equal(
    applyTaskAction(
      fold,
      {
        toolName: 'task_register',
        args: { id: 'D', title: 'Subtask D', status: 'pending' },
      },
      1
    ).ok,
    true
  );
  assert.equal(
    applyTaskAction(
      fold,
      {
        toolName: 'task_register',
        args: {
          id: 'B',
          title: 'Subtask B',
          status: 'in_progress',
          depends_on: ['D'],
        },
      },
      2
    ).ok,
    true
  );
  assert.equal(
    applyTaskAction(
      fold,
      {
        toolName: 'task_register',
        args: { id: 'C', title: 'Subtask C', status: 'pending' },
      },
      3
    ).ok,
    true
  );
  assert.equal(
    applyTaskAction(
      fold,
      {
        toolName: 'task_register',
        args: {
          id: 'A',
          title: 'Root Task A',
          status: 'in_progress',
          depends_on: ['B', 'C'],
        },
      },
      4
    ).ok,
    true
  );

  // Attempting to complete A while B, C, D are incomplete must fail with a descriptive error
  const failA = applyTaskAction(
    fold,
    { toolName: 'task_complete', args: { id: 'A' } },
    5
  );
  assert.equal(failA.ok, false);
  assert.match(failA.error, /Cannot complete task 'A'/);
  assert.match(failA.error, /'B'/);
  assert.match(failA.error, /'C'/);
  assert.match(failA.error, /'D'/);
  assert.match(failA.error, /A > B > D/);

  // Attempting to complete B while D is incomplete must also fail
  const failB = applyTaskAction(
    fold,
    { toolName: 'task_complete', args: { id: 'B' } },
    6
  );
  assert.equal(failB.ok, false);
  assert.match(failB.error, /'D'/);
  assert.match(failB.error, /B > D/);

  // Now complete D -> then B -> then C -> then A succeeds!
  assert.equal(
    applyTaskAction(fold, { toolName: 'task_complete', args: { id: 'D' } }, 7)
      .ok,
    true
  );
  assert.equal(
    applyTaskAction(fold, { toolName: 'task_complete', args: { id: 'B' } }, 8)
      .ok,
    true
  );

  // A still blocked by C
  const failA2 = applyTaskAction(
    fold,
    { toolName: 'task_complete', args: { id: 'A' } },
    9
  );
  assert.equal(failA2.ok, false);
  assert.match(failA2.error, /'C'/);

  // Complete C and then A
  assert.equal(
    applyTaskAction(fold, { toolName: 'task_complete', args: { id: 'C' } }, 10)
      .ok,
    true
  );
  const okA = applyTaskAction(
    fold,
    {
      toolName: 'task_complete',
      args: { id: 'A', note: 'All subtasks finished' },
    },
    11
  );
  assert.equal(okA.ok, true);
  assert.equal(okA.task.status, 'completed');
  assert.equal(okA.task.metadata.completionNote, 'All subtasks finished');
});

test('cycle detection rejects direct and multi-hop cycles with exact cycle path in error message', () => {
  const fold = createEmptyFoldState();
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 'A',
        title: 'Task A',
        depends_on: ['B'],
        create_missing_dependencies: true,
      },
    },
    1
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_update',
      args: {
        id: 'B',
        depends_on: ['D'],
        create_missing_dependencies: true,
      },
    },
    2
  );

  // Self-dependency check
  const selfCycle = applyTaskAction(
    fold,
    {
      toolName: 'task_update',
      args: { id: 'D', add_depends_on: ['D'] },
    },
    3
  );
  assert.equal(selfCycle.ok, false);
  assert.match(selfCycle.error, /cannot depend on itself/);

  // Multi-hop cycle D -> A when A -> B -> D exists
  const cycleRes = applyTaskAction(
    fold,
    {
      toolName: 'task_update',
      args: { id: 'D', add_depends_on: ['A'] },
    },
    4
  );
  assert.equal(cycleRes.ok, false);
  assert.match(cycleRes.error, /Dependency cycle detected: D > A > B > D/);
  assert.deepEqual(findCycleWithNewDeps(fold.tasks, 'D', ['A']), [
    'D',
    'A',
    'B',
    'D',
  ]);
});

test('unknown dependency check provides helpful error message unless create_missing_dependencies is true', () => {
  const fold = createEmptyFoldState();
  const missingRes = applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'A', title: 'Task A', depends_on: ['missing-subtask'] },
    },
    1
  );
  assert.equal(missingRes.ok, false);
  assert.match(
    missingRes.error,
    /Unknown subtask dependency ID\(s\) in depends_on for task 'A': 'missing-subtask'/
  );

  const autoCreateRes = applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 'A',
        title: 'Task A',
        depends_on: ['B'],
        create_missing_dependencies: true,
      },
    },
    2
  );
  assert.equal(autoCreateRes.ok, true);
  assert.equal(fold.tasks.has('B'), true);
  assert.equal(fold.tasks.get('B').status, 'pending');
});

test('degrees, blocked state, and list sorting work across created, in_degree, out_degree, and topological order', () => {
  const fold = createEmptyFoldState();
  // Create D, B (depends on D), C (depends on D), A (depends on B, C)
  applyTaskAction(
    fold,
    { toolName: 'task_register', args: { id: 'D', title: 'Leaf D' } },
    1
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'B', title: 'Branch B', depends_on: ['D'] },
    },
    2
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'C', title: 'Branch C', depends_on: ['D'] },
    },
    3
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'A', title: 'Root A', depends_on: ['B', 'C'] },
    },
    4
  );

  const state = buildEnrichedDagState(fold);
  const byId = new Map(state.tasks.map((t) => [t.id, t]));

  // Check degrees:
  // A has 0 parents (inDegree=0) and 2 subtasks B, C (outDegree=2)
  assert.equal(byId.get('A').inDegree, 0);
  assert.equal(byId.get('A').outDegree, 2);
  assert.equal(byId.get('A').isBlocked, true);

  // D is depended on by both B and C (inDegree=2) and has 0 subtasks (outDegree=0)
  assert.equal(byId.get('D').inDegree, 2);
  assert.equal(byId.get('D').outDegree, 0);
  assert.equal(byId.get('D').isBlocked, false);
  assert.equal(byId.get('D').isReady, undefined);

  // Sort by in_degree descending -> D first
  const byInDesc = sortTasks(state.tasks, 'in_degree', 'desc');
  assert.equal(byInDesc[0].id, 'D');

  // Sort by out_degree descending -> A first
  const byOutDesc = sortTasks(state.tasks, 'out_degree', 'desc');
  assert.equal(byOutDesc[0].id, 'A');

  // Sort by topological order -> A before B, C before D
  const byTopo = sortTasks(state.tasks, 'topological', 'asc').map((t) => t.id);
  assert.equal(byTopo[0], 'A');
  assert.equal(byTopo[byTopo.length - 1], 'D');
});

test('filterGraphByRadius limits subgraph to k hops around focused task', () => {
  const fold = createEmptyFoldState();
  // Chain: A > B > C > D > E
  for (const id of ['E', 'D', 'C', 'B', 'A']) {
    const nextMap = { A: ['B'], B: ['C'], C: ['D'], D: ['E'], E: [] };
    applyTaskAction(
      fold,
      {
        toolName: 'task_register',
        args: { id, title: `Task ${id}`, depends_on: nextMap[id] },
      },
      1
    );
  }
  const state = buildEnrichedDagState(fold);

  // Center on C with radius 1 -> should include B (dependent), C (center), D (subtask)
  const r1 = filterGraphByRadius(state, { centerTaskId: 'C', radius: 1 });
  assert.equal(r1.isFiltered, true);
  assert.deepEqual(
    r1.nodes.map((n) => n.id).sort(),
    ['B', 'C', 'D']
  );
  assert.equal(r1.edges.length, 2);
  assert.equal(r1.distances.C, 0);
  assert.equal(r1.distances.B, 1);
  assert.equal(r1.distances.D, 1);
  assert.equal(r1.hiddenNodes, 2);

  // Radius 'all' returns all 5 nodes
  const rAll = filterGraphByRadius(state, { centerTaskId: 'C', radius: 'all' });
  assert.equal(rAll.isFiltered, false);
  assert.equal(rAll.nodes.length, 5);
});

test('spanning tree export formats A > B > D and A > C and handles diamond DAGs in BFS vs DFS', () => {
  const fold = createEmptyFoldState();
  // Build A > B > D and A > C (plus diamond edge C > D)
  // Also make B > E > F and C > F so F is at depth 3 via B>E>F and depth 2 via C>F
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'D', title: 'Task D', status: 'completed' },
    },
    1
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'F', title: 'Shared Leaf F', status: 'completed' },
    },
    2
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'E', title: 'Task E', status: 'completed', depends_on: ['F'] },
    },
    3
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 'B',
        title: 'Task B',
        status: 'in_progress',
        depends_on: ['D', 'E'],
      },
    },
    4
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 'C',
        title: 'Task C',
        status: 'completed',
        depends_on: ['F'],
      },
    },
    5
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 'A',
        title: 'Task A',
        status: 'pending',
        depends_on: ['B', 'C'],
        metadata: { priority: 'P0' },
      },
    },
    6
  );

  const state = buildEnrichedDagState(fold);

  // BFS spanning tree from A:
  // Level 0: A
  // Level 1: B, C
  // Level 2: D (under B), E (under B), F (under C, because C is at level 1 whereas E is at level 2!)
  const bfsExport = exportTaskTreeMarkdown(state, 'A', { algo: 'bfs' });
  assert.equal(bfsExport.ok, true);
  const cNodeBfs = bfsExport.roots[0].children.find((n) => n.id === 'C');
  assert.deepEqual(
    cNodeBfs.children.map((n) => n.id),
    ['F']
  );

  // DFS spanning tree from A:
  // Explores A -> B -> D, then B -> E -> F before visiting C! So F is placed under E in DFS.
  const dfsExport = exportTaskTreeMarkdown(state, 'A', { algo: 'dfs' });
  assert.equal(dfsExport.ok, true);
  const bNodeDfs = dfsExport.roots[0].children.find((n) => n.id === 'B');
  const eNodeDfs = bNodeDfs.children.find((n) => n.id === 'E');
  assert.deepEqual(
    eNodeDfs.children.map((n) => n.id),
    ['F']
  );

  // Verify Markdown output structure
  assert.match(bfsExport.markdown, /^- \[ \] \*\*Task A\*\* \(`A`\)/m);
  assert.match(bfsExport.markdown, /^  - \[ \] \*\*Task B\*\* \(`B`\)/m);
  assert.match(bfsExport.markdown, /^    - \[x\] \*\*Task D\*\* \(`D`\)/m);
  assert.match(bfsExport.markdown, /^  - \[x\] \*\*Task C\*\* \(`C`\)/m);
});

test('getSessionTaskState folds trajectory steps with fork inheritance and handleToolCall integration', async () => {
  const trajectoryData = {
    ok: true,
    metadata: { projectId: 'proj-demo' },
    parentReferences: [{ conversationId: 'parent-conv-1', stepIndex: 1 }],
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          createdAt: '2026-11-03T01:00:00Z',
          toolCall: {
            id: 'tc-1',
            name: 'mcp_task-progress_task_task_register',
            argumentsJson: JSON.stringify({
              id: 'sub-1',
              title: 'Inherited Subtask',
              status: 'completed',
            }),
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          createdAt: '2026-11-03T01:01:00Z',
          toolCall: {
            id: 'tc-2',
            name: 'mcp_task-progress_task_task_register',
            argumentsJson: JSON.stringify({
              id: 'root-1',
              title: 'Inherited Root Task',
              status: 'in_progress',
              depends_on: ['sub-1'],
            }),
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          createdAt: '2026-11-03T01:02:00Z',
          toolCall: {
            id: 'tc-3',
            name: 'mcp_task-progress_task_task_complete',
            argumentsJson: JSON.stringify({
              id: 'root-1',
              note: 'Done after fork',
            }),
          },
        },
      },
    ],
  };

  const state = await getSessionTaskState('child-conv-2', null, {
    trajectoryData,
  });
  assert.equal(state.isForkedSession, true);
  assert.equal(state.parentConversationId, 'parent-conv-1');
  assert.equal(state.summary.total, 2);
  assert.equal(state.summary.completed, 2);
  assert.equal(state.summary.completionPercent, 100);

  const rootTask = state.tasks.find((t) => t.id === 'root-1');
  assert.equal(rootTask.inheritedFromFork, true);
  assert.equal(rootTask.status, 'completed');

  // Test MCP handleToolCall export_tree
  const mcpRes = await handleToolCall(
    {
      name: 'task_export_tree',
      arguments: { root_id: 'root-1', algo: 'bfs' },
    },
    { trajectoryData }
  );
  assert.equal(mcpRes.isError, false);
  const parsed = JSON.parse(mcpRes.content[0].text);
  assert.equal(parsed.ok, true);
  assert.match(parsed.markdown, /Inherited Root Task/);
  assert.match(parsed.markdown, /Inherited Subtask/);
});

test('task_delete removes task and cleans up parent depends_on references', () => {
  const fold = createEmptyFoldState();
  applyTaskAction(
    fold,
    { toolName: 'task_register', args: { id: 'D', title: 'Task D' } },
    1
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'B', title: 'Task B', depends_on: ['D'] },
    },
    2
  );
  applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: { id: 'A', title: 'Task A', depends_on: ['B'] },
    },
    3
  );

  // Delete B -> A's dependsOn should no longer include B
  const delRes = applyTaskAction(
    fold,
    { toolName: 'task_delete', args: { id: 'B' } },
    4
  );
  assert.equal(delRes.ok, true);
  assert.equal(delRes.deletedTaskId, 'B');
  assert.equal(fold.tasks.has('B'), false);
  assert.deepEqual(fold.tasks.get('A').dependsOn, []);
});

test('handleToolCall task_delete ignores in-flight CORTEX_STEP_STATUS_RUNNING trajectory step', async () => {
  const trajectoryData = {
    ok: true,
    metadata: { projectId: 'proj-demo' },
    parentReferences: [],
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          createdAt: '2026-11-04T15:00:00Z',
          toolCall: {
            id: 'tc-reg-1',
            name: 'mcp_task-progress_task_task_register',
            argumentsJson: JSON.stringify({
              id: 'phase-1-child-bug',
              title: 'Phase 1',
              status: 'completed',
            }),
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          createdAt: '2026-11-04T15:01:00Z',
          toolCall: {
            id: 'tc-reg-2',
            name: 'mcp_task-progress_task_task_register',
            argumentsJson: JSON.stringify({
              id: 'phase-2-main-impl',
              title: 'Phase 2',
              status: 'pending',
              depends_on: ['phase-1-child-bug'],
            }),
          },
        },
      },
      {
        type: 'CORTEX_STEP_TYPE_GENERIC',
        status: 'CORTEX_STEP_STATUS_RUNNING',
        metadata: {
          createdAt: '2026-11-04T15:02:00Z',
          toolCall: {
            id: 'tc-del-inflight',
            name: 'mcp_task-progress_task_task_delete',
            argumentsJson: JSON.stringify({
              id: 'phase-2-main-impl',
            }),
          },
        },
      },
    ],
  };

  const mcpRes = await handleToolCall(
    {
      name: 'task_delete',
      arguments: { id: 'phase-2-main-impl' },
    },
    { trajectoryData }
  );
  assert.equal(mcpRes.isError, false);
  const parsed = JSON.parse(mcpRes.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.deletedTaskId, 'phase-2-main-impl');
  assert.equal(parsed.summary.total, 1);
});

test('handleToolCall preserves committed in-flight state across parallel RUNNING calls in the same turn', async () => {
  const convId = 'conv-parallel-inflight';
  const steps = [
    {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_RUNNING',
      metadata: {
        createdAt: '2026-11-04T16:00:00Z',
        toolCall: {
          id: 'tc-par-1',
          name: 'mcp_task-progress_task_task_register',
          argumentsJson: JSON.stringify({
            id: 'leaf-sub',
            title: 'Leaf Subtask',
            status: 'completed',
          }),
        },
      },
    },
    {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_RUNNING',
      metadata: {
        createdAt: '2026-11-04T16:00:01Z',
        toolCall: {
          id: 'tc-par-2',
          name: 'mcp_task-progress_task_task_register',
          argumentsJson: JSON.stringify({
            id: 'parent-root',
            title: 'Parent Root',
            status: 'in_progress',
            depends_on: ['leaf-sub'],
          }),
        },
      },
    },
  ];
  const trajectoryData = {
    ok: true,
    metadata: { projectId: 'proj-demo' },
    parentReferences: [],
    steps,
  };

  // Call 1 executes while both tc-par-1 and tc-par-2 are RUNNING
  const res1 = await handleToolCall(
    {
      name: 'task_register',
      arguments: {
        id: 'leaf-sub',
        title: 'Leaf Subtask',
        status: 'completed',
      },
      _meta: { 'antigravity.google/conversation_id': convId },
    },
    { trajectoryData }
  );
  assert.equal(res1.isError, false);
  const parsed1 = JSON.parse(res1.content[0].text);
  assert.equal(parsed1.summary.total, 1);

  // Call 2 executes immediately while tc-par-1 is STILL RUNNING in trajectory
  const res2 = await handleToolCall(
    {
      name: 'task_register',
      arguments: {
        id: 'parent-root',
        title: 'Parent Root',
        status: 'in_progress',
        depends_on: ['leaf-sub'],
      },
      _meta: { 'antigravity.google/conversation_id': convId },
    },
    { trajectoryData }
  );
  assert.equal(res2.isError, false);
  const parsed2 = JSON.parse(res2.content[0].text);
  assert.equal(parsed2.summary.total, 2);

  // Once both steps transition to DONE, task_list folds them cleanly without duplication
  steps[0].status = 'CORTEX_STEP_STATUS_DONE';
  steps[1].status = 'CORTEX_STEP_STATUS_DONE';
  const listRes = await handleToolCall(
    {
      name: 'task_list',
      arguments: {},
      _meta: { 'antigravity.google/conversation_id': convId },
    },
    { trajectoryData }
  );
  assert.equal(listRes.isError, false);
  const parsedList = JSON.parse(listRes.content[0].text);
  assert.equal(parsedList.summary.total, 2);
});

test('metadata enforces str -> str mapping and supports key deletion', () => {
  const fold = createEmptyFoldState();

  const badRes = applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 't1',
        title: 'Task 1',
        metadata: { tags: ['a', 'b'] },
      },
    },
    1
  );
  assert.equal(badRes.ok, false);
  assert.match(badRes.error, /str -> str mapping/);

  const okRes = applyTaskAction(
    fold,
    {
      toolName: 'task_register',
      args: {
        id: 't1',
        title: 'Task 1',
        metadata: { priority: 'P0', owner: 'alice' },
      },
    },
    2
  );
  assert.equal(okRes.ok, true);
  assert.deepEqual(okRes.task.metadata, { priority: 'P0', owner: 'alice' });

  const updRes = applyTaskAction(
    fold,
    {
      toolName: 'task_update',
      args: {
        id: 't1',
        metadata: { owner: '', file: '/abs/path.js' },
      },
    },
    3
  );
  assert.equal(updRes.ok, true);
  assert.deepEqual(updRes.task.metadata, {
    priority: 'P0',
    file: '/abs/path.js',
  });
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`All ${tests.length} tests passed.`);
