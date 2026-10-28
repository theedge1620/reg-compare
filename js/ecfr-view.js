// RuleCheck — FRN vs. eCFR tab — diff rows, amendment cards, file handling.

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Align proposed chunks with eCFR paragraph map, build diff rows
// ─────────────────────────────────────────────────────────────────────────────
//
// For each proposed chunk:
//   'omit'   → show a collapsed "unchanged text" row spanning both columns
//   'header' → show section heading row (no diff)
//   'para'   → look up the matching eCFR paragraph by label, diff them
//              If no label, compare to the full section text (simple full-replace)

function buildDiffRows(proposedChunks, ecfrMap) {
  const rows = [];

  for (const chunk of proposedChunks) {
    if (chunk.type === 'omit') {
      rows.push({ type: 'omit' });
      continue;
    }
    if (chunk.type === 'header') {
      rows.push({ type: 'header', text: chunk.text });
      continue;
    }

    // type === 'para'
    const proposed = chunk.text;
    const label = chunk.label;

    // Find matching eCFR text.
    // Priority: exact label match → prefix match → full section text
    let ecfr = null;
    if (ecfrMap) {
      if (label && ecfrMap[label]) {
        ecfr = ecfrMap[label];
      } else if (label) {
        // Try prefix: "(b)(2)" might match an eCFR paragraph with that prefix
        for (const [k, v] of Object.entries(ecfrMap)) {
          if (k !== '_full_' && (k.startsWith(label) || label.startsWith(k))) {
            ecfr = v; break;
          }
        }
      }
      // If still no match and this is the only / first chunk, use full section
      if (!ecfr && proposedChunks.filter(c => c.type === 'para').length === 1) {
        ecfr = ecfrMap['_full_'] || null;
      }
    }

    if (ecfr) {
      const { oldHtml, newHtml } = computeDiff(ecfr, proposed);
      rows.push({ type: 'diff', label, oldHtml, newHtml });
    }
    // If no eCFR match found, suppress — only show paragraphs where we have
    // current text to compare against the proposed change.
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Render diff rows into HTML
// ─────────────────────────────────────────────────────────────────────────────

function renderDiffRows(rows, leftLabel = 'Current eCFR text', rightLabel = 'Proposed text') {
  let html = `
    <div class="diff-pane-header">
      <div class="diff-col-label current">${esc(leftLabel)}</div>
      <div class="diff-col-label proposed">${esc(rightLabel)}</div>
    </div>`;

  for (const row of rows) {
    if (row.type === 'omit') {
      // row.count is set by the paragraph-level aligner (doc comparison);
      // the eCFR path uses the Federal Register's own "* * * * *" marker.
      const note = row.count
        ? `⋯ ${row.count} unchanged paragraph${row.count !== 1 ? 's' : ''}`
        : '* * * * *  (unchanged text omitted)';
      html += `
        <div class="diff-row omitted">
          <div class="diff-cell current">${esc(note)}</div>
          <div class="diff-cell proposed">${esc(note)}</div>
        </div>`;
    } else if (row.type === 'header') {
      html += `
        <div class="diff-row omitted">
          <div class="diff-cell current" style="font-style:normal;font-weight:600;">${esc(row.text)}</div>
          <div class="diff-cell proposed" style="font-style:normal;font-weight:600;">${esc(row.text)}</div>
        </div>`;
    } else if (row.type === 'diff') {
      const labelBadge = row.label ? `<span class="para-label">${esc(row.label)}</span>` : '';
      html += `
        <div class="diff-row">
          <div class="diff-cell current">${labelBadge}${row.oldHtml}</div>
          <div class="diff-cell proposed">${labelBadge}${row.newHtml}</div>
        </div>`;
    }
  }

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render amendment cards
// ─────────────────────────────────────────────────────────────────────────────

function renderAmendments(amendments) {
  const container = document.getElementById('results');
  if (!amendments.length) {
    container.innerHTML = `<div class="empty-state"><div class="icon">🔍</div>No amendment instructions found.<br>Make sure you've uploaded a Federal Register proposed or final rule, or a working draft of one.</div>`;
    return;
  }

  // ── Collect unique parts in the order they first appear ──
  const partOrder = [];
  const partCounts = {};
  for (const amend of amendments) {
    const p = amend.part || '—';
    if (!partCounts[p]) { partCounts[p] = 0; partOrder.push(p); }
    partCounts[p]++;
  }
  partOrder.sort((a, b) => (a === '—' ? 1 : b === '—' ? -1 : Number(a) - Number(b)));

  // ── Header row ──
  const hdr = document.createElement('div');
  hdr.className = 'amendments-header';
  hdr.innerHTML = `<h2>Proposed Amendments</h2><span class="badge">${amendments.length} found</span>`;
  container.appendChild(hdr);

  // ── Filter bar (only show if more than one distinct part) ──
  let activePart = 'all';
  let filterCount = null;

  if (partOrder.length > 1) {
    const bar = document.createElement('div');
    bar.className = 'filter-bar';
    bar.innerHTML = `<span class="filter-label">Filter by Part</span>`;

    const allPill = document.createElement('button');
    allPill.className = 'filter-pill active';
    allPill.textContent = `All (${amendments.length})`;
    allPill.dataset.part = 'all';
    bar.appendChild(allPill);

    for (const p of partOrder) {
      const pill = document.createElement('button');
      pill.className = 'filter-pill';
      pill.textContent = `Part ${p} (${partCounts[p]})`;
      pill.dataset.part = p;
      bar.appendChild(pill);
    }

    filterCount = document.createElement('span');
    filterCount.className = 'filter-count';
    bar.appendChild(filterCount);

    bar.addEventListener('click', e => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      activePart = pill.dataset.part;
      bar.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p === pill));
      applyFilter();
    });

    container.appendChild(bar);
  }

  // ── Cards ──
  const cards = document.createElement('div');
  cards.className = 'amendment-cards';
  container.appendChild(cards);

  amendments.forEach((amend, idx) => {
    const card = document.createElement('div');
    card.className = 'amendment-card';
    card.dataset.part = amend.part || '—';

    const sectionLabel = amend.sections.length
      ? amend.sections.map(s => `§ ${s}`).join(', ')
      : (amend.part ? `Part ${amend.part}` : '');

    const ecfrLinks = amend.sections.map(s => {
      const p = s.split('.')[0];
      return `<a href="https://www.ecfr.gov/current/title-10/part-${p}/section-${s}" target="_blank">§ ${s} on eCFR ↗</a>`;
    }).join(' · ');

    const hasContent = (amend.proposedChunks && amend.proposedChunks.length > 0)
      || (amend.substitutions && amend.substitutions.length > 0);

    card.innerHTML = `
      <div class="amendment-card-header">
        <span class="amend-num">${amend.num ? '#' + esc(amend.num) : '—'}</span>
        <span class="amend-title">${esc(trunc(amend.instruction, 90))}</span>
        ${sectionLabel ? `<span class="amend-cfr">${esc(sectionLabel)}</span>` : ''}
        <span class="amend-toggle">▼</span>
      </div>
      <div class="amendment-body">
        <div class="amend-meta">
          <span class="instruction">${esc(amend.instruction)}</span>
          ${ecfrLinks}
        </div>
        <div id="diff-${idx}">
          ${hasContent
            ? `<div class="loading-ecfr"><div class="spinner"></div>Fetching current eCFR text…</div>`
            : `<div class="ecfr-error">⚠ No proposed text block detected after this instruction.</div>`}
        </div>
      </div>`;

    card.querySelector('.amendment-card-header').addEventListener('click', () => {
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      if (!wasOpen && hasContent) loadDiff(amend, idx);
    });

    cards.appendChild(card);
  });

  // ── Filter function ──
  function applyFilter() {
    let visible = 0;
    cards.querySelectorAll('.amendment-card').forEach(card => {
      const show = activePart === 'all' || card.dataset.part === activePart;
      card.classList.toggle('hidden', !show);
      if (show) visible++;
    });
    if (filterCount) {
      filterCount.textContent = activePart === 'all'
        ? '' : `${visible} amendment${visible !== 1 ? 's' : ''}`;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load diff on demand (lazy)
// ─────────────────────────────────────────────────────────────────────────────

const loaded = new Set();

async function loadDiff(amend, idx) {
  if (loaded.has(idx)) return;
  loaded.add(idx);
  const area = document.getElementById(`diff-${idx}`);
  if (!area) return;

  // ── Path A: substitution-only amendment (instruction carries the ops) ──
  if (amend.substitutions && amend.substitutions.length) {
    await loadSubstitutionDiff(amend, area);
    return;
  }

  // ── Path B: full proposed text block ──
  let ecfrMap = null;
  for (const sec of amend.sections) {
    const part = sec.split('.')[0];
    ecfrMap = await fetchEcfrParagraphMap(part, sec);
    if (ecfrMap) break;
  }

  const rows = buildDiffRows(amend.proposedChunks, ecfrMap);

  if (!rows.length) {
    area.innerHTML = `<div class="ecfr-error">⚠ Could not build comparison — no structured chunks found.</div>`;
    return;
  }

  const diffHtml = renderDiffRows(rows);

  if (!ecfrMap) {
    area.innerHTML = `
      <div class="ecfr-error">⚠ Could not retrieve current eCFR text for ${amend.sections.map(s=>`§ ${s}`).join(', ')}.
      This may be a new section proposed for the first time, or the eCFR API is unavailable.</div>
      <div class="proposed-only">${esc(amend.proposedChunks.map(c => c.text || (c.type==='omit'?'* * * * *':'')).join('\n\n'))}</div>`;
    return;
  }

  area.innerHTML = diffHtml;
}

// Build the diff for a substitution-only amendment.
// For each substitution group (targeting a paragraph):
//   1. Fetch the eCFR paragraph text
//   2. Apply the ops to synthesize the proposed text
//   3. Diff original vs. synthesized
async function loadSubstitutionDiff(amend, area) {
  let ecfrMap = null;
  for (const sec of amend.sections) {
    ecfrMap = await fetchEcfrParagraphMap(sec.split('.')[0], sec);
    if (ecfrMap) break;
  }

  if (!ecfrMap) {
    area.innerHTML = `
      <div class="ecfr-error">⚠ Could not retrieve current eCFR text for ${amend.sections.map(s=>`§ ${s}`).join(', ')}.
      Cannot apply substitution without the source text.</div>`;
    return;
  }

  const rows = [];

  for (const sub of amend.substitutions) {
    const { ops, wherever } = sub;

    // Resolve the set of paragraph labels to operate on.
    // sub.paras may list multiple e.g. ["(a)","(b)"] for "in paragraphs (a) and (b)"
    const targetParas = (sub.paras && sub.paras.length) ? sub.paras : [sub.para];

    for (const para of targetParas) {
      // Locate the eCFR source text for this paragraph
      let ecfrText = null;

      if (para) {
        ecfrText = ecfrMap[para] || null;
        if (!ecfrText) {
          // Prefix / suffix match (e.g. stored as "(a)(1)" but targeting "(a)")
          for (const [k, v] of Object.entries(ecfrMap)) {
            if (k !== '_full_' && (k.startsWith(para) || para.startsWith(k))) {
              ecfrText = v; break;
            }
          }
        }
      }

      // Fall back to full section text only when no paragraph was specified
      if (!ecfrText && !para) ecfrText = ecfrMap['_full_'] || null;

      if (!ecfrText) continue; // no source text found — skip silently

      const proposedText = applySubstitutions(ecfrText, ops, wherever);
      if (proposedText === ecfrText) continue; // substitution made no change

      const { oldHtml, newHtml } = computeDiff(ecfrText, proposedText);
      rows.push({ type: 'diff', label: para || '', oldHtml, newHtml });
    }
  }

  if (!rows.length) {
    area.innerHTML = `<div class="ecfr-error">⚠ Could not match the substitution phrases in the current eCFR text. The phrases may differ from the version in effect when this proposed rule was published, or the paragraph could not be located.</div>`;
    return;
  }

  area.innerHTML = renderDiffRows(rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// File handling
// ─────────────────────────────────────────────────────────────────────────────

async function handleFile(file) {
  setStatus('⏳', 'Reading file…', file.name);
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  let amendments;
  try {
    if (ext === '.docx' || ext === '.pdf') {
      const paras = ext === '.docx' ? await readDocxParagraphs(file) : await readPdfParagraphs(file);
      setStatus('🔍', 'Parsing amendments…', 'Scanning for amendment instructions');
      await new Promise(r => setTimeout(r, 60));
      amendments = parseAmendmentParagraphs(paras);
    } else {
      const text = await file.text();
      setStatus('🔍', 'Parsing amendments…', 'Scanning for numbered amendment instructions');
      await new Promise(r => setTimeout(r, 60));
      amendments = parseAmendments(text);
    }
  } catch (e) {
    console.error(e);
    document.getElementById('results').innerHTML = '';
    setStatus('⚠️', `Could not read ${file.name}`, e.message);
    return;
  }
  document.getElementById('results').innerHTML = '';
  setStatus('✅',
    `Found ${amendments.length} amendment${amendments.length !== 1 ? 's' : ''}`,
    'Click any amendment to load its comparison with current eCFR text');
  renderAmendments(amendments);
}

document.getElementById('fileInput').addEventListener('change', e => {
  const f = e.target.files[0]; if (f) handleFile(f);
});
const ua = document.getElementById('uploadArea');
ua.addEventListener('dragover', e => { e.preventDefault(); ua.classList.add('drag-over'); });
ua.addEventListener('dragleave', () => ua.classList.remove('drag-over'));
ua.addEventListener('drop', e => {
  e.preventDefault(); ua.classList.remove('drag-over');
  const f = e.dataTransfer.files[0]; if (f) handleFile(f);
});
