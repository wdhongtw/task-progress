---
name: task-progress
description: >-
  Manage, visualize, and export per-session task dependency graphs (DAGs) using
  the task_* MCP tools and the Task Progress AuxPane UI. Use when tracking
  multi-step plans, expressing subtask dependencies (A > B > D), inspecting
  blocked tasks, or exporting task trees to Markdown nested lists.
---

# Task Progress (`task-progress`)

Use the `task-progress` plugin's MCP tools (`task_*`) and AuxPane UI sidecar to
model tasks as a Directed Acyclic Graph (DAG), track completion progress, and
export task trees into Markdown nested lists.

## Dependency Semantics (`A > B > D` and `A > C`)

- If task `A` has subtasks `B` and `C` (`depends_on: ["B", "C"]`) and `B` has
  subtask `D` (`depends_on: ["D"]`), then `B`, `C`, and `D` must all be marked
  `completed` before `A` can be completed.
- The dependency hierarchy (`A > B > D` and `A > C`) forms a DAG where:
  - `outDegree` of `A` = number of direct subtasks `A` depends on (`depends_on`)
  - `inDegree` of `B` = number of parent tasks waiting on `B` (`dependents`)
  - `isBlocked` is automatically `true` when any direct or transitive subtask in
    `depends_on` is not `completed`.

## DAG Modeling Guidelines

- **Model deliverables and verification gates**: Represent each concrete
  deliverable, workstream, or verification gate as a task node. When a review or
  test iteration requires rework on an existing deliverable, reopen and update
  that task (`task_update` with `status: "in_progress"`) so the graph tracks the
  state of each deliverable across iterations.
- **Keep dependency edges minimal (transitive reduction)**: Connect each parent
  task only to its immediate child dependencies (`Root > A > B` means `Root`
  depends on `["A"]`, and `A` depends on `["B"]`) so transitive completion rules
  propagate cleanly down the hierarchy.
- **Keep single-action steps inside the parent task**: Record one-shot
  sub-actions (such as posting a reply or triggering a check) in the deliverable
  task's `description`, `metadata`, or `completionNote` so every node represents
  a meaningful milestone.
- **Attach reference URLs in `metadata`**: Store relevant `http(s)://` URLs
  (such as pull requests, CI builds, issues, or design docs) in `metadata`
  (`str -> str` mapping) so the Focused Task inspector renders them as clickable
  links.
- **Keep focus on the active task**: When registering multiple tasks in a batch
  or transitioning between tasks, pass `focus: false` on queued tasks and focus
  the currently active (`in_progress`) task (via `focus: true` or `task_focus`)
  so the Focused Task inspector and Graph View hop radius track live execution.

## Lifecycle & Execution Workflows

- **Batch bootstrapping**: Register leaf subtasks first (or pass
  `create_missing_dependencies: true`), setting `status: "in_progress"` and
  `focus: true` on the initial active leaf task while passing `focus: false` on
  queued parent and sibling tasks.
- **Transitioning between tasks**: When a subtask finishes, call `task_complete`
  (recording verification outcomes in `note`) and update the next unblocked task
  to `status: "in_progress"` with `focus: true`.
- **Rework on verification failure**: If a downstream verification gate uncovers
  an issue in an upstream deliverable, reopen the upstream task via
  `task_update` (`status: "in_progress", focus: true`) and keep the verification
  gate `pending` (which automatically marks it `isBlocked: true` until the
  upstream task is re-completed).
- **Updating & pruning metadata**: `task_update` merges incoming `metadata`
  (`str -> str`) keys by default; set a key to `""` or `null` to delete that
  key, or pass `replace_metadata: true` to replace the entire metadata map.
- **Exporting spanning-tree Markdown (`task_export_tree`)**:
  - Use `algo: "bfs"` (default) when shared diamond subtasks should appear at
    the shallowest level closest to the root.
  - Use `algo: "dfs"` when each top-level branch should be expanded deeply
    before moving to sibling branches.

## Citing Tasks & Opening the Interactive AuxPane UI

- **Citing a specific task**: Every task returned by `task_*` MCP tools includes
  `sidecarUri` and `markdownPill`. Format task references in chat responses and
  Markdown artifacts as:

  ```markdown
  [`#<task-id>` · <title>](sidecar://task-progress/task_ui/?task=<task-id>&auto_open=false)
  ```

  Clicking the pill opens the Task Progress AuxPane and focuses `<task-id>` in
  the Graph/List view and Focused Task inspector.

- **Opening the overall Task Progress panel**:

  ```markdown
  [Task Progress](sidecar://task-progress/task_ui/)
  ```
