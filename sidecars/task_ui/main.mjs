/**
 * @fileoverview Task Progress Sidecar Backend (`task_ui`).
 *
 * Serves the Task Progress AuxPane web UI and JSON APIs for inspecting the
 * per-session Task DAG, filtering the graph by hop radius around the focused
 * task, and sorting the task list.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpResponse, RawSidecarServer } from '../../lib/sidecar_http.mjs';
import {
  exportTaskTreeMarkdown,
  filterGraphByRadius,
  getSessionTaskState,
  sortTasks,
} from '../../lib/task_dag.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const cachedIndexHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8');
const cachedAssets = new Map(
  Object.entries(STATIC_ASSETS).map(([route, [file, contentType]]) => [
    route,
    { body: readFileSync(join(__dirname, file), 'utf-8'), contentType },
  ])
);

const app = new RawSidecarServer();

app.page('/', () => cachedIndexHtml);
app.page('/fullscreen', () => cachedIndexHtml);

for (const [route, { body, contentType }] of cachedAssets.entries()) {
  app.api(route, () => new HttpResponse(body, { contentType }), 'GET');
}

app.api(
  '/api/state',
  async (data) => {
    const conversationId = String(data.conversationId || '').trim();
    const state = await getSessionTaskState(conversationId);
    const centerTaskId = data.centerTaskId || state.focusedTaskId || '';
    const radius = data.radius ?? 'all';
    const sortBy = data.sortBy || 'created';
    const order = data.order || 'asc';

    const graphView = filterGraphByRadius(state, {
      centerTaskId,
      radius,
    });
    const sortedTasks = sortTasks(state.tasks, sortBy, order);

    return {
      ...state,
      sortedTasks,
      graphView,
      timestamp: Date.now(),
    };
  },
  'GET'
);

app.api(
  '/api/export-tree',
  async (data) => {
    const conversationId = String(data.conversationId || '').trim();
    const state = await getSessionTaskState(conversationId);
    const rootId = data.rootId ?? data.root_id ?? state.focusedTaskId ?? '';
    return exportTaskTreeMarkdown(state, rootId, {
      algo: data.algo || 'bfs',
      maxDepth: data.maxDepth ?? data.max_depth,
      includeDescription:
        data.includeDescription === 'true' || data.includeDescription === true,
      includeMetadata:
        data.includeMetadata !== 'false' && data.includeMetadata !== false,
    });
  },
  'GET'
);

app.run();
