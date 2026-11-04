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
- **Interactive AuxPane UI**: Include
  `[Task Progress](sidecar://task-progress/task_ui/)` in chat when surfacing or
  summarizing the task graph so the user can open the visual DAG panel in one
  click.
