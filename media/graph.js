// Conversation graph webview: vertical spine / horizontal timeline / linear
// transcript views of a Claude Code session, with abandoned forks collapsed
// by default and subagent fan-outs in the style of claude-code-transcripts.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const AGENT_COLORS = ['#7e57c2', '#26a69a', '#ef6c00', '#42a5f5', '#ec407a', '#43a047'];
  const FORK_COLOR = '#ec407a';
  const SPINE_COLOR = '#b0bec5';

  const state = {
    graph: null,
    view: 'graph', // 'graph' | 'linear'
    orientation: 'vertical', // 'vertical' | 'horizontal'
    focus: null, // primary uuid to ring/scroll to
    focusSet: new Set(), // all uuids tinted by a range focus
    focusAgent: null, // agentId focused by claude:sid@agent refs
    search: '',
    expandedForks: new Set(),
    peek: null, // {kind:'msg', uuid} | {kind:'agent', agentId}
  };

  // Focus specs arrive as null | {kind:'msg',uuid} | {kind:'range',from,to} |
  // {kind:'agent',agentId} (legacy: bare uuid string).
  function applyFocus(spec) {
    state.focus = null;
    state.focusSet = new Set();
    state.focusAgent = null;
    if (!spec) return;
    if (typeof spec === 'string') spec = { kind: 'msg', uuid: spec };
    if (spec.kind === 'agent') {
      state.focusAgent = spec.agentId;
      if (agentById(spec.agentId)) state.peek = { kind: 'agent', agentId: spec.agentId };
      return;
    }
    if (spec.kind === 'range') {
      state.focus = spec.from;
      // Collect every message between from..to along an ordered walk of the
      // graph (main path with forks spliced in), inclusive; tolerate reversed
      // or partially-missing endpoints.
      const order = [];
      state.graph.mainPath.forEach((u) => order.push(u));
      state.graph.forks.forEach((f) => f.uuids.forEach((u) => order.push(u)));
      let i = order.indexOf(spec.from);
      let j = order.indexOf(spec.to);
      if (i === -1) i = j;
      if (j === -1) j = i;
      if (i !== -1) {
        if (i > j) [i, j] = [j, i];
        for (let k = i; k <= j; k++) state.focusSet.add(order[k]);
        state.focus = order[i];
      }
    } else if (spec.uuid) {
      state.focus = spec.uuid;
      state.focusSet.add(spec.uuid);
    }
    state.graph.forks.forEach((f, idx) => {
      if (f.uuids.some((u) => state.focusSet.has(u))) state.expandedForks.add(idx);
    });
    if (state.focus && byUuid(state.focus)) state.peek = { kind: 'msg', uuid: state.focus };
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'load') {
      state.graph = msg.graph;
      state.view = msg.view || 'graph';
      state.orientation = msg.orientation || 'vertical';
      state.expandedForks = new Set();
      state.peek = null;
      state.search = '';
      applyFocus(msg.focus || null);
      if (state.focusAgent && state.view === 'graph') {
        // agent focus works in both views; nothing extra needed here
      }
      render();
      scrollToFocus();
    }
  });

  function byUuid(uuid) {
    return state.graph ? state.graph.messages.find((m) => m.uuid === uuid) : null;
  }
  function agentById(id) {
    return state.graph ? state.graph.subagents.find((a) => a.agentId === id) : null;
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function svg(tag, attrs, ...children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') {
        node.addEventListener('click', v);
        node.classList.add('gclick');
      } else if (k === 'class') node.setAttribute('class', v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function trunc(text, n) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  // ---------------- layout ----------------
  // Rows are laid out along the spine axis `t`; each row belongs to a lane
  // (main | fork | agent). Vertical mode maps lanes to x and t to y;
  // horizontal mode transposes.
  function buildRows() {
    const g = state.graph;
    const rows = [];
    const forksByParent = new Map();
    g.forks.forEach((f, i) => {
      const list = forksByParent.get(f.fromUuid) || [];
      list.push(i);
      forksByParent.set(f.fromUuid, list);
    });
    let agentSeq = 0;
    for (const uuid of g.mainPath) {
      const msg = byUuid(uuid);
      if (!msg) continue;
      rows.push({ kind: 'msg', msg });
      for (const agentId of msg.spawns) {
        rows.push({ kind: 'agent', agent: agentById(agentId), spawnerUuid: uuid, colorIndex: agentSeq++ });
      }
      for (const forkIndex of forksByParent.get(uuid) || []) {
        const fork = g.forks[forkIndex];
        if (state.expandedForks.has(forkIndex)) {
          rows.push({ kind: 'forkHeader', forkIndex, fromUuid: uuid, count: fork.uuids.length });
          for (const fu of fork.uuids) {
            const fm = byUuid(fu);
            if (fm) rows.push({ kind: 'forkMsg', msg: fm, forkIndex });
          }
        } else {
          rows.push({ kind: 'stub', forkIndex, fromUuid: uuid, count: fork.uuids.length });
        }
      }
    }
    return rows;
  }

  function renderGraphSvg() {
    const vertical = state.orientation === 'vertical';
    const rows = buildRows();
    const stepMsg = vertical ? 46 : 120;
    const stepAgent = vertical ? 62 : 170;
    // lane offsets along the cross axis
    const LANE = vertical
      ? { main: 60, fork: 200, agent: 250, agentCard: 250 }
      : { main: 170, fork: 60, agent: 280, agentCard: 280 };
    const cardW = vertical ? 330 : 150;
    const cardH = vertical ? 46 : 54;

    // Assign t positions and remember spine positions per uuid.
    let t = 30;
    const tOf = new Map();
    for (const row of rows) {
      row.t = t;
      if (row.kind === 'msg') tOf.set(row.msg.uuid, t);
      t += row.kind === 'agent' ? stepAgent : stepMsg;
    }
    const extent = t + 20;
    const crossExtent = vertical ? LANE.agentCard + cardW + 30 : LANE.agent + cardH + 140;
    const width = vertical ? crossExtent : extent;
    const height = vertical ? extent : crossExtent;
    const pt = (lane, tv) => (vertical ? [lane, tv] : [tv, lane]);

    const root = svg('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: width,
      height: height,
      role: 'img',
      'aria-label': 'Conversation graph',
    });

    // spine
    const mains = rows.filter((r) => r.kind === 'msg');
    if (mains.length > 1) {
      const [x1, y1] = pt(LANE.main, mains[0].t);
      const [x2, y2] = pt(LANE.main, mains[mains.length - 1].t);
      root.append(svg('line', { x1, y1, x2, y2, stroke: SPINE_COLOR, 'stroke-width': 3 }));
    }
    {
      const [lx, ly] = pt(LANE.main, 12);
      root.append(svg('text', { x: vertical ? lx : 16, y: vertical ? ly : ly - 14, class: 'gspine-label', 'text-anchor': 'middle' }, 'main'));
    }

    for (const row of rows) {
      if (row.kind === 'msg') {
        const m = row.msg;
        const [cx, cy] = pt(LANE.main, row.t);
        const isFocus = state.focus === m.uuid;
        const inSet = state.focusSet.has(m.uuid);
        const fill = m.role === 'assistant' ? 'var(--vscode-charts-orange)' : 'var(--vscode-charts-blue)';
        if (isFocus) root.append(svg('circle', { cx, cy, r: 10, class: 'gfocus-ring' }));
        else if (inSet) root.append(svg('circle', { cx, cy, r: 9, class: 'gfocus-ring', 'stroke-opacity': 0.45 }));
        root.append(
          svg('circle', {
            cx, cy, r: 5.5, fill,
            'data-uuid': m.uuid,
            onclick: () => setPeek({ kind: 'msg', uuid: m.uuid }),
          }),
        );
        const label = `${m.role === 'assistant' ? '✳' : '›'} ${trunc(m.text || (m.toolUses[0] ? m.toolUses[0].name + ': ' + m.toolUses[0].summary : '(no text)'), vertical ? 46 : 18)}`;
        const [tx, ty] = vertical ? [cx + 16, cy + 4] : [cx, cy + 20];
        root.append(
          svg('text', {
            x: tx, y: ty, class: 'gtext',
            'text-anchor': vertical ? 'start' : 'middle',
            onclick: () => setPeek({ kind: 'msg', uuid: m.uuid }),
          }, label),
        );
      } else if (row.kind === 'agent' && row.agent) {
        const a = row.agent;
        const color = AGENT_COLORS[row.colorIndex % AGENT_COLORS.length];
        const spawnT = tOf.get(row.spawnerUuid) ?? row.t;
        const [sx, sy] = pt(LANE.main, spawnT);
        const cardT = row.t;
        const [cx0, cy0] = pt(LANE.agentCard, cardT);
        const cardX = vertical ? cx0 : cx0 - cardW / 2;
        const cardY = vertical ? cy0 - cardH / 2 : cy0;
        const [ex, ey] = vertical ? [cardX, cy0] : [cx0, cardY];
        const midMain = vertical ? (cardX - sx) * 0.55 : (cardY - sy) * 0.55;
        const d = vertical
          ? `M ${sx} ${sy} C ${sx + midMain} ${sy}, ${ex - midMain} ${ey}, ${ex} ${ey}`
          : `M ${sx} ${sy} C ${sx} ${sy + midMain}, ${ex} ${ey - midMain}, ${ex} ${ey}`;
        root.append(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.5 }));
        root.append(svg('circle', { cx: sx, cy: sy, r: 6.5, fill: color, stroke: 'var(--vscode-editor-background)', 'stroke-width': 2 }));
        const group = svg('g', { onclick: () => setPeek({ kind: 'agent', agentId: a.agentId }) });
        group.setAttribute('data-agent', a.agentId);
        if (state.focusAgent === a.agentId) {
          group.append(svg('rect', { x: cardX - 3, y: cardY - 3, width: cardW + 6, height: cardH + 6, rx: 8, class: 'gfocus-ring' }));
        }
        group.append(svg('rect', { x: cardX, y: cardY, width: cardW, height: cardH, rx: 6, class: 'gnode-card', stroke: color }));
        group.append(svg('text', { x: cardX + 10, y: cardY + 18, class: 'gtext' }, trunc(a.description || 'Subagent', vertical ? 46 : 20)));
        group.append(svg('text', { x: cardX + 10, y: cardY + 34, class: 'gmeta-text' }, agentMetaLine(a, vertical ? 60 : 22)));
        root.append(group);
      } else if (row.kind === 'stub') {
        const spawnT = tOf.get(row.fromUuid) ?? row.t;
        const [sx, sy] = pt(LANE.main, spawnT);
        const [cx, cy] = pt(LANE.fork, row.t);
        root.append(svg('path', {
          d: `M ${sx} ${sy} Q ${vertical ? cx : sx} ${vertical ? sy : cy}, ${cx} ${cy}`,
          fill: 'none', stroke: FORK_COLOR, 'stroke-width': 2, 'stroke-dasharray': '4 3',
        }));
        const w = 190, h = 24;
        const group = svg('g', { onclick: () => toggleFork(row.forkIndex) });
        group.append(svg('rect', { x: cx, y: cy - h / 2, width: w, height: h, rx: 12, class: 'gstub' }));
        group.append(svg('text', { x: cx + 12, y: cy + 4, class: 'gtext' }, `⑂ ${row.count} abandoned message${row.count === 1 ? '' : 's'}`));
        root.append(group);
      } else if (row.kind === 'forkHeader') {
        const [cx, cy] = pt(LANE.fork, row.t);
        const group = svg('g', { onclick: () => toggleFork(row.forkIndex) });
        group.append(svg('text', { x: vertical ? cx : cx - 40, y: cy + 4, class: 'gtext', fill: FORK_COLOR }, `⑂ fork — click to collapse`));
        root.append(group);
      } else if (row.kind === 'forkMsg') {
        const m = row.msg;
        const [cx, cy] = pt(LANE.fork, row.t);
        const isFocus = state.focus === m.uuid;
        if (isFocus) root.append(svg('circle', { cx, cy, r: 9, class: 'gfocus-ring' }));
        else if (state.focusSet.has(m.uuid)) root.append(svg('circle', { cx, cy, r: 8, class: 'gfocus-ring', 'stroke-opacity': 0.45 }));
        root.append(svg('circle', {
          cx, cy, r: 4.5, fill: FORK_COLOR, 'data-uuid': m.uuid,
          onclick: () => setPeek({ kind: 'msg', uuid: m.uuid }),
        }));
        const [tx, ty] = vertical ? [cx + 12, cy + 4] : [cx, cy - 12];
        root.append(svg('text', {
          x: tx, y: ty, class: 'gmeta-text', 'text-anchor': vertical ? 'start' : 'middle',
          onclick: () => setPeek({ kind: 'msg', uuid: m.uuid }),
        }, trunc(m.text || '(no text)', vertical ? 44 : 18)));
      }
    }

    // connect fork rows with a pink chain (vertical only adds clarity)
    return root;
  }

  function agentMetaLine(a, n) {
    const bits = [];
    if (a.agentType) bits.push(a.agentType);
    if (a.totalToolUseCount) bits.push(`${a.totalToolUseCount} tools`);
    if (a.totalDurationMs) bits.push(formatDuration(a.totalDurationMs));
    if (a.totalTokens) bits.push(`${Math.round(a.totalTokens / 100) / 10}k tok`);
    return trunc(bits.join(' · '), n);
  }
  function formatDuration(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }

  // ---------------- linear view ----------------
  function renderLinear() {
    const g = state.graph;
    const container = el('div', { class: 'linear' });
    const forksByParent = new Map();
    g.forks.forEach((f, i) => {
      const list = forksByParent.get(f.fromUuid) || [];
      list.push(i);
      forksByParent.set(f.fromUuid, list);
    });
    let shown = 0;
    for (const uuid of g.mainPath) {
      const m = byUuid(uuid);
      if (!m) continue;
      if (matchesSearch(m)) {
        container.append(messageCard(m, false));
        shown++;
      }
      for (const agentId of m.spawns) {
        const a = agentById(agentId);
        if (a && (!state.search || a.messages.some(matchesSearch) || matchesSearch({ text: a.description, uuid: a.agentId, toolUses: [] }))) container.append(subagentBlock(a));
      }
      for (const forkIndex of forksByParent.get(uuid) || []) {
        const fork = g.forks[forkIndex];
        const details = el('details', { class: 'fork-block' });
        if (state.expandedForks.has(forkIndex) || fork.uuids.includes(state.focus)) details.setAttribute('open', '');
        details.append(el('summary', {}, `⑂ Abandoned branch — ${fork.uuids.length} message${fork.uuids.length === 1 ? '' : 's'}`));
        const inner = el('div', { class: 'inner' });
        for (const fu of fork.uuids) {
          const fm = byUuid(fu);
          if (fm && matchesSearch(fm)) inner.append(messageCard(fm, true));
        }
        details.append(inner);
        if (!state.search || inner.children.length > 0) container.append(details);
      }
    }
    if (state.search && shown === 0) {
      container.append(el('div', { class: 'truncate-note' }, `No messages match “${state.search}”.`));
    }
    return container;
  }

  function matchesSearch(m) {
    if (!state.search) return true;
    const q = state.search.toLowerCase();
    return (
      (m.text || '').toLowerCase().includes(q) ||
      m.uuid.toLowerCase().startsWith(q) ||
      m.toolUses.some((t) => (t.name + ' ' + t.summary).toLowerCase().includes(q))
    );
  }

  function messageCard(m, isFork) {
    const focused = state.focus === m.uuid || state.focusSet.has(m.uuid);
    const card = el('div', { class: `msg ${m.role}${focused ? ' focused' : ''}`, 'data-uuid': m.uuid });
    const when = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
    card.append(
      el('div', { class: 'head' },
        el('b', {}, m.role === 'assistant' ? '✳ assistant' : m.role),
        el('span', {}, `#${m.uuid.slice(0, 8)}`),
        el('span', {}, when),
        isFork ? el('span', { style: 'color:#ec407a' }, 'fork') : null,
        el('span', {
          class: 'copy',
          title: 'Copy claude:… deeplink for this message',
          onclick: () => vscode.postMessage({ type: 'copyLink', uuid: m.uuid }),
        }, '🔗 copy link'),
      ),
    );
    if (m.text) {
      const bodyText = m.text.length > 4000 ? m.text.slice(0, 4000) : m.text;
      card.append(el('div', { class: 'body' }, bodyText));
      if (m.text.length > 4000) card.append(el('div', { class: 'truncate-note' }, `(${m.text.length - 4000} more chars truncated)`));
    }
    for (const t of m.toolUses) {
      card.append(el('span', { class: 'tooluse' }, `⚒ ${t.name}${t.summary ? ` — ${t.summary}` : ''}`));
    }
    return card;
  }

  function subagentBlock(a) {
    const details = el('details', { class: 'subagent-block', id: `agent-${a.agentId}` });
    if (state.focusAgent === a.agentId || state.search) details.setAttribute('open', '');
    details.append(
      el('summary', {},
        `🤖 ${a.description || 'Subagent'} `,
        el('span', { class: 'sub-meta' }, agentMetaLine(a, 80)),
      ),
    );
    const inner = el('div', { class: 'inner' });
    if (a.messages.length > 0) {
      for (const m of a.messages) inner.append(messageCard(m, false));
    } else if (a.resultPreview) {
      inner.append(el('div', { class: 'msg assistant' }, el('div', { class: 'body' }, a.resultPreview)));
      inner.append(el('div', { class: 'truncate-note' }, 'Full transcript not vendored for this subagent — showing result summary.'));
    } else {
      inner.append(el('div', { class: 'truncate-note' }, 'No transcript available.'));
    }
    details.append(inner);
    return details;
  }

  // ---------------- peek ----------------
  function renderPeek() {
    if (!state.peek) return null;
    const peek = el('div', { class: 'peek' });
    if (state.peek.kind === 'msg') {
      const m = byUuid(state.peek.uuid);
      if (!m) return null;
      const when = m.timestamp ? new Date(m.timestamp).toLocaleString() : '';
      peek.append(
        el('div', { class: 'who' },
          `${m.role === 'assistant' ? '✳ assistant' : m.role} · #${m.uuid.slice(0, 8)} `,
          el('span', { class: 'dim' }, when),
        ),
      );
      peek.append(el('pre', {}, m.text || '(no text content)'));
      for (const t of m.toolUses) peek.append(el('span', { class: 'tooluse' }, `⚒ ${t.name}${t.summary ? ` — ${t.summary}` : ''}`));
      peek.append(
        el('div', { class: 'actions' },
          el('button', { class: 'tbtn', onclick: () => vscode.postMessage({ type: 'copyLink', uuid: m.uuid }) }, 'Copy msg link'),
          el('button', { class: 'tbtn', onclick: () => { state.view = 'linear'; render(); scrollToFocusUuid(m.uuid); } }, 'Show in transcript'),
          el('button', { class: 'tbtn', onclick: () => { state.peek = null; render(); } }, 'Close'),
        ),
      );
    } else {
      const a = agentById(state.peek.agentId);
      if (!a) return null;
      peek.append(el('div', { class: 'who' }, `🤖 ${a.description || 'Subagent'} `, el('span', { class: 'dim' }, agentMetaLine(a, 120))));
      peek.append(el('pre', {}, a.resultPreview || '(no result preview)'));
      peek.append(
        el('div', { class: 'actions' },
          el('button', { class: 'tbtn', onclick: () => vscode.postMessage({ type: 'copyLink', agentId: a.agentId }) }, 'Copy agent link'),
          el('button', {
            class: 'tbtn',
            onclick: () => { state.view = 'linear'; render(); const n = document.getElementById(`agent-${a.agentId}`); if (n) { n.setAttribute('open', ''); n.scrollIntoView({ block: 'start', behavior: 'smooth' }); } },
          }, `Open transcript (${a.messages.length} msgs)`),
          el('button', { class: 'tbtn', onclick: () => { state.peek = null; render(); } }, 'Close'),
        ),
      );
    }
    return peek;
  }

  // ---------------- shell ----------------
  function render() {
    app.textContent = '';
    if (!state.graph) return;
    const g = state.graph;

    const meta = `${g.messages.length} msgs · ${g.forks.length} fork${g.forks.length === 1 ? '' : 's'} · ${g.subagents.length} subagent${g.subagents.length === 1 ? '' : 's'}`;
    const toolbar = el('div', { class: 'toolbar' },
      el('span', { class: 'title', title: g.title }, `✳ ${g.title || g.sessionId}`),
      el('span', { class: 'meta' }, meta),
      el('button', { class: `tbtn ${state.view === 'graph' ? 'active' : ''}`, onclick: () => { state.view = 'graph'; render(); } }, 'Graph'),
      el('button', { class: `tbtn ${state.view === 'linear' ? 'active' : ''}`, onclick: () => { state.view = 'linear'; render(); } }, 'Linear'),
    );
    if (state.view === 'graph') {
      toolbar.append(
        el('button', {
          class: 'tbtn',
          title: 'Toggle orientation',
          onclick: () => { state.orientation = state.orientation === 'vertical' ? 'horizontal' : 'vertical'; render(); },
        }, state.orientation === 'vertical' ? '↓ vertical' : '→ horizontal'),
      );
    } else {
      const search = el('input', { class: 'search', type: 'search', placeholder: 'Filter messages…' });
      search.value = state.search;
      let searchTimer;
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          state.search = search.value.trim();
          const canvas = app.querySelector('.canvas');
          if (canvas) { canvas.textContent = ''; canvas.append(renderLinear()); }
        }, 150);
      });
      toolbar.append(search);
    }
    app.append(toolbar);

    if (state.view === 'graph') {
      app.append(el('div', { class: 'legend' },
        legendItem(SPINE_COLOR, 'main'),
        legendItem(FORK_COLOR, 'fork (abandoned)'),
        legendItem(AGENT_COLORS[0], 'subagents'),
      ));
    }

    const canvas = el('div', { class: 'canvas' });
    canvas.append(state.view === 'graph' ? renderGraphSvg() : renderLinear());
    app.append(canvas);

    const peek = renderPeek();
    if (peek) app.append(peek);
  }

  function legendItem(color, label) {
    const i = el('i');
    i.style.background = color;
    return el('span', {}, i, ` ${label}`);
  }

  function setPeek(p) {
    state.peek = p;
    render();
  }
  function toggleFork(i) {
    if (state.expandedForks.has(i)) state.expandedForks.delete(i);
    else state.expandedForks.add(i);
    render();
  }
  function scrollToFocus() {
    if (state.focusAgent) {
      requestAnimationFrame(() => {
        const node = document.querySelector(`[data-agent="${CSS.escape(state.focusAgent)}"], #agent-${CSS.escape(state.focusAgent)}`);
        if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
      return;
    }
    if (state.focus) scrollToFocusUuid(state.focus);
  }
  function scrollToFocusUuid(uuid) {
    requestAnimationFrame(() => {
      const node = document.querySelector(`[data-uuid="${CSS.escape(uuid)}"]`);
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }

  vscode.postMessage({ type: 'ready' });
})();
