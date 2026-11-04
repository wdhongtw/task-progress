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

## MCP Tools (`task_*`)

- **`task_register`**: Register a task with `id`, `title`, optional
  `description`, `status` (`pending`, `in_progress`, `completed`, `cancelled`),
  `depends_on` (array of subtask IDs), `metadata` (`str -> str` mapping), and
  `focus` (defaults to `true`). Register subtasks before parent tasks, or pass
  `create_missing_dependencies: true`.
- **`task_update`**: Update `title`, `description`, `status`, `depends_on`,
  `add_depends_on`, `remove_depends_on`, `metadata` (`str -> str` mapping;
  merges keys, set a key to `""` or `null` to remove it, or pass
  `replace_metadata: true`), or `focus`.
- **`task_complete`**: Mark a task as `completed`. Enforces that all subtasks in
  its dependency subtree are already `completed` (returning an actionable error
  listing any incomplete subtasks and their paths unless `force: true` is
  passed).
- **`task_delete`**: Delete a task by `id` and clean up incoming `depends_on`
  references.
- **`task_focus`**: Focus a task by `id` in the AuxPane UI (centering the Graph
  View hop radius on it and showing its details in the inspector).
- **`task_list`**: List all tasks sorted by `created`, `updated`, `in_degree`,
  `out_degree`, `total_degree`, `status`, `topological`, or `title`.
- **`task_export_tree`**: Export a task dependency tree rooted at `root_id` (or
  `"all"` for all top-level tasks with `inDegree === 0`) into a GFM Markdown
  nested list using a `bfs` (default, places shared diamond subtasks at the
  shallowest depth) or `dfs` spanning tree algorithm.

## Opening the Interactive AuxPane UI

Include a clickable sidecar pill in chat when the user wants to view or explore
the task graph visually:

```markdown
[Task Progress](sidecar://task-progress/task_ui/)
```
