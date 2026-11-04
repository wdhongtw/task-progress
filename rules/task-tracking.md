# Session Task Progress DAG Tracking (`task_*`)

When planning or executing multi-step tasks in a conversation, keep the
session's Task Progress DAG synchronized using the `task_*` MCP tools:

- **Dependency Tree Semantics (`A > B > D` and `A > C`)**: If task `A` has
  subtasks `B` and `C` (`depends_on: ["B", "C"]`) and `B` has subtask `D`
  (`depends_on: ["D"]`), then `B`, `C`, and `D` must all be `completed` before
  `A` can be marked `completed`.
- **Registering tasks**: Register leaf subtasks first (or pass
  `create_missing_dependencies: true`) using `task_register` with a concise
  `id`, `title`, optional `description`, `status` (`pending` | `in_progress` |
  `completed` | `cancelled`), `depends_on`, and `metadata` (`str -> str`
  mapping).
- **Updating & completing tasks**: Call `task_update` to update status,
  dependencies (`depends_on`, `add_depends_on`, `remove_depends_on`), or
  `metadata` (`str -> str` mapping), and call `task_complete` once all subtasks
  of a task are complete.
- **Focusing & exporting**: Call `task_focus` to center the AuxPane Graph View
  around the active task, and `task_export_tree` (`algo: "bfs"` or `"dfs"`) to
  export a task tree into a GFM Markdown nested list.
