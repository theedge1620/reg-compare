// RuleCheck — Word-level diff and paragraph-aligned redlines.

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Word-level diff between two text strings
// ─────────────────────────────────────────────────────────────────────────────

function computeDiff(oldText, newText) {
  const tok = t => t.match(/(\S+|\s+)/g) || [];
  const a = tok(oldText), b = tok(newText);
  if (a.length > 2000 || b.length > 2000) {
    return { oldHtml: esc(oldText), newHtml: esc(newText) };
  }
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, () => new Uint16Array(n+1));
  for (let i = m-1; i >= 0; i--)
    for (let j = n-1; j >= 0; j--)
      dp[i][j] = a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const op = [], np = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i<m && j<n && a[i]===b[j]) { op.push(esc(a[i])); np.push(esc(b[j])); i++; j++; }
    else if (j<n && (i>=m || dp[i][j+1]>=dp[i+1][j])) { np.push(`<span class="diff-add">${esc(b[j])}</span>`); j++; }
    else { op.push(`<span class="diff-del">${esc(a[i])}</span>`); i++; }
  }
  return { oldHtml: op.join(''), newHtml: np.join('') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Redline (RLSO) — paragraph alignment then word-level diff
// ─────────────────────────────────────────────────────────────────────────────
//
// Aligning at the paragraph level first keeps each word-diff small and lets
// runs of untouched paragraphs collapse into a single "N unchanged" row.

function splitParas(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

// Longest-common-subsequence ops over two paragraph arrays. Paragraphs that
// differ only in formatting align as unchanged.
function lcsOps(a, b) {
  const m = a.length, n = b.length;
  const ka = a.map(substantiveKey), kb = b.map(substantiveKey);
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const ops = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && ka[i] === kb[j]) { ops.push({ type: 'eq' }); i++; j++; }
    else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ type: 'ins', b: b[j] }); j++; }
    else { ops.push({ type: 'del', a: a[i] }); i++; }
  }
  return ops;
}

// Pair up each run of changes so a rewritten paragraph shows as one two-column
// row rather than a deletion row followed by an insertion row. The whole
// contiguous non-equal block is gathered first, because lcsOps may emit its
// insertions before its deletions depending on how the DP ties break.
function mergeReplacements(ops) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'eq') { out.push(ops[i]); i++; continue; }
    const dels = [], ins = [];
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') dels.push(ops[i].a);
      else ins.push(ops[i].b);
      i++;
    }
    const paired = Math.min(dels.length, ins.length);
    for (let k = 0; k < paired; k++) out.push({ type: 'rep', a: dels[k], b: ins[k] });
    for (let k = paired; k < dels.length; k++) out.push({ type: 'del', a: dels[k] });
    for (let k = paired; k < ins.length; k++) out.push({ type: 'ins', b: ins[k] });
  }
  return out;
}

function diffParagraphBlocks(aText, bText) {
  const a = splitParas(aText), b = splitParas(bText);

  // Guard the O(m·n) table; very long sections fall back to one whole-text diff.
  if (a.length > 400 || b.length > 400) {
    const { oldHtml, newHtml } = computeDiff(aText, bText);
    return [{ type: 'diff', label: '', oldHtml, newHtml }];
  }

  const rows = [];
  let eqRun = 0;
  const flushEq = () => { if (eqRun) { rows.push({ type: 'omit', count: eqRun }); eqRun = 0; } };

  for (const op of mergeReplacements(lcsOps(a, b))) {
    if (op.type === 'eq') { eqRun++; continue; }
    flushEq();
    if (op.type === 'rep') {
      const { oldHtml, newHtml } = computeDiff(op.a, op.b);
      rows.push({ type: 'diff', label: '', oldHtml, newHtml });
    } else if (op.type === 'del') {
      rows.push({ type: 'diff', label: '', oldHtml: `<span class="diff-del">${esc(op.a)}</span>`, newHtml: '' });
    } else {
      rows.push({ type: 'diff', label: '', oldHtml: '', newHtml: `<span class="diff-add">${esc(op.b)}</span>` });
    }
  }
  flushEq();
  return rows;
}
