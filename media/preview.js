// Commentable markdown preview: renders extension-provided HTML (with
// data-line source mapping), overlays comment highlights, and lets the user
// select rendered text to start a thread — same threads as the text editor.
(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('content');
  const overlay = document.getElementById('overlay');
  let threads = [];
  let pendingSelection = null; // {startLine, endLine, selectedText, rect}

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'render') {
      threads = msg.threads || [];
      content.innerHTML = msg.html;
      applyHighlights();
    }
  });

  // ---------- highlights ----------

  function blocksForLine(line) {
    const out = [];
    for (const node of content.querySelectorAll('[data-line]')) {
      const start = Number(node.getAttribute('data-line'));
      const end = Number(node.getAttribute('data-line-end') || start + 1);
      if (line >= start && line < end) out.push(node);
    }
    // innermost (deepest) blocks last; prefer them.
    return out;
  }

  function applyHighlights() {
    for (const t of threads) {
      if (t.status === 'resolved') continue;
      const blocks = blocksForLine(t.startLine);
      const block = blocks[blocks.length - 1];
      if (!block) continue;
      const needle = normalize(t.anchorText);
      if (needle && wrapTextInBlock(block, needle, t.id)) continue;
      // Fallback: highlight the whole block.
      block.classList.add('cmt-block-highlight');
      block.dataset.threadId = t.id;
      block.addEventListener('click', onHighlightClick);
    }
  }

  function normalize(s) {
    return (s || '')
      .replace(/[#*_`>\[\]()]/g, ' ') // strip markdown syntax chars
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Find `needle` in the block's rendered text and wrap it in <mark>. */
  function wrapTextInBlock(block, needle, threadId) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let full = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: full.length });
      full += n.textContent;
    }
    const normFull = full.replace(/\s+/g, ' ');
    // Map normalized index back to raw index (whitespace runs collapse).
    const idxNorm = normFull.indexOf(needle);
    if (idxNorm === -1) return false;
    const rawStart = normIndexToRaw(full, idxNorm);
    const rawEnd = normIndexToRaw(full, idxNorm + needle.length);
    if (rawStart == null || rawEnd == null || rawEnd <= rawStart) return false;

    const range = document.createRange();
    const startLoc = locate(nodes, rawStart);
    const endLoc = locate(nodes, rawEnd);
    if (!startLoc || !endLoc) return false;
    try {
      range.setStart(startLoc.node, startLoc.offset);
      range.setEnd(endLoc.node, endLoc.offset);
      const mark = document.createElement('mark');
      mark.className = 'cmt-highlight';
      mark.dataset.threadId = threadId;
      mark.title = 'View comment thread';
      range.surroundContents(mark);
      mark.addEventListener('click', onHighlightClick);
      return true;
    } catch {
      return false; // range crosses element boundaries — fall back to block
    }
  }

  function normIndexToRaw(raw, normIdx) {
    let n = 0;
    let inWs = false;
    for (let i = 0; i < raw.length; i++) {
      const isWs = /\s/.test(raw[i]);
      if (isWs && inWs) continue;
      if (n === normIdx) return i;
      n++;
      inWs = isWs;
    }
    return n === normIdx ? raw.length : null;
  }

  function locate(nodes, rawIndex) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (rawIndex >= nodes[i].start) {
        return { node: nodes[i].node, offset: Math.min(rawIndex - nodes[i].start, nodes[i].node.textContent.length) };
      }
    }
    return null;
  }

  function onHighlightClick(e) {
    e.stopPropagation();
    const threadId = e.currentTarget.dataset.threadId;
    const t = threads.find((x) => x.id === threadId);
    if (t) showThreadPopover(t, e.pageX, e.pageY);
  }

  // ---------- selection → new comment ----------

  document.addEventListener('mouseup', (e) => {
    if (e.target.closest('.cmt-popover') || e.target.id === 'comment-fab') return;
    removeFab();
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      const range = sel.getRangeAt(0);
      if (!content.contains(range.commonAncestorContainer)) return;
      const startBlock = closestLineBlock(range.startContainer);
      const endBlock = closestLineBlock(range.endContainer);
      if (!startBlock) return;
      const rect = range.getBoundingClientRect();
      pendingSelection = {
        startLine: Number(startBlock.getAttribute('data-line')),
        endLine: endBlock
          ? Number(endBlock.getAttribute('data-line-end') || endBlock.getAttribute('data-line')) - 1
          : Number(startBlock.getAttribute('data-line-end') || startBlock.getAttribute('data-line')) - 1,
        selectedText: sel.toString(),
      };
      showFab(rect);
    }, 0);
  });

  function closestLineBlock(node) {
    let cur = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (cur && cur !== content) {
      if (cur.hasAttribute && cur.hasAttribute('data-line')) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function showFab(rect) {
    const fab = document.createElement('button');
    fab.id = 'comment-fab';
    fab.textContent = '💬 Comment';
    fab.style.left = `${window.scrollX + rect.right + 8}px`;
    fab.style.top = `${window.scrollY + rect.top - 6}px`;
    fab.addEventListener('click', () => {
      const s = pendingSelection;
      removeFab();
      if (s) showComposePopover(s, window.scrollX + rect.left, window.scrollY + rect.bottom + 8);
    });
    overlay.append(fab);
  }

  function removeFab() {
    const fab = document.getElementById('comment-fab');
    if (fab) fab.remove();
  }

  // ---------- popovers ----------

  function closePopovers() {
    for (const p of overlay.querySelectorAll('.cmt-popover')) p.remove();
  }

  function popoverShell(x, y, headText) {
    closePopovers();
    const pop = document.createElement('div');
    pop.className = 'cmt-popover';
    pop.style.left = `${Math.min(x, window.scrollX + window.innerWidth - 420)}px`;
    pop.style.top = `${y}px`;
    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    label.textContent = headText;
    const x2 = document.createElement('span');
    x2.className = 'x';
    x2.textContent = '✕';
    x2.addEventListener('click', closePopovers);
    head.append(label, x2);
    pop.append(head);
    overlay.append(pop);
    return pop;
  }

  function showComposePopover(sel, x, y) {
    const pop = popoverShell(x, y, `New comment · lines ${sel.startLine + 1}–${sel.endLine + 1}`);
    const row = document.createElement('div');
    row.className = 'replyrow';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Comment… (file.ts:12-34 and claude:<sessionId> auto-link)';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const submit = document.createElement('button');
    submit.textContent = 'Comment';
    submit.addEventListener('click', () => {
      if (!ta.value.trim()) return;
      vscode.postMessage({
        type: 'addComment',
        startLine: sel.startLine,
        endLine: sel.endLine,
        selectedText: sel.selectedText,
        body: ta.value,
      });
      closePopovers();
    });
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closePopovers);
    actions.append(submit, cancel);
    row.append(ta, actions);
    pop.append(row);
    ta.focus();
  }

  function showThreadPopover(t, x, y) {
    const pop = popoverShell(x, y, `Thread · lines ${t.startLine + 1}–${t.endLine + 1}`);
    for (const c of t.comments) {
      const div = document.createElement('div');
      div.className = 'comment';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = c.author;
      const when = document.createElement('span');
      when.textContent = c.createdAt ? new Date(c.createdAt).toLocaleString() : '';
      who.append(when);
      const body = document.createElement('div');
      body.className = 'body';
      renderLinkifiedBody(body, c.body);
      div.append(who, body);
      pop.append(div);
    }
    const row = document.createElement('div');
    row.className = 'replyrow';
    const ta = document.createElement('textarea');
    ta.placeholder = 'Reply…';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const reply = document.createElement('button');
    reply.textContent = 'Reply';
    reply.addEventListener('click', () => {
      if (!ta.value.trim()) return;
      vscode.postMessage({ type: 'reply', threadId: t.id, body: ta.value });
      closePopovers();
    });
    const resolve = document.createElement('button');
    resolve.className = 'ghost';
    resolve.textContent = 'Resolve ✓';
    resolve.addEventListener('click', () => {
      vscode.postMessage({ type: 'resolve', threadId: t.id });
      closePopovers();
    });
    const openEditor = document.createElement('button');
    openEditor.className = 'ghost';
    openEditor.textContent = 'Open in editor';
    openEditor.addEventListener('click', () => {
      vscode.postMessage({ type: 'openInEditor', threadId: t.id, line: t.startLine });
      closePopovers();
    });
    actions.append(reply, resolve, openEditor);
    row.append(ta, actions);
    pop.append(row);
  }

  // Linkify file:line and claude:… refs in comment bodies (DOM-built, no innerHTML).
  const LINK_RE = /((?:[\w.\-]+\/)+[\w.\-]+:\d+(?:-\d+)?|[\w\-]+\.[A-Za-z][A-Za-z0-9]{0,7}:\d+(?:-\d+)?|claude:[A-Za-z0-9\-_]+(?:#[A-Za-z0-9\-_]+(?:\.\.[A-Za-z0-9\-_]+)?|@[A-Za-z0-9\-_]+)?|thread:th_[A-Za-z0-9-]+(?:#c_[A-Za-z0-9-]+)?)/g;

  function renderLinkifiedBody(container, text) {
    let last = 0;
    for (const m of text.matchAll(LINK_RE)) {
      if (m.index > last) container.append(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = m[0];
      a.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openRef', ref: m[0] });
      });
      container.append(a);
      last = m.index + m[0].length;
    }
    container.append(document.createTextNode(text.slice(last)));
  }

  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.cmt-popover') && e.target.id !== 'comment-fab') {
      closePopovers();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
