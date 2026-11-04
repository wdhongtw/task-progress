/**
 * @fileoverview Task Progress Frontend (`task_ui`).
 *
 * Provides:
 * - Interactive SVG DAG Graph View with hop-radius limiting (`1`, `2`, `3`, `All`)
 *   centered on the focused task, `TB`/`LR` layout toggle, and pan/zoom.
 * - Sortable & filterable List View (`created`, `updated`, `in_degree`,
 *   `out_degree`, `total_degree`, `status`, `topological`, `title`).
 * - Sticky Focused Task Details Inspector with clickable dependency/dependent
 *   chips, metadata table, and AuxPane file preview integration.
 */
(() => {
  const POLL_INTERVAL_MS = 3000;
  const $ = (id) => document.getElementById(id);

  const urlParams = new URLSearchParams(window.location.search);
  const sidecarToken = urlParams.get('token') || '';
  const boundConversationId = urlParams.get('conversationId') || '';

  const state = {
    conversationId: boundConversationId,
    isForkedSession: false,
    parentConversationId: '',
    tasks: [],
    edges: [],
    summary: {
      total: 0,
      completed: 0,
      inProgress: 0,
      pending: 0,
      cancelled: 0,
      blocked: 0,
      completionPercent: 0,
    },
    focusedTaskId: '',
    userUnfocused: false,
    lastServerFocusedStep: -1,
    activeView: 'graph', // 'graph' | 'list'
    statusFilter: 'all', // 'all' | 'in_progress' | 'pending' | 'completed' | 'blocked' | 'cancelled'
    graphRadius: 'all', // '1' | '2' | '3' | 'all'
    graphOrient: 'TB', // 'TB' | 'LR'
    zoom: 1,
    panX: 0,
    panY: 0,
    hasFittedGraph: false,
    lastLayoutKey: '',
    listSearch: '',
    sortBy: 'created',
    sortOrder: 'asc',
    detailCollapsed: false,
    uiAssetVersion: '',
    live: true,
  };

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function setHtmlIfChanged(el, nextHtml) {
    if (!el) return;
    if (el._lastHtml !== nextHtml) {
      el.innerHTML = nextHtml;
      el._lastHtml = nextHtml;
    }
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  async function copyText(text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast(label);
    }
  }

  function openFileInAuxPane(filePath) {
    if (!filePath) return;
    const uri = filePath.startsWith('file://')
      ? filePath
      : `file://${filePath}`;
    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
    } else {
      window.parent.postMessage(
        {
          type: 'toggle-aux-pane',
          payload: { tabType: 'fileView', uri },
        },
        '*'
      );
    }
  }

  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText =
      'position:absolute;visibility:hidden;color:var(--background, #0f1117)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncThemeScheme();

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'theme-change') {
      const vars =
        data.payload?.cssVariables || data.theme?.styles || data.styles || {};
      for (const [k, v] of Object.entries(vars)) {
        if (k.startsWith('--') && typeof v === 'string') {
          document.documentElement.style.setProperty(k, v);
        }
      }
      syncThemeScheme();
    }
    const incomingConvId =
      data.payload?.conversationId ||
      data.context?.conversationId ||
      data.conversationId ||
      '';
    if (
      !boundConversationId &&
      incomingConvId &&
      incomingConvId !== state.conversationId
    ) {
      state.conversationId = incomingConvId;
      fetchState();
    }
  });

  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  function resolveConversationId() {
    return (
      boundConversationId ||
      state.conversationId ||
      window.sidecar?.conversationId ||
      ''
    );
  }

  async function apiGet(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        qs.set(k, String(v));
      }
    }
    const url = qs.toString() ? `${path}?${qs.toString()}` : path;
    const headers = {};
    if (sidecarToken) {
      headers['X-Sidecar-Token'] = sidecarToken;
    }
    const res = await fetch(url, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toISOString().slice(0, 10);
  }

  function formatTimestamp(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate()
    )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatDurationTwoUnit(diffSec) {
    if (!Number.isFinite(diffSec) || diffSec < 0) return '0s';
    const totalSec = Math.floor(diffSec);
    if (totalSec < 60) {
      return `${totalSec}s`;
    }
    if (totalSec < 3600) {
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}m${s}s`;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h${m}m`;
  }

  function getTaskTiming(task) {
    const startIso = task.createdAt || task.updatedAt || '';
    const isTerminal =
      task.status === 'completed' || task.status === 'cancelled';
    const endIso = isTerminal
      ? task.completedAt || task.updatedAt || task.createdAt || ''
      : '';

    const startMs = startIso ? Date.parse(startIso) : NaN;
    const endMs = endIso ? Date.parse(endIso) : Date.now();
    const hasValidStart = Number.isFinite(startMs);
    const diffSec =
      hasValidStart && Number.isFinite(endMs)
        ? Math.max(0, Math.floor((endMs - startMs) / 1000))
        : null;

    return {
      startText: formatTimestamp(startIso),
      endText: isTerminal ? formatTimestamp(endIso) : '',
      durationText: diffSec !== null ? formatDurationTwoUnit(diffSec) : '',
    };
  }

  function statusDisplayLabel(status) {
    switch (status) {
      case 'completed':
        return 'Completed';
      case 'in_progress':
        return 'In Progress';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Pending';
    }
  }

  function statusColorVar(task) {
    if (task.status === 'completed') return 'var(--status-completed)';
    if (task.status === 'in_progress') return 'var(--status-in-progress)';
    if (task.status === 'cancelled') return 'var(--status-cancelled)';
    return 'var(--status-pending)';
  }

  // Client-side radius filter matching lib/task_dag.mjs
  function computeRadiusSubgraph() {
    const allTasks = state.tasks || [];
    const allEdges = state.edges || [];
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const centerId = state.focusedTaskId;
    const rawRadius = state.graphRadius;
    const parsedRadius =
      rawRadius === 'all' ? null : Number.parseInt(String(rawRadius), 10);

    const hasCenter = Boolean(centerId && byId.has(centerId));
    const distances = {};
    if (hasCenter) {
      distances[centerId] = 0;
      const queue = [centerId];
      while (queue.length > 0) {
        const curr = queue.shift();
        const d = distances[curr];
        const node = byId.get(curr);
        if (!node) continue;
        const neighbors = [
          ...(node.dependsOn || []),
          ...(node.dependents || []),
        ];
        for (const nId of neighbors) {
          if (byId.has(nId) && distances[nId] === undefined) {
            distances[nId] = d + 1;
            queue.push(nId);
          }
        }
      }
    }

    const isFiltered =
      hasCenter &&
      parsedRadius !== null &&
      Number.isFinite(parsedRadius) &&
      parsedRadius > 0;

    if (!isFiltered) {
      return {
        isFiltered: false,
        centerId: hasCenter ? centerId : '',
        radius: null,
        totalNodes: allTasks.length,
        visibleNodes: allTasks.length,
        distances,
        nodes: allTasks,
        edges: allEdges,
      };
    }

    const visibleSet = new Set(
      allTasks
        .filter(
          (t) =>
            distances[t.id] !== undefined && distances[t.id] <= parsedRadius
        )
        .map((t) => t.id)
    );
    const nodes = allTasks.filter((t) => visibleSet.has(t.id));
    const edges = allEdges.filter(
      (e) => visibleSet.has(e.from) && visibleSet.has(e.to)
    );

    return {
      isFiltered: true,
      centerId,
      radius: parsedRadius,
      totalNodes: allTasks.length,
      visibleNodes: nodes.length,
      distances,
      nodes,
      edges,
    };
  }

  // Client-side sorter matching lib/task_dag.mjs
  function getSortedFilteredTasks() {
    const q = state.listSearch.trim().toLowerCase();
    const sf = state.statusFilter;

    let filtered = state.tasks.filter((t) => {
      if (sf && sf !== 'all') {
        if (sf === 'blocked' && !t.isBlocked) return false;
        if (sf !== 'blocked' && t.status !== sf) {
          return false;
        }
      }
      if (!q) return true;
      const metaStr = JSON.stringify(t.metadata || {}).toLowerCase();
      return (
        t.id.toLowerCase().includes(q) ||
        (t.title || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        metaStr.includes(q)
      );
    });

    const dir = state.sortOrder === 'desc' ? -1 : 1;
    const statusRank = (t) => {
      if (t.status === 'in_progress') return t.isBlocked ? 2 : 1;
      if (t.status === 'pending') return t.isBlocked ? 4 : 3;
      if (t.status === 'completed') return 5;
      if (t.status === 'cancelled') return 6;
      return 7;
    };

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (state.sortBy) {
        case 'created':
          cmp = (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'updated':
          cmp =
            (a.updatedStep ?? 0) - (b.updatedStep ?? 0) ||
            (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'in_degree':
          cmp =
            (a.inDegree ?? 0) - (b.inDegree ?? 0) ||
            (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'out_degree':
          cmp =
            (a.outDegree ?? 0) - (b.outDegree ?? 0) ||
            (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'total_degree':
          cmp =
            (a.totalDegree ?? 0) - (b.totalDegree ?? 0) ||
            (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'status':
          cmp =
            statusRank(a) - statusRank(b) ||
            (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'topological':
          cmp =
            (a.topologicalIndex ?? 0) - (b.topologicalIndex ?? 0) ||
            (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
          break;
        case 'title':
          cmp =
            String(a.title || a.id).localeCompare(String(b.title || b.id)) ||
            String(a.id).localeCompare(String(b.id));
          break;
        default:
          cmp = (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
      }
      return cmp * dir;
    });

    return filtered;
  }

  function focusTask(taskId) {
    if (!taskId) {
      unfocusTask();
      return;
    }
    state.userUnfocused = false;
    state.focusedTaskId = taskId;
    renderAll();
  }

  function unfocusTask() {
    if (!state.focusedTaskId && state.userUnfocused) return;
    state.userUnfocused = true;
    state.focusedTaskId = '';
    renderAll();
  }

  function renderHeaderAndChips() {
    const convBadge = $('conv-badge');
    const cid = resolveConversationId();
    if (cid) {
      convBadge.textContent = cid.slice(0, 8);
      convBadge.classList.remove('hidden');
    } else {
      convBadge.classList.add('hidden');
    }

    const forkBadge = $('fork-badge');
    if (state.isForkedSession) {
      forkBadge.textContent = state.parentConversationId
        ? `Fork ← ${state.parentConversationId.slice(0, 6)}`
        : 'Forked';
      forkBadge.classList.remove('hidden');
    } else {
      forkBadge.classList.add('hidden');
    }

    const s = state.summary;
    const totalActive = Math.max(0, s.total - s.cancelled);
    const compPct = s.completionPercent || 0;
    const inProgPct =
      totalActive > 0 ? Math.round((s.inProgress / totalActive) * 100) : 0;
    const pendPct =
      totalActive > 0 ? Math.round((s.pending / totalActive) * 100) : 0;

    const clampedActive = Math.min(100 - compPct, inProgPct);
    const clampedPending = Math.min(100 - compPct - clampedActive, pendPct);

    $('progress-fill-completed').style.width = `${compPct}%`;
    $('progress-fill-active').style.width = `${clampedActive}%`;
    const pendFill = $('progress-fill-pending');
    if (pendFill) {
      pendFill.style.width = `${clampedPending}%`;
    }
    $('progress-label').textContent = `${s.completed} / ${totalActive} done (${compPct}%)`;

    const filterOptions = [
      { key: 'all', label: `All (${s.total})`, color: '' },
      {
        key: 'pending',
        label: `Pending (${s.pending})`,
        color: 'var(--status-pending)',
      },
      {
        key: 'in_progress',
        label: `In Progress (${s.inProgress})`,
        color: 'var(--status-in-progress)',
      },
      {
        key: 'blocked',
        label: `Blocked (${s.blocked})`,
        color: 'var(--status-blocked)',
      },
      {
        key: 'completed',
        label: `Completed (${s.completed})`,
        color: 'var(--status-completed)',
      },
      {
        key: 'cancelled',
        label: `Cancelled (${s.cancelled})`,
        color: 'var(--status-cancelled)',
      },
    ];

    const filterSelect = $('select-status-filter');
    if (filterSelect) {
      const optionsHtml = filterOptions
        .map(
          (opt) =>
            `<option value="${esc(opt.key)}">${esc(opt.label)}</option>`
        )
        .join('');
      setHtmlIfChanged(filterSelect, optionsHtml);
      filterSelect.value = state.statusFilter || 'all';
    }

    const activeOpt =
      filterOptions.find((o) => o.key === state.statusFilter) ||
      filterOptions[0];
    const filterWrap = $('status-filter-wrap');
    if (filterWrap) {
      filterWrap.classList.toggle('active', activeOpt.key !== 'all');
    }
    const filterDot = $('status-filter-dot');
    if (filterDot) {
      if (activeOpt.color) {
        filterDot.style.background = activeOpt.color;
        filterDot.classList.remove('hidden');
      } else {
        filterDot.classList.add('hidden');
      }
    }
  }

  // Compute Sugiyama-style layered DAG positions for visible nodes
  function computeDagLayout(nodes, edges, orient = 'TB') {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const inDeg = new Map();
    const parentsOf = new Map();
    const childrenOf = new Map();

    for (const n of nodes) {
      inDeg.set(n.id, 0);
      parentsOf.set(n.id, []);
      childrenOf.set(n.id, []);
    }

    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      childrenOf.get(e.from).push(e.to);
      parentsOf.get(e.to).push(e.from);
      inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    }

    // Assign layer = longest path from subgraph roots
    const layerMap = new Map();
    const queue = [];
    for (const n of nodes) {
      if ((inDeg.get(n.id) || 0) === 0) {
        layerMap.set(n.id, 0);
        queue.push(n.id);
      }
    }
    if (queue.length === 0 && nodes.length > 0) {
      layerMap.set(nodes[0].id, 0);
      queue.push(nodes[0].id);
    }

    const remIn = new Map(inDeg);
    const visited = new Set();
    while (queue.length > 0) {
      const u = queue.shift();
      visited.add(u);
      const uLayer = layerMap.get(u) || 0;
      for (const v of childrenOf.get(u) || []) {
        const nextL = Math.max(layerMap.get(v) || 0, uLayer + 1);
        layerMap.set(v, nextL);
        const r = (remIn.get(v) || 1) - 1;
        remIn.set(v, r);
        if (r <= 0 && !visited.has(v)) {
          queue.push(v);
        }
      }
    }

    for (const n of nodes) {
      if (!layerMap.has(n.id)) {
        layerMap.set(n.id, 0);
      }
    }

    // Group by layer
    const maxLayer = Math.max(0, ...layerMap.values());
    const layers = Array.from({ length: maxLayer + 1 }, () => []);
    for (const n of nodes) {
      layers[layerMap.get(n.id)].push(n);
    }

    // Initial deterministic order within each layer
    for (const layer of layers) {
      layer.sort((a, b) => (a.createdOrder ?? 0) - (b.createdOrder ?? 0));
    }

    // 2-pass barycenter sweep to reduce edge crossings
    for (let l = 1; l <= maxLayer; l++) {
      const prevIdx = new Map(layers[l - 1].map((n, i) => [n.id, i]));
      layers[l].sort((a, b) => {
        const pA = (parentsOf.get(a.id) || []).filter((id) => prevIdx.has(id));
        const pB = (parentsOf.get(b.id) || []).filter((id) => prevIdx.has(id));
        const bA =
          pA.length > 0
            ? pA.reduce((s, id) => s + prevIdx.get(id), 0) / pA.length
            : 999;
        const bB =
          pB.length > 0
            ? pB.reduce((s, id) => s + prevIdx.get(id), 0) / pB.length
            : 999;
        return bA - bB || (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
      });
    }

    const NODE_W = 196;
    const NODE_H = 66;
    const GAP_MAIN = orient === 'TB' ? 56 : 68;
    const GAP_CROSS = orient === 'TB' ? 24 : 20;
    const PAD = 32;

    const maxNodesInLayer = Math.max(1, ...layers.map((l) => l.length));
    const maxCrossSpan =
      maxNodesInLayer * (orient === 'TB' ? NODE_W : NODE_H) +
      (maxNodesInLayer - 1) * GAP_CROSS;

    const positions = new Map();
    layers.forEach((layer, lIdx) => {
      const count = layer.length;
      const layerSpan =
        count * (orient === 'TB' ? NODE_W : NODE_H) +
        Math.max(0, count - 1) * GAP_CROSS;
      const startCross = PAD + (maxCrossSpan - layerSpan) / 2;
      const mainCoord =
        PAD + lIdx * ((orient === 'TB' ? NODE_H : NODE_W) + GAP_MAIN);

      layer.forEach((node, idx) => {
        const crossCoord =
          startCross + idx * ((orient === 'TB' ? NODE_W : NODE_H) + GAP_CROSS);
        if (orient === 'TB') {
          positions.set(node.id, {
            x: crossCoord,
            y: mainCoord,
            w: NODE_W,
            h: NODE_H,
          });
        } else {
          positions.set(node.id, {
            x: mainCoord,
            y: crossCoord,
            w: NODE_W,
            h: NODE_H,
          });
        }
      });
    });

    const totalMain =
      PAD * 2 +
      (maxLayer + 1) * (orient === 'TB' ? NODE_H : NODE_W) +
      maxLayer * GAP_MAIN;
    const totalCross = PAD * 2 + maxCrossSpan;

    return {
      positions,
      width: orient === 'TB' ? Math.max(320, totalCross) : Math.max(320, totalMain),
      height: orient === 'TB' ? Math.max(220, totalMain) : Math.max(220, totalCross),
      nodeW: NODE_W,
      nodeH: NODE_H,
    };
  }

  function applySvgTransform() {
    const g = document.getElementById('dag-viewport-g');
    if (g) {
      g.setAttribute(
        'transform',
        `translate(${state.panX}, ${state.panY}) scale(${state.zoom})`
      );
    }
  }

  function zoomAtPoint(targetZoom, clientX, clientY) {
    const wrap = $('graph-canvas-wrap');
    const prevZoom = state.zoom || 1;
    const nextZoom = Math.max(0.3, Math.min(2.4, targetZoom));
    if (Math.abs(nextZoom - prevZoom) < 1e-6) return;

    let cx = 0;
    let cy = 0;
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      cx =
        typeof clientX === 'number'
          ? clientX - rect.left
          : (rect.width || 380) / 2;
      cy =
        typeof clientY === 'number'
          ? clientY - rect.top
          : (rect.height || 280) / 2;
    }

    const scaleRatio = nextZoom / prevZoom;
    state.panX = cx - (cx - state.panX) * scaleRatio;
    state.panY = cy - (cy - state.panY) * scaleRatio;
    state.zoom = nextZoom;
    applySvgTransform();
  }

  function fitGraphToViewport(layoutW, layoutH) {
    const wrap = $('graph-canvas-wrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const vw = rect.width || 380;
    const vh = rect.height || 280;
    const scaleX = (vw - 24) / Math.max(1, layoutW);
    const scaleY = (vh - 24) / Math.max(1, layoutH);
    const nextZoom = Math.max(0.45, Math.min(1.15, Math.min(scaleX, scaleY)));
    state.zoom = Number(nextZoom.toFixed(2));
    state.panX = Math.round((vw - layoutW * state.zoom) / 2);
    state.panY = Math.round(Math.max(12, (vh - layoutH * state.zoom) / 2));
    applySvgTransform();
  }

  function renderGraphView() {
    const svg = $('dag-svg');
    const emptyEl = $('graph-empty');
    const wrap = $('graph-canvas-wrap');
    const hintEl = $('graph-radius-hint');

    if (state.tasks.length === 0) {
      wrap.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      setHtmlIfChanged(
        emptyEl,
        `
        <div><strong>No tasks registered in this conversation yet.</strong></div>
        <div>Ask the agent to register tasks with dependencies using <code>task_register</code>.</div>
      `
      );
      if (hintEl) hintEl.textContent = '';
      return;
    }

    const sub = computeRadiusSubgraph();
    let visibleNodes = sub.nodes;
    if (state.statusFilter !== 'all') {
      visibleNodes = visibleNodes.filter((t) => {
        if (state.statusFilter === 'blocked') return t.isBlocked;
        return t.status === state.statusFilter;
      });
    }
    const visibleIdSet = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = sub.edges.filter(
      (e) => visibleIdSet.has(e.from) && visibleIdSet.has(e.to)
    );

    if (hintEl) {
      if (sub.isFiltered) {
        hintEl.textContent = `Centered on #${sub.centerId} (≤${sub.radius} hop${
          sub.radius > 1 ? 's' : ''
        }) · ${visibleNodes.length}/${sub.totalNodes} tasks`;
      } else {
        hintEl.textContent = `Showing ${visibleNodes.length} of ${sub.totalNodes} tasks (A → subtask)`;
      }
    }

    if (visibleNodes.length === 0) {
      wrap.classList.add('hidden');
      emptyEl.classList.remove('hidden');
      setHtmlIfChanged(
        emptyEl,
        `<div>No tasks match the active filter/radius.</div>`
      );
      return;
    }

    wrap.classList.remove('hidden');
    emptyEl.classList.add('hidden');

    const orient = state.graphOrient;
    const layout = computeDagLayout(visibleNodes, visibleEdges, orient);

    const layoutKey = `${orient}::${state.graphRadius}::${
      sub.isFiltered ? state.focusedTaskId : ''
    }::${visibleNodes.map((n) => n.id).join(',')}`;
    const shouldAutoFit = !state.hasFittedGraph || state.lastLayoutKey !== layoutKey;

    const edgesMarkup = visibleEdges
      .map((e) => {
        const fromPos = layout.positions.get(e.from);
        const toPos = layout.positions.get(e.to);
        if (!fromPos || !toPos) return '';

        let x1;
        let y1;
        let x2;
        let y2;
        let dPath;

        if (orient === 'TB') {
          x1 = fromPos.x + fromPos.w / 2;
          y1 = fromPos.y + fromPos.h;
          x2 = toPos.x + toPos.w / 2;
          y2 = toPos.y - 4;
          const cy = (y1 + y2) / 2;
          dPath = `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
        } else {
          x1 = fromPos.x + fromPos.w;
          y1 = fromPos.y + fromPos.h / 2;
          x2 = toPos.x - 4;
          y2 = toPos.y + toPos.h / 2;
          const cx = (x1 + x2) / 2;
          dPath = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
        }

        const isCompleted = e.depStatus === 'completed';
        const edgeClass = isCompleted ? 'completed' : 'blocking';
        const markerId = isCompleted ? 'arrow-completed' : 'arrow-blocking';

        return `<path class="dag-edge-path ${edgeClass}" d="${dPath}" marker-end="url(#${markerId})"><title>${esc(
          e.from
        )} depends on subtask ${esc(e.to)} (${esc(e.depStatus)})</title></path>`;
      })
      .join('');

    const nodesMarkup = visibleNodes
      .map((n) => {
        const pos = layout.positions.get(n.id);
        if (!pos) return '';
        const isFocused = n.id === state.focusedTaskId;
        const accentColor = statusColorVar(n);
        const truncTitle =
          n.title.length > 23 ? `${n.title.slice(0, 22)}…` : n.title;
        const truncId =
          n.id.length > 16 ? `#${n.id.slice(0, 15)}…` : `#${n.id}`;
        const fullId = `#${n.id}`;

        const titleW = Math.ceil(n.title.length * 6.8 + 28);
        const idW = Math.ceil(fullId.length * 6.4 + (n.isBlocked ? 72 : 28));
        const hoverW = Math.max(pos.w, titleW, idW);
        const hoverDx = hoverW - pos.w;

        const blockedBadgeMarkup = n.isBlocked
          ? `
          <rect x="${pos.w - 60}" y="24" width="52" height="15" rx="7.5" fill="var(--status-blocked-bg)"/>
          <text x="${
            pos.w - 34
          }" y="34.5" text-anchor="middle" fill="var(--status-blocked)" font-size="9" font-weight="700">BLOCKED</text>
        `
          : '';

        const depProgress =
          n.directTotalCount > 0
            ? `subtasks: ${n.directCompletedCount}/${n.directTotalCount} done`
            : 'leaf task';
        const timing = getTaskTiming(n);
        const durationLabel = timing.durationText;

        return `
        <g class="dag-node-group status-${esc(n.status)} ${
          isFocused ? 'focused' : ''
        }" transform="translate(${pos.x}, ${pos.y})" style="--hover-w:${hoverW}px;--hover-dx:${hoverDx}px" data-task-id="${esc(
          n.id
        )}">
          <rect class="dag-node-rect" width="${pos.w}" height="${
          pos.h
        }" rx="7" ry="7"/>
          <path d="M 0 7 Q 0 0 7 0 L 7 ${pos.h} Q 0 ${pos.h} 0 ${
          pos.h - 7
        } Z" fill="${accentColor}"/>

          <text class="dag-node-title dag-node-short" x="13" y="20" fill="var(--fg)" font-size="12" font-weight="600">${esc(
            truncTitle
          )}</text>
          <text class="dag-node-title dag-node-full" x="13" y="20" fill="var(--fg)" font-size="12" font-weight="600">${esc(
            n.title
          )}</text>
          <text class="dag-node-short" x="13" y="36" fill="var(--muted-fg)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10.5">${esc(
            truncId
          )}</text>
          <text class="dag-node-full" x="13" y="36" fill="var(--muted-fg)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10.5">${esc(
            fullId
          )}</text>

          <text x="13" y="54" fill="var(--muted-fg)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">${esc(
            depProgress
          )}</text>
          <g class="dag-node-right">
            ${blockedBadgeMarkup}
            ${
              durationLabel
                ? `<text x="${pos.w - 10}" y="54" text-anchor="end" fill="var(--muted-fg)" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">${esc(
                    durationLabel
                  )}</text>`
                : ''
            }
          </g>
        </g>
      `;
      })
      .join('');

    const svgHtml = `
      <defs>
        <marker id="arrow-completed" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--status-completed)"/>
        </marker>
        <marker id="arrow-blocking" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="var(--status-blocked)"/>
        </marker>
      </defs>
      <g id="dag-viewport-g" transform="translate(${state.panX}, ${state.panY}) scale(${state.zoom})">
        <g class="dag-edges-layer">${edgesMarkup}</g>
        <g class="dag-nodes-layer">${nodesMarkup}</g>
      </g>
    `;

    setHtmlIfChanged(svg, svgHtml);

    if (shouldAutoFit) {
      state.hasFittedGraph = true;
      state.lastLayoutKey = layoutKey;
      requestAnimationFrame(() => fitGraphToViewport(layout.width, layout.height));
    }
  }

  function renderListView() {
    const container = $('list-container');
    if (state.tasks.length === 0) {
      setHtmlIfChanged(
        container,
        `<div class="empty-state">
          <div><strong>No tasks registered yet.</strong></div>
          <div>Ask the agent to register tasks via <code>task_register</code>.</div>
        </div>`
      );
      return;
    }

    const list = getSortedFilteredTasks();
    if (list.length === 0) {
      setHtmlIfChanged(
        container,
        `<div class="empty-state">No tasks match your search or status filter.</div>`
      );
      return;
    }

    const rowsHtml = list
      .map((t) => {
        const isFocused = t.id === state.focusedTaskId;
        const borderClass = `status-${t.status}`;
        const relTime = formatRelativeTime(t.updatedAt || t.createdAt);

        const blockingHint =
          t.isBlocked && t.incompleteDependencies?.length
            ? `<span class="status-badge blocked" title="Blocked by incomplete subtasks: ${esc(
                t.incompleteDependencies.join(', ')
              )}">Blocked by ${t.incompleteDependencies.length}</span>`
            : t.isBlocked
            ? `<span class="status-badge blocked">Blocked</span>`
            : '';

        return `
        <div class="task-row ${borderClass} ${
          isFocused ? 'focused' : ''
        }" data-task-id="${esc(t.id)}">
          <div class="task-row-top">
            <div class="task-row-title-wrap">
              <span class="task-row-title" title="${esc(t.title)}">${esc(
          t.title
        )}</span>
              <span class="task-row-id" data-copy-id="${esc(
                t.id
              )}" title="Click to copy task ID">#${esc(t.id)}</span>
            </div>
            <div class="task-row-badges">
              ${blockingHint}
              <span class="status-badge ${esc(t.status)}">${esc(
          statusDisplayLabel(t.status)
        )}</span>
            </div>
          </div>
          <div class="task-row-meta">
            ${
              t.directTotalCount > 0
                ? `<span class="deg-pill">subtasks: ${t.directCompletedCount}/${t.directTotalCount} done</span>`
                : ''
            }
            <span>created #${(t.createdOrder ?? 0) + 1}${
          relTime ? ` · ${esc(relTime)}` : ''
        }</span>
          </div>
        </div>
      `;
      })
      .join('');

    setHtmlIfChanged(container, rowsHtml);
  }

  function renderDetailPanel() {
    const panel = $('detail-panel');
    const task = state.focusedTaskId
      ? state.tasks.find((t) => t.id === state.focusedTaskId) || null
      : null;

    if (!task) {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    panel.classList.toggle('collapsed', state.detailCollapsed);
    $('btn-detail-toggle').textContent = state.detailCollapsed ? '▴' : '▾';

    const idEl = $('detail-focused-id');
    idEl.textContent = `#${task.id}`;
    idEl.dataset.copyId = task.id;

    const statusEl = $('detail-status-badge');
    statusEl.className = `status-badge ${task.status}`;
    statusEl.textContent = statusDisplayLabel(task.status);

    $('detail-blocked-badge').classList.toggle('hidden', !task.isBlocked);

    const byId = new Map(state.tasks.map((t) => [t.id, t]));

    // Subtasks (dependsOn - Out-Degree)
    const depsHtml =
      task.dependsOn.length > 0
        ? task.dependsOn
            .map((depId) => {
              const dep = byId.get(depId);
              const st = dep ? dep.status : 'pending';
              const isBlocking = st !== 'completed';
              return `
              <button type="button" class="dep-chip ${
                isBlocking ? 'blocking' : 'completed'
              }" data-focus-task="${esc(depId)}" title="Click to focus subtask #${esc(
                depId
              )}">
                <span>${isBlocking ? '⏳' : '✓'}</span>
                <strong>${esc(dep ? dep.title : depId)}</strong>
                <code>#${esc(depId)}</code>
              </button>
            `;
            })
            .join('')
        : `<span style="color:var(--muted-fg);font-size:11px;">None (leaf task — no subtasks required)</span>`;

    // Parents (dependents - In-Degree)
    const parentsHtml =
      task.dependents.length > 0
        ? task.dependents
            .map((pId) => {
              const p = byId.get(pId);
              return `
              <button type="button" class="dep-chip" data-focus-task="${esc(
                pId
              )}" title="Click to focus parent task #${esc(pId)}">
                <span>↑</span>
                <strong>${esc(p ? p.title : pId)}</strong>
                <code>#${esc(pId)}</code>
              </button>
            `;
            })
            .join('')
        : `<span style="color:var(--muted-fg);font-size:11px;">None (top-level root task)</span>`;

    // Transitive blocking paths warning
    let transitiveBlockHtml = '';
    if (
      task.isBlocked &&
      Array.isArray(task.transitiveIncompleteDependencies) &&
      task.transitiveIncompleteDependencies.length > 0
    ) {
      const items = task.transitiveIncompleteDependencies
        .map(
          (item) =>
            `<code>${esc(item.pathString)}</code> (${esc(item.status)})`
        )
        .join(' · ');
      transitiveBlockHtml = `
        <div class="detail-box" style="border-color:color-mix(in srgb, var(--status-blocked) 45%, transparent);background:var(--status-blocked-bg);">
          <div class="detail-box-label" style="color:var(--status-blocked);">
            <span>Blocking Dependency Chain (Must complete before #${esc(
              task.id
            )})</span>
          </div>
          <div style="font-size:11px;">${items}</div>
        </div>
      `;
    }

    // Metadata key-values (str -> str mapping)
    const metaEntries = Object.entries(task.metadata || {}).filter(
      ([, v]) => typeof v === 'string' && v !== ''
    );
    const formatMetaVal = (val) => {
      if (val.startsWith('/') || val.startsWith('file://')) {
        return `<button type="button" class="meta-val-link" data-open-file="${esc(
          val
        )}">${esc(val)}</button>`;
      }
      if (val.startsWith('https://') || val.startsWith('http://')) {
        return `<a class="meta-val-link" href="${esc(
          val
        )}" target="_blank" rel="noopener noreferrer">${esc(val)}</a>`;
      }
      return esc(val);
    };

    const metaHtml =
      metaEntries.length > 0
        ? `
        <div class="detail-box">
          <div class="detail-box-label">
            <span>Metadata</span>
            <span>${metaEntries.length} field(s)</span>
          </div>
          <div class="meta-kv-list">
            ${metaEntries
              .map(
                ([k, v]) => `
              <span class="meta-kv">
                <span class="meta-key">${esc(k)}:</span>
                <span>${formatMetaVal(v)}</span>
              </span>
            `
              )
              .join('')}
          </div>
        </div>
      `
        : '';

    const timing = getTaskTiming(task);
    const timingItems = [];
    if (timing.startText) {
      timingItems.push(
        `<span class="detail-timing-item"><span class="detail-timing-key">Start:</span> <code>${esc(
          timing.startText
        )}</code></span>`
      );
    }
    if (timing.endText) {
      timingItems.push(
        `<span class="detail-timing-item"><span class="detail-timing-key">End:</span> <code>${esc(
          timing.endText
        )}</code></span>`
      );
    }
    if (timing.durationText) {
      timingItems.push(
        `<span class="detail-timing-item"><span class="detail-timing-key">Duration:</span> <code>${esc(
          timing.durationText
        )}</code></span>`
      );
    }
    const timingHtml =
      timingItems.length > 0
        ? `<div class="detail-timing-row">${timingItems.join('')}</div>`
        : '';

    const bodyHtml = `
      <h2 class="detail-title">${esc(task.title)}</h2>
      ${timingHtml}
      ${
        task.description
          ? `<div class="detail-desc">${esc(task.description)}</div>`
          : ''
      }
      ${transitiveBlockHtml}
      <div class="detail-grid">
        <div class="detail-box">
          <div class="detail-box-label">
            <span>Subtasks Required (depends_on)</span>
            <span>${task.directCompletedCount}/${
      task.directTotalCount
    } done</span>
          </div>
          <div class="dep-chip-list">${depsHtml}</div>
        </div>
        <div class="detail-box">
          <div class="detail-box-label">
            <span>Parent Tasks Waiting (dependents)</span>
            <span>${task.dependents.length}</span>
          </div>
          <div class="dep-chip-list">${parentsHtml}</div>
        </div>
      </div>
      ${metaHtml}
    `;

    setHtmlIfChanged($('detail-body'), bodyHtml);
  }

  function renderAll() {
    renderHeaderAndChips();

    // Toggle view tabs & sub-toolbars
    for (const view of ['graph', 'list']) {
      const tab = $(`tab-${view}`);
      const pane = $(`view-${view}`);
      const ctrl = $(`controls-${view}`);
      const isActive = state.activeView === view;
      if (tab) {
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', String(isActive));
      }
      if (pane) pane.classList.toggle('hidden', !isActive);
      if (ctrl) ctrl.classList.toggle('hidden', !isActive);
    }

    if (state.activeView === 'graph') {
      renderGraphView();
    } else if (state.activeView === 'list') {
      renderListView();
    }

    renderDetailPanel();
  }

  async function fetchState() {
    try {
      const cid = resolveConversationId();
      const data = await apiGet('/api/state', {
        conversationId: cid,
        radius: state.graphRadius,
        sortBy: state.sortBy,
        order: state.sortOrder,
      });

      if (data.uiAssetVersion) {
        if (
          state.uiAssetVersion &&
          state.uiAssetVersion !== data.uiAssetVersion
        ) {
          window.location.reload();
          return;
        }
        state.uiAssetVersion = data.uiAssetVersion;
      }

      state.isForkedSession = Boolean(data.isForkedSession);
      state.parentConversationId = data.parentConversationId || '';
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      state.edges = Array.isArray(data.edges) ? data.edges : [];
      if (data.summary) {
        state.summary = data.summary;
      }

      const taskExists = (id) => state.tasks.some((t) => t.id === id);

      if (
        typeof data.focusedStep === 'number' &&
        data.focusedStep > state.lastServerFocusedStep &&
        data.focusedTaskId &&
        taskExists(data.focusedTaskId)
      ) {
        state.lastServerFocusedStep = data.focusedStep;
        state.focusedTaskId = data.focusedTaskId;
        state.userUnfocused = false;
      } else if (
        !state.userUnfocused &&
        (!state.focusedTaskId || !taskExists(state.focusedTaskId))
      ) {
        state.focusedTaskId = data.focusedTaskId || state.tasks[0]?.id || '';
      } else if (state.focusedTaskId && !taskExists(state.focusedTaskId)) {
        state.focusedTaskId = '';
      }

      renderAll();
    } catch (err) {
      console.error('[task_ui] fetchState error:', err);
    }
  }

  // Event bindings
  document.addEventListener('click', (e) => {
    const viewTab = e.target.closest('.view-tab');
    if (viewTab) {
      state.activeView = viewTab.dataset.view || 'graph';
      renderAll();
      return;
    }

    const radiusBtn = e.target.closest('[data-radius]');
    if (radiusBtn) {
      state.graphRadius = radiusBtn.dataset.radius || 'all';
      for (const b of document.querySelectorAll('#radius-group .seg-btn')) {
        b.classList.toggle('active', b === radiusBtn);
      }
      renderAll();
      return;
    }

    const orientBtn = e.target.closest('[data-orient]');
    if (orientBtn) {
      state.graphOrient = orientBtn.dataset.orient || 'TB';
      for (const b of document.querySelectorAll('#orient-group .seg-btn')) {
        b.classList.toggle('active', b === orientBtn);
      }
      renderAll();
      return;
    }

    const copyIdEl = e.target.closest('[data-copy-id]');
    if (copyIdEl) {
      e.stopPropagation();
      const id = copyIdEl.dataset.copyId;
      if (id) copyText(id, `Copied task ID: ${id}`);
      return;
    }

    const openFileBtn = e.target.closest('[data-open-file]');
    if (openFileBtn) {
      e.stopPropagation();
      openFileInAuxPane(openFileBtn.dataset.openFile);
      return;
    }

    const focusChip = e.target.closest('[data-focus-task]');
    if (focusChip) {
      e.stopPropagation();
      focusTask(focusChip.dataset.focusTask);
      return;
    }

    const dagNode = e.target.closest('.dag-node-group');
    if (dagNode && dagNode.dataset.taskId) {
      focusTask(dagNode.dataset.taskId);
      return;
    }

    const taskRow = e.target.closest('.task-row');
    if (taskRow && taskRow.dataset.taskId) {
      focusTask(taskRow.dataset.taskId);
      return;
    }

    if (e.target.closest('#viewport-section')) {
      if (hasDraggedCanvas) {
        hasDraggedCanvas = false;
        return;
      }
      unfocusTask();
    }
  });

  $('btn-refresh')?.addEventListener('click', () => {
    fetchState();
    showToast('Refreshed task DAG');
  });

  $('chk-live')?.addEventListener('change', (e) => {
    state.live = e.target.checked;
  });

  $('btn-zoom-in')?.addEventListener('click', () => {
    zoomAtPoint(state.zoom * 1.2);
  });

  $('btn-zoom-out')?.addEventListener('click', () => {
    zoomAtPoint(state.zoom / 1.2);
  });

  $('btn-zoom-fit')?.addEventListener('click', () => {
    state.hasFittedGraph = false;
    renderGraphView();
  });

  $('select-status-filter')?.addEventListener('change', (e) => {
    state.statusFilter = e.target.value || 'all';
    renderAll();
  });

  $('list-search')?.addEventListener('input', (e) => {
    state.listSearch = e.target.value || '';
    renderListView();
  });

  $('select-sort')?.addEventListener('change', (e) => {
    state.sortBy = e.target.value || 'created';
    renderListView();
  });

  $('btn-sort-order')?.addEventListener('click', () => {
    state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
    $('btn-sort-order').textContent =
      state.sortOrder === 'asc' ? '↑ Asc' : '↓ Desc';
    renderListView();
  });

  $('btn-detail-toggle')?.addEventListener('click', () => {
    state.detailCollapsed = !state.detailCollapsed;
    renderDetailPanel();
  });

  // Graph canvas pan & wheel zoom
  const canvasWrap = $('graph-canvas-wrap');
  let isDragging = false;
  let hasDraggedCanvas = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let startPanX = 0;
  let startPanY = 0;

  canvasWrap?.addEventListener('pointerover', (e) => {
    if (isDragging) return;
    const dagNode = e.target.closest('.dag-node-group');
    if (
      dagNode &&
      dagNode.parentNode &&
      dagNode.parentNode.lastElementChild !== dagNode
    ) {
      dagNode.parentNode.appendChild(dagNode);
    }
  });

  canvasWrap?.addEventListener('mousedown', (e) => {
    if (e.target.closest('.dag-node-group')) return;
    isDragging = true;
    hasDraggedCanvas = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startPanX = state.panX;
    startPanY = state.panY;
    canvasWrap.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.hypot(dx, dy) > 4) {
      hasDraggedCanvas = true;
    }
    state.panX = startPanX + dx;
    state.panY = startPanY + dy;
    applySvgTransform();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      canvasWrap?.classList.remove('dragging');
    }
  });

  canvasWrap?.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const clampedDelta = Math.max(-120, Math.min(120, e.deltaY));
      const factor = Math.exp(-clampedDelta * 0.002);
      zoomAtPoint(state.zoom * factor, e.clientX, e.clientY);
    },
    { passive: false }
  );

  // Initial load + polling
  fetchState();
  setInterval(() => {
    if (state.live && !document.hidden) {
      fetchState();
    }
  }, POLL_INTERVAL_MS);
})();
