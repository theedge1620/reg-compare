// RuleCheck — Document Comparison tab.

// ═════════════════════════════════════════════════════════════════════════════
// VIEW 2 — Multi-document .docx conflict comparison
// ═════════════════════════════════════════════════════════════════════════════
//
// Pipeline:
//   .docx (ZIP)  →  word/document.xml  →  paragraphs  →  numbered sections
//   →  cross-document index by section number
//   →  keep only numbers present in ≥2 documents with ≥2 distinct text variants
//   →  side-by-side redline for any chosen pair of documents

// ─────────────────────────────────────────────────────────────────────────────
// Comparison view — state and rendering
// ─────────────────────────────────────────────────────────────────────────────

// ── similarity bands (filters on Document and Folder Comparison) ──
// A conflict is banded by the "% alike" its card shows — the least-similar
// pair of variants, rounded the same way — so the band always matches the
// badge. Form-only conflicts (text vs. instruction) have no score and so fall
// in no band. Whole percents: the bands are contiguous with no overlap.
const SIM_BANDS = [
  { id: 'high', label: 'Very similar',     range: '75%+',   min: 75, max: 100 },
  { id: 'mid',  label: 'Somewhat similar', range: '26–74%', min: 26, max: 74 },
  { id: 'low',  label: 'Not similar',      range: '≤25%',   min: 0,  max: 25 },
];

function simBand(sim, formOnly) {
  if (formOnly || sim === null || sim === undefined) return null;
  const pct = Math.round(sim * 100);
  const band = SIM_BANDS.find(b => pct >= b.min && pct <= b.max);
  return band ? band.id : null;
}

const DOC_COLORS = ['#2d6a9f', '#a01a1a', '#1a7a3a', '#7a5a00', '#6a3a9f', '#0f6f77', '#a04a1a', '#4a4a6a'];
const DOC_TAGS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

let cmpDocs = [];        // { id, tag, color, name, size, units, instructions, error }
let cmpTitle10 = null;   // result of getTitle10Sections() used for the loaded documents
let cmpSort = 'divergent';
let cmpDocFilter = 'all';
let cmpSimFilter = 'all';    // 'all' or a SIM_BANDS id
let cmpNextId = 0;

function docTagHtml(doc, extraClass = '') {
  return `<span class="doc-tag ${extraClass}" style="background:${doc.color}" title="${esc(doc.name)}">${doc.tag}</span>`;
}

function relabelDocs() {
  cmpDocs.forEach((d, i) => {
    d.tag = DOC_TAGS[i] || String(i + 1);
    d.color = DOC_COLORS[i % DOC_COLORS.length];
  });
}

async function addComparisonFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.docx$/i.test(f.name));
  const skipped = Array.from(fileList).length - files.length;

  if (!files.length) {
    setStatusIn('cmpStatusBar', '⚠️', 'No .docx files found',
      'This comparison reads Word .docx files only. Legacy .doc and .pdf are not supported.');
    return;
  }

  setStatusIn('cmpStatusBar', '⏳', 'Loading the eCFR section list…',
    'Title 10 section numbers are used to tell section headings from numbers that just start a line');
  cmpTitle10 = await getTitle10Sections();

  for (const file of files) {
    if (cmpDocs.some(d => d.name === file.name && d.size === file.size)) continue;

    setStatusIn('cmpStatusBar', '⏳', 'Reading documents…', file.name);
    const doc = {
      id: cmpNextId++, name: file.name, size: file.size,
      units: new Map(), instructions: [], error: null,
    };
    try {
      const parsed = parseAmendmentDoc(await readDocxParagraphs(file), cmpTitle10.map);
      doc.units = parsed.units;
      doc.instructions = parsed.instructions;
    } catch (err) {
      doc.error = err.message;
    }
    cmpDocs.push(doc);
  }

  relabelDocs();
  renderComparison(skipped);
}

function removeComparisonDoc(id) {
  cmpDocs = cmpDocs.filter(d => d.id !== id);
  relabelDocs();
  renderComparison();
}

function renderFileChips() {
  const box = document.getElementById('cmpFileChips');
  box.innerHTML = '';
  if (!cmpDocs.length) return;

  for (const doc of cmpDocs) {
    const chip = document.createElement('div');
    chip.className = 'file-chip' + (doc.error ? ' error' : '');
    const sectionCount = new Set(Array.from(doc.units.values(), u => u.section)).size;
    const meta = doc.error
      ? `<span class="file-chip-meta" style="color:var(--del)">${esc(doc.error)}</span>`
      : `<span class="file-chip-meta">${sectionCount} section${sectionCount !== 1 ? 's' : ''} ·
         ${doc.units.size} subsection${doc.units.size !== 1 ? 's' : ''} ·
         ${doc.instructions.length} instruction${doc.instructions.length !== 1 ? 's' : ''}</span>`;
    chip.innerHTML = `${docTagHtml(doc)}<span class="file-chip-name">${esc(doc.name)}</span>${meta}
      <button class="file-chip-remove" type="button" title="Remove">✕</button>`;
    chip.querySelector('.file-chip-remove').addEventListener('click', () => removeComparisonDoc(doc.id));
    box.appendChild(chip);
  }

  const clear = document.createElement('button');
  clear.className = 'chip-clear';
  clear.type = 'button';
  clear.textContent = 'Clear all';
  clear.addEventListener('click', () => { cmpDocs = []; renderComparison(); });
  box.appendChild(clear);
}

function renderComparison(skipped = 0) {
  renderFileChips();
  const out = document.getElementById('cmpResults');
  out.innerHTML = '';

  const usable = cmpDocs.filter(d => !d.error);
  const skipNote = skipped ? ` ${skipped} non-.docx file${skipped !== 1 ? 's were' : ' was'} ignored.` : '';

  if (usable.length < 2) {
    setStatusIn('cmpStatusBar', usable.length ? '📄' : '⏳',
      usable.length ? 'Add at least one more document' : 'No documents loaded',
      `${usable.length} document${usable.length !== 1 ? 's' : ''} ready — comparison needs two or more.${skipNote}`,
      cmpDocs.length > 0);
    if (usable.length) {
      out.innerHTML = `<div class="empty-state"><div class="icon">📚</div>Add a second .docx file to compare against.</div>`;
    }
    return;
  }

  const { conflicts, stats } = analyzeDocuments(usable);

  setStatusIn('cmpStatusBar', conflicts.length ? '⚠️' : '✅',
    conflicts.length
      ? `${conflicts.length} conflicting subsection${conflicts.length !== 1 ? 's' : ''} found`
      : 'No conflicting subsections found',
    (conflicts.length
      ? `In ${stats.sections} section${stats.sections !== 1 ? 's' : ''} across ${stats.docs} documents · click one to open its redline.${skipNote}`
      : `All ${stats.common} shared subsection${stats.common !== 1 ? 's' : ''} match across the documents.${skipNote}`)
    + title10Note(cmpTitle10));

  // ── summary strip ──
  const sum = document.createElement('div');
  sum.className = 'cmp-summary';
  sum.innerHTML = `
    <div class="cmp-stat"><span class="n">${stats.docs}</span><span class="k">Documents</span></div>
    <div class="cmp-stat"><span class="n">${stats.common}</span><span class="k">Shared subsections</span></div>
    <div class="cmp-stat"><span class="n${stats.conflicts ? ' flag' : ''}">${stats.conflicts}</span><span class="k">Conflicts</span></div>
    <div class="cmp-stat"><span class="n">${stats.sections}</span><span class="k">Sections affected</span></div>
    <div class="cmp-stat"><span class="n">${stats.agreeing}</span><span class="k">In agreement</span></div>
    <div class="cmp-stat"><span class="n">${stats.uniqueToOne}</span><span class="k">In one doc only</span></div>`;
  out.appendChild(sum);

  if (!conflicts.length) {
    out.innerHTML += stats.common
      ? `<div class="empty-state"><div class="icon">✅</div>No conflicts detected.<br>Every subsection shared by these documents has matching text.</div>`
      : `<div class="empty-state"><div class="icon">🔍</div>No subsection appears in more than one document.<br>Check that the documents use section headings such as <code>§ 50.55a</code> with lettered or numbered paragraphs.</div>`;
    return;
  }

  // ── filter / sort bar ──
  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.innerHTML = `<span class="filter-label">Involving</span>`;

  const mkPill = (label, group, value, active) => {
    const b = document.createElement('button');
    b.className = 'filter-pill' + (active ? ' active' : '');
    b.textContent = label;
    b.dataset.group = group;
    b.dataset.value = value;
    return b;
  };

  bar.appendChild(mkPill(`All (${conflicts.length})`, 'doc', 'all', cmpDocFilter === 'all'));
  for (const doc of usable) {
    const n = conflicts.filter(c => c.entries.some(e => e.doc.id === doc.id)).length;
    bar.appendChild(mkPill(`${doc.tag} · ${n}`, 'doc', String(doc.id), cmpDocFilter === String(doc.id)));
  }

  const mkLabel = text => {
    const s = document.createElement('span');
    s.className = 'filter-label';
    s.style.marginLeft = '0.75rem';
    s.textContent = text;
    return s;
  };

  bar.appendChild(mkLabel('Similarity'));
  bar.appendChild(mkPill('Any', 'sim', 'all', cmpSimFilter === 'all'));
  for (const band of SIM_BANDS) {
    const n = conflicts.filter(c => simBand(c.worst.sim, c.formOnly) === band.id).length;
    const pill = mkPill(`${band.label} ${band.range} · ${n}`, 'sim', band.id, cmpSimFilter === band.id);
    pill.title = `${band.label}: ${band.range} alike`;
    bar.appendChild(pill);
  }

  bar.appendChild(mkLabel('Sort'));
  bar.appendChild(mkPill('Most divergent', 'sort', 'divergent', cmpSort === 'divergent'));
  bar.appendChild(mkPill('Section order', 'sort', 'number', cmpSort === 'number'));

  bar.addEventListener('click', e => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    if (pill.dataset.group === 'sort') cmpSort = pill.dataset.value;
    else if (pill.dataset.group === 'sim') cmpSimFilter = pill.dataset.value;
    else cmpDocFilter = pill.dataset.value;
    renderComparison();
  });
  out.appendChild(bar);

  // ── conflict cards ──
  conflicts.sort((a, b) => cmpSort === 'number'
    ? compareUnits(a, b)
    : (a.worst.sim - b.worst.sim) || compareUnits(a, b));

  const hdr = document.createElement('div');
  hdr.className = 'amendments-header';
  hdr.innerHTML = `<h2>Conflicting Subsections</h2><span class="badge">${conflicts.length} found</span>`;
  out.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'amendment-cards';
  out.appendChild(list);

  for (const c of conflicts) {
    if (cmpDocFilter !== 'all' && !c.entries.some(e => String(e.doc.id) === cmpDocFilter)) continue;
    if (cmpSimFilter !== 'all' && simBand(c.worst.sim, c.formOnly) !== cmpSimFilter) continue;
    list.appendChild(buildConflictCard(c, usable));
  }
  const shown = list.children.length;
  if (shown !== conflicts.length) hdr.querySelector('.badge').textContent = `${shown} of ${conflicts.length} shown`;
  if (!shown) {
    list.innerHTML = `<div class="empty-state"><div class="icon">🔍</div>No conflicts match these filters.</div>`;
  }
}

function buildConflictCard(conflict, allDocs) {
  const card = document.createElement('div');
  card.className = 'conflict-card';

  const present = new Set(conflict.entries.map(e => e.doc.id));
  const tags = allDocs.map(d => docTagHtml(d, present.has(d.id) ? '' : 'absent')).join('');
  const pct = Math.round(conflict.worst.sim * 100);

  const variantBadge = conflict.variantCount > 2
    ? `<span class="sec-badge variants">${conflict.variantCount} variants</span>` : '';
  const elisionBadge = conflict.hasElision
    ? `<span class="sec-badge elision" title="Unchanged text elided with * * *">* * *</span>` : '';
  const formBadge = conflict.formsDiffer
    ? `<span class="sec-badge forms" title="One document sets out the text, another gives only the amendment instruction">${
        conflict.formOnly ? 'form differs' : 'mixed form'}</span>` : '';

  // Numbered instructions are shown only for the section this conflict is in.
  const instrHtml = conflict.instructions.length ? `
    <div class="instr-block">
      <div class="instr-head">Amendment instructions affecting § ${esc(conflict.section)}</div>
      ${conflict.instructions.map(x => x.list.map(ins => `
        <div class="instr-line">
          ${docTagHtml(x.doc)}
          <span class="instr-num">${ins.num ? esc(ins.num) + '.' : '•'}</span>
          <span class="instr-text">${esc(ins.text.replace(INSTRUCTION_RE, '$2'))}</span>
        </div>`).join('')).join('')}
    </div>` : '';

  card.innerHTML = `
    <div class="conflict-card-header">
      <span class="sec-num">§ ${esc(conflict.section)}</span>
      <span class="sec-path">${esc(conflict.pathLabel || 'section body')}</span>
      <span class="sec-title${conflict.title ? '' : ' untitled'}">${esc(conflict.title || '')}</span>
      ${variantBadge}${elisionBadge}${formBadge}
      <span class="sec-badge sim">${conflict.formOnly ? '—' : pct + '% alike'}</span>
      <span class="sec-docs">${tags}</span>
      <span class="amend-toggle">▼</span>
    </div>
    <div class="conflict-body">
      ${instrHtml}
      <div class="pair-picker">
        <span>Redline</span>
        <select class="pick-a"></select>
        <span class="vs">vs</span>
        <select class="pick-b"></select>
        <span class="pair-note"></span>
      </div>
      <div class="redline-area"></div>
    </div>`;

  const selA = card.querySelector('.pick-a');
  const selB = card.querySelector('.pick-b');
  for (const sel of [selA, selB]) {
    sel.innerHTML = conflict.entries
      .map((e, i) => `<option value="${i}">${esc(e.doc.tag + ' · ' + trunc(e.doc.name, 34)
        + (e.unit.kind === 'instruction' ? ' (instruction)' : ''))}</option>`)
      .join('');
  }
  selA.value = String(conflict.worst.a);
  selB.value = String(conflict.worst.b);

  const area = card.querySelector('.redline-area');
  const note = card.querySelector('.pair-note');

  let drawSeq = 0;
  function draw() {
    const seq = ++drawSeq;
    if (selA.value === ECFR_SIDE || selB.value === ECFR_SIDE) {
      if (selA.value === selB.value) {
        note.className = 'pair-note';
        note.textContent = '';
        area.innerHTML = `<div class="docx-note">Pick a document to compare with the current eCFR.</div>`;
        return;
      }
      const ecfrRight = selB.value === ECFR_SIDE;
      const e = conflict.entries[Number(ecfrRight ? selA.value : selB.value)];
      drawEcfrRedline(area, note, conflict.section, e.unit.path, e.unit.pathLabel || e.unit.path, {
        text: e.unit.text, kind: e.unit.kind, hasElision: e.unit.hasElision,
        label: `${e.doc.tag} — ${trunc(e.doc.name, 46)}`,
      }, ecfrRight, () => seq === drawSeq);
      return;
    }

    const a = conflict.entries[Number(selA.value)];
    const b = conflict.entries[Number(selB.value)];
    note.className = 'pair-note';
    note.textContent = '';

    if (a === b) {
      note.className = 'pair-note';
      area.innerHTML = `<div class="docx-note">Pick two different documents to see a redline.</div>`;
      return;
    }
    if (substantiveKey(a.unit.text) === substantiveKey(b.unit.text)) {
      note.className = 'pair-note same';
      note.textContent = 'These two agree';
      area.innerHTML = `<div class="docx-note">✅ ${esc(a.doc.tag)} and ${esc(b.doc.tag)} carry identical text for this subsection — the conflict is with another document.</div>`;
      return;
    }

    // Regulation text and an amendment instruction are different kinds of
    // prose; a word diff between them would be noise, so say so instead.
    if (a.unit.kind !== b.unit.kind) {
      const txt = a.unit.kind === 'text' ? a : b;
      const ins = a.unit.kind === 'text' ? b : a;
      note.className = 'pair-note';
      note.textContent = 'different forms';
      area.innerHTML = `
        <div class="docx-note">⚠ These two express the subsection differently, so they are shown side by side rather than redlined.
        <strong>${esc(txt.doc.tag)}</strong> sets out the amendatory text;
        <strong>${esc(ins.doc.tag)}</strong> gives only the amendment instruction.</div>
        ${renderDiffRows(
          [{ type: 'diff', label: '', oldHtml: esc(txt.unit.text), newHtml: esc(ins.unit.text) }],
          `${txt.doc.tag} — amendatory text`,
          `${ins.doc.tag} — instruction only`
        )}`;
      return;
    }

    note.className = 'pair-note';
    note.textContent = `${Math.round(similarity(a.unit.text, b.unit.text) * 100)}% alike`;

    const elided = (a.unit.hasElision || b.unit.hasElision)
      ? `<div class="docx-note">⋯ This subsection carries a <code>* * *</code> elision — text not reprinted is unchanged and is not compared.</div>`
      : '';

    area.innerHTML = elided + renderDiffRows(
      diffParagraphBlocks(a.unit.text, b.unit.text),
      `${a.doc.tag} — ${trunc(a.doc.name, 46)}`,
      `${b.doc.tag} — ${trunc(b.doc.name, 46)}`
    );
  }

  addEcfrChoice(card, conflict.section, selA, selB, draw);
  selA.addEventListener('change', draw);
  selB.addEventListener('change', draw);
  card.querySelector('.pair-picker').addEventListener('click', e => e.stopPropagation());

  let drawn = false;
  card.querySelector('.conflict-card-header').addEventListener('click', () => {
    const wasOpen = card.classList.contains('open');
    card.classList.toggle('open');
    if (!wasOpen && !drawn) { drawn = true; draw(); }
  });

  return card;
}

// ── comparison view wiring ──

document.getElementById('cmpFileInput').addEventListener('change', e => {
  addComparisonFiles(e.target.files);
  e.target.value = ''; // allow re-adding the same file after removal
});

const cua = document.getElementById('cmpUploadArea');
cua.addEventListener('dragover', e => { e.preventDefault(); cua.classList.add('drag-over'); });
cua.addEventListener('dragleave', () => cua.classList.remove('drag-over'));
cua.addEventListener('drop', e => {
  e.preventDefault(); cua.classList.remove('drag-over');
  addComparisonFiles(e.dataTransfer.files);
});
