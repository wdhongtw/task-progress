# Task Progress (`task-progress`)

Interactive UI plugin and MCP toolset (`task_*`) for tracking, visualizing, and
exporting per-session task dependency graphs (DAGs).

## Features

- **Per-Session Trajectory State with Fork Inheritance**:
  - Tasks and dependencies are persisted directly in conversation trajectory
    steps (`task_*` MCP tool calls), automatically inheriting task progress up
    to the branch point when a conversation is forked.
- **DAG Dependency & Completion Semantics (`A > B > D` and `A > C`)**:
  - Express subtask dependencies via `depends_on`. If `A` depends on `B` and `C`
    and `B` depends on `D`, then `B`, `C`, and `D` must all be `completed`
    before `A` can be completed.
  - Prevents self-dependencies and cycles with descriptive error messages
    reporting the exact cycle or incomplete subtask path.
- **Interactive AuxPane UI (`task_ui`)**:
  - **Graph View (DAG)**: Hierarchical SVG DAG visualization with configurable
    hop-radius limiting (`1`, `2`, `3`, `All`) centered on the focused task,
    pan/zoom, and visual distinction between completed and blocking dependency
    edges.
  - **List View**: Filterable by status or blocked state (`All`, `Pending`,
    `In Progress`, `Completed`, `Cancelled`, `Blocked`) and sortable by
    `Created Time`, `Updated Time`, `In-Degree`, `Out-Degree`, `Total Degree`,
    `Status`, `Topological Order`, or `Title`.
  - **Focused Task Inspector**: Displays full task details, blocking dependency
    chains, clickable subtask/parent chips, and custom metadata key-values (with
    one-click AuxPane file preview for file paths).
- **Spanning-Tree Markdown Nested List Export (`BFS` & `DFS`)**:
  - Exports any task node's dependency subtree (`A > B > D` and `A > C`) into a
    GFM Markdown nested list (`- [x]` / `- [ ]`), deduplicating shared diamond
    subtasks via Breadth-First (`bfs`, default) or Depth-First (`dfs`) spanning
    tree traversal.
