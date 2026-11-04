/**
 * @fileoverview Task Progress Sidecar Backend (`task_ui`).
 *
 * Serves the Task Progress AuxPane web UI and JSON APIs for inspecting the
 * per-session Task DAG, filtering the graph by hop radius around the focused
 * task, and sorting the task list.
 */

import { readFileSync, statSync, watchFile } from 'node:fs';
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

function computeUiAssetVersion() {
  try {
    const files = ['index.html', 'styles.css', 'app.js'];
    return files
      .map((f) => Math.floor(statSync(join(__dirname, f)).mtimeMs))
      .join('-');
  } catch {
    return '0';
  }
}

const app = new RawSidecarServer();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
app.page('/fullscreen', () =>
  readFileSync(join(__dirname, 'index.html'), 'utf-8')
);

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(
    route,
    () =>
      new HttpResponse(readFileSync(join(__dirname, file), 'utf-8'), {
        contentType,
      }),
    'GET'
  );
}

app.api(
  '/api/state',
  async (data) => {
    const conversationId =
      data.conversationId || app.config.conversationId || '';
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
      uiAssetVersion: computeUiAssetVersion(),
      timestamp: Date.now(),
    };
  },
  'GET'
);

app.api(
  '/api/export-tree',
  async (data) => {
    const conversationId =
      data.conversationId || app.config.conversationId || '';
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

for (const watched of [
  join(__dirname, 'main.mjs'),
  join(__dirname, '../../lib/task_dag.mjs'),
]) {
  watchFile(watched, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      process.exit(0);
    }
  }).unref();
}

app.run();
