// RuleCheck — FRN vs. eCFR tab — diff rows, amendment cards, file handling.

// ─────────────────────────────────────────────────────────────────────────────
// Render diff rows into HTML
// ─────────────────────────────────────────────────────────────────────────────

// The pane offers a Word export (docx-writer.js) whenever it is a real
// redline — side-by-side panes with nothing marked are not.
function renderDiffRows(rows, leftLabel = 'Current eCFR text', rightLabel = 'Proposed text') {
  const marked = rows.some(r => r.type === 'diff' && /class="diff-(?:del|add)"/.test(r.oldHtml + r.newHtml));
  let html = `<div class="diff-pane">
    ${marked ? `<div class="rlso-bar"><button type="button" class="rlso-btn" title="Download this redline as a Word document with deletions struck through and additions underlined">Export RLSO to Word</button></div>` : ''}
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
        <div class="diff-row omitted" data-kind="omit">
          <div class="diff-cell current">${esc(note)}</div>
          <div class="diff-cell proposed">${esc(note)}</div>
        </div>`;
    } else if (row.type === 'header') {
      html += `
        <div class="diff-row omitted" data-kind="header">
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

  return html + '</div>';
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

    const sectionLabel = amend.appendix ? amend.appendix.id
      : amend.sections.length
      ? amend.sections.map(s => `§ ${s}`).join(', ')
      : (amend.part ? `Part ${amend.part}` : '');

    const ecfrLinks = amend.appendix
      ? `<a href="${appendixEcfrUrl(amend.appendix)}" target="_blank">${esc(amend.appendix.id)} on eCFR ↗</a>`
      : amend.sections.map(s => {
          const p = s.split('.')[0];
          return `<a href="https://www.ecfr.gov/current/title-10/part-${p}/section-${s}" target="_blank">§ ${s} on eCFR ↗</a>`;
        }).join(' · ');

    const hasContent = amend.proposedChunks.length > 0 || amend.bodyParas.length > 0
      || hasEdits(amend.edits) || (amend.appendix && amend.appendixChunks.length > 0);

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
  if (amend.appendix) await loadAppendixDiff(amend, area);
  else await loadSectionDiff(amend, area);
}

function showReferenceRows(area, notes, rows, failure) {
  const noteHtml = notes.map(n => `<div class="docx-note">${esc(n)}</div>`).join('');
  area.innerHTML = rows.some(r => r.type !== 'omit')
    ? noteHtml + renderDiffRows(rows)
    : noteHtml + `<div class="ecfr-error">⚠ ${esc(failure)}</div>`;
}

// Redline an amendment to one or more sections. The reprinted text is parsed
// like a Document Comparison draft (full paragraph paths, definitions by
// term), each section's current text is fetched from the eCFR and parsed the
// same way, and buildReferenceRows lines them up.
async function loadSectionDiff(amend, area) {
  const paras = amend.bodyParas.slice();
  const first = paras.find(p => !ELISION_RE.test(p.trim()));
  if (first && !SECTION_HEAD_RE.test(first) && amend.sections[0]) paras.unshift(`§ ${amend.sections[0]}`);
  const draftUnits = paras.length ? [...parseAmendmentDoc(paras).units.values()].filter(u => u.kind === 'text') : [];

  const sections = [];
  for (const s of [...draftUnits.map(u => u.section), ...amend.sections]) if (s && !sections.includes(s)) sections.push(s);
  const rows = [], notes = [];

  for (const section of sections) {
    const mine = draftUnits.filter(u => u.section === section);
    const edits = editsForSection(amend.edits, section, amend.sections[0]);
    if (!mine.length && !hasEdits(edits)) continue;
    const draft = mine.map(u => ({ type: 'para', path: u.path, label: u.pathLabel || u.path, text: u.text, hasElision: u.hasElision }));
    const title = ((mine[0] && mine[0].sectionTitle) || '').replace(/\[\d{1,3}\]$/, '');

    let ref = null;
    try {
      ref = await ecfrSectionUnits(section);
    } catch (e) {
      if (e.status !== 404) { notes.push(`Could not retrieve § ${section} from the eCFR (${e.message}).`); continue; }
    }
    if (!ref) {
      if (!draft.length) { notes.push(`§ ${section} is not in the current eCFR.`); continue; }
      notes.push(`§ ${section} is not in the current eCFR — the rule adds it, so all of its text is new.`);
      rows.push({ type: 'header', text: `§ ${section} ${title}`.trim() });
      rows.push(...buildReferenceRows(draft, [], edits).rows);
      continue;
    }
    regroupAmbiguousRomans(draft, ref, section);
    const refUnits = [...ref.values()];
    // Footnote marks on a heading ("license. 1", "license.[1]") are not part of it.
    const refTitle = ((refUnits[0] && refUnits[0].sectionTitle) || '').replace(/\s+\d{1,2}$/, '');
    if (title && refTitle && substantiveKey(title) !== substantiveKey(refTitle)) {
      rows.push({ type: 'diff', label: '', ...paragraphRedline(`§ ${section} ${refTitle}`, `§ ${section} ${title}`) });
    } else {
      rows.push({ type: 'header', text: `§ ${section} ${refTitle || title}`.trim() });
    }
    const out = buildReferenceRows(draft,
      refUnits.map(u => ({ type: 'para', path: u.path, label: u.pathLabel || u.path, text: u.text })),
      edits, { gapOmits: true });
    rows.push(...out.rows);
    notes.push(...out.notes.map(n => `§ ${section}: ${n}`));
  }
  showReferenceRows(area, notes, rows,
    `Could not build a comparison for ${amend.sections.map(s => `§ ${s}`).join(', ') || 'this amendment'}.`);
}

// After "* * *" a lone "(i)", "(v)" or "(x)" may be a paragraph letter or a
// roman numeral, and the elided text no longer tells which: "(a)(3) …
// * * * (i) Except as provided …" reads as (a)(3)(i). Where the eCFR has no
// such paragraph but has the lettered one, the draft paragraph (and those
// under it) is moved to the letter.
function regroupAmbiguousRomans(draft, ref, section) {
  const has = path => ref.has(`${section}|${path}`);
  const paths = new Set(draft.map(u => u.path));
  for (const u of draft) {
    const m = u.path.match(/^(\(\w+\)\(\w+\))\(([ivx])\)$/);
    if (!m || has(u.path) || !has(`(${m[2]})`) || paths.has(`(${m[2]})`)) continue;
    const from = u.path, to = `(${m[2]})`;
    for (const v of draft) {
      if (v.path === from || v.path.startsWith(from + '(')) {
        v.path = to + v.path.slice(from.length);
        v.label = v.path;
      }
    }
    paths.add(to);
  }
}

// The edits an instruction makes to one section; those naming no section
// belong to the first one it names.
function editsForSection(edits, section, primary) {
  const mine = e => (e.section || primary) === section;
  return {
    revised: edits.revised.filter(mine),
    removals: edits.removals.filter(mine),
    subs: edits.subs.filter(mine),
    whole: edits.whole && mine(edits.whole) ? edits.whole : null,
  };
}

// Redline an amendment to an appendix against the eCFR appendix, paragraph by
// paragraph by the appendix's own designators.
async function loadAppendixDiff(amend, area) {
  const apx = amend.appendix;
  let blocks = null, missing = false;
  try {
    blocks = ecfrAppendixBlocks(await fetchEcfrAppendixXml(apx.part, apx.id));
  } catch (e) {
    missing = e.status === 404;
    if (!missing) console.warn(`eCFR fetch failed ${apx.id}:`, e.message);
  }
  if (!blocks) {
    if (missing && amend.appendixChunks.length) {
      const out = buildReferenceRows(amend.appendixChunks, [], amend.edits, { appendix: true });
      showReferenceRows(area, [`${apx.id} is not in the current eCFR — the rule adds it, so all of its text is new.`], out.rows, '');
      return;
    }
    area.innerHTML = `
      <div class="ecfr-error">⚠ Could not retrieve current eCFR text for ${esc(apx.id)}.
      ${missing ? 'It is not in the current eCFR.' : 'The eCFR API may be unavailable.'}</div>
      ${amend.appendixChunks.length ? `<div class="proposed-only">${esc(amend.appendixChunks.map(c => c.type === 'omit' ? '* * * * *' : c.text || '').join('\n\n'))}</div>` : ''}`;
    return;
  }
  const ref = appendixChunks(blocks).filter(c => c.type !== 'omit');
  const out = buildReferenceRows(amend.appendixChunks, ref, amend.edits, { appendix: true });
  showReferenceRows(area, out.notes, out.rows,
    `Could not match the amended paragraphs of ${apx.id} in the current eCFR text.`);
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
