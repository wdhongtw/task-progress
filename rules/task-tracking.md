---
trigger: always_on
description: Keep the session Task Progress DAG synchronized using task_* MCP tools when planning or executing multi-step tasks.
---

# Session Task Progress DAG Tracking (`task_*`)

When planning or executing multi-step tasks in a conversation, keep the
session's Task Progress DAG synchronized using the `task_*` MCP tools (and read
the `task-progress` skill for detailed lifecycle and export workflows):

- **Dependency direction (`A > B > D` and `A > C`)**: Parent task `A` lists its
  required subtasks in `depends_on` (`["B", "C"]`); all direct and transitive
  subtasks must be `completed` before `A` can be marked `completed`.
- **Deliverable-level nodes & transitive reduction**: Represent concrete
  deliverables, workstreams, and verification gates as task nodes (reopening an
  existing task with `status: "in_progress"` when review or test iterations
  require rework), connect each parent only to its immediate child dependencies
  (`Root > A > B`), and record single-action sub-steps in the parent task's
  `description`, `metadata`, or `completionNote`.
- **Active task focus & reference URLs**: Keep focus on the currently active
  (`in_progress`) task (passing `focus: false` on queued tasks during batch
  registration or calling `task_focus`), and store relevant `http(s)://` URLs in
  `metadata` (`str -> str` mapping) so the Focused Task inspector renders
  clickable links.
- **Clickable task & AuxPane UI pills**: Format references to individual tasks
  in chat and Markdown artifacts as
  ``[`#<task-id>` · <title>](sidecar://task-progress/task_ui/?task=<task-id>&auto_open=false)``
  (returned as `markdownPill` in `task_*` tool outputs) so clicking the pill
  opens the Task Progress AuxPane focused on that task, and include
  `[Task Progress](sidecar://task-progress/task_ui/)` when surfacing or
  summarizing the overall task graph.
