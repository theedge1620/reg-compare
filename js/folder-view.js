// RuleCheck — Folder Comparison tab (datasets written by folder_compare.py).

// ═════════════════════════════════════════════════════════════════════════════
// VIEW 3 — Folder comparison (dataset produced by folder_compare.py)
// ═════════════════════════════════════════════════════════════════════════════
//
// folder_compare.py runs the Document Comparison logic over every .docx in a
// folder and writes a JSON dataset. This view only displays it. Documents that
// share identical text are grouped into variants; each same-kind variant pair
// arrives with a precomputed redline as rows of [op, text] runs:
//   { t: 'omit', n }                  — n unchanged paragraphs
//   { t: 'diff', ops: [[op, text]] }  — op "=" unchanged, "-" deleted, "+" inserted

const FLD_SCHEMA = 'regdiff-folder/1';   // format id; kept from the original RegDiff name so existing datasets still load
const FLD_PAGE = 50;

let fld = null;
let fldView = null;

function fldResetView() {
  fldView = { q: '', doc: 'all', type: 'all', sim: 'all', sort: 'number', shown: FLD_PAGE };
}

async function loadFolderDataset(file) {
  if (!file) return;
  setStatusIn('fldStatusBar', '⏳', 'Reading dataset…', file.name);

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    setStatusIn('fldStatusBar', '⚠️', 'Not a readable dataset', `${file.name} is not valid JSON.`);
    return;
  }
  if (!data || data.schema !== FLD_SCHEMA || !Array.isArray(data.conflicts) || !Array.isArray(data.documents)) {
    setStatusIn('fldStatusBar', '⚠️', 'Not a folder-comparison dataset',
      `${file.name} was not written by folder_compare.py (expected schema "${FLD_SCHEMA}").`);
    return;
  }

  for (const d of data.documents) d.color = DOC_COLORS[d.id % DOC_COLORS.length];
  data.docById = new Map(data.documents.map(d => [d.id, d]));
  data.fileName = file.name;
  fld = data;
  fldResetView();
  document.getElementById('fldHowto').open = false;
  renderFolder();
}

function fldFmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString();
}

// Variant label: "V2 — A, C, F" (plus a marker when it is instruction prose).
function fldVariantLabel(c, vi) {
  const v = c.variants[vi];
  const tags = v.docs.map(id => fld.docById.get(id)?.tag ?? '?');
  const who = tags.length <= 5 ? tags.join(', ') : `${tags.slice(0, 4).join(', ')} +${tags.length - 4}`;
  return `V${vi + 1} — ${who}${v.kind === 'instruction' ? ' (instruction)' : ''}`;
}

// Precomputed rows → the { oldHtml, newHtml } rows renderDiffRows() draws.
// Viewing a pair in the opposite direction swaps the sides: what one variant
// deleted, the other inserted.
function fldRowsToDiffRows(rows, reversed) {
  return rows.map(r => {
    if (r.t === 'omit') return { type: 'omit', count: r.n };
    let oldHtml = '', newHtml = '';
    for (const [raw, text] of r.ops) {
      const op = !reversed ? raw : raw === '-' ? '+' : raw === '+' ? '-' : raw;
      if (op === '=') { oldHtml += esc(text); newHtml += esc(text); }
      else if (op === '-') oldHtml += `<span class="diff-del">${esc(text)}</span>`;
      else newHtml += `<span class="diff-add">${esc(text)}</span>`;
    }
    return { type: 'diff', label: '', oldHtml, newHtml };
  });
}

function fldSearchBlob(c) {
  if (c._blob === undefined) {
    c._blob = [
      `§ ${c.section}${c.pathLabel || c.path}`, `${c.section}${c.pathLabel || c.path}`, c.title || '',
      ...c.variants.map(v => v.text), ...c.instructions.map(i => i.text),
    ].join('\n').toLowerCase();
  }
  return c._blob;
}

function fldMatches(c) {
  if (fldView.doc !== 'all' && !c.docs.includes(Number(fldView.doc))) return false;
  const pairKinds = new Set(c.pairs.map(p => c.variants[p.a].kind));
  switch (fldView.type) {
    case 'text':        if (!pairKinds.has('text')) return false; break;
    case 'instruction': if (!pairKinds.has('instruction')) return false; break;
    case 'form':        if (!c.formsDiffer) return false; break;
    case 'multi':       if (c.variantCount < 3) return false; break;
  }
  if (fldView.sim !== 'all' && simBand(c.minSimilarity, c.formOnly) !== fldView.sim) return false;
  return !fldView.q || fldSearchBlob(c).includes(fldView.q);
}

function renderFolder() {
  const out = document.getElementById('fldResults');
  out.innerHTML = '';
  const s = fld.stats;
  const pl = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;

  setStatusIn('fldStatusBar', s.conflicts ? '⚠️' : '✅',
    s.conflicts
      ? `${pl(s.conflicts, 'conflicting subsection')} in ${pl(s.sectionsAffected, 'section')}`
      : 'No conflicting subsections',
    `${s.readable} of ${pl(s.documents, 'document')} readable`
      + (s.failed ? ` · ${s.failed} could not be read` : '')
      + ` · generated ${fldFmtDate(fld.generatedAt)}`
      + (s.readable < 2 ? ' · fewer than two readable documents, so nothing was compared' : ''));

  // ── source ──
  const meta = document.createElement('div');
  meta.className = 'fld-meta';
  const ecfr = 'ecfr' in fld
    ? (fld.ecfr
        ? `<span>Section numbers checked against eCFR Title 10 as of ${esc(fld.ecfr.date)}${fld.ecfr.source === 'stale cache' ? ' (cached; eCFR was unreachable)' : ''}</span>`
        : `<span>⚠ Built without the eCFR section list — an unmarked number counted as a section only when an instruction named it</span>`)
    : '';
  meta.innerHTML = `<span>📁 <code>${esc(fld.folder || '')}</code>${fld.recursive ? ' · including subfolders' : ''}</span>
    <span>Dataset: ${esc(fld.fileName)}</span>${ecfr}`;
  out.appendChild(meta);

  // ── summary strip ──
  const sum = document.createElement('div');
  sum.className = 'cmp-summary';
  sum.innerHTML = `
    <div class="cmp-stat"><span class="n">${s.documents}</span><span class="k">Documents</span></div>
    ${s.failed ? `<div class="cmp-stat"><span class="n flag">${s.failed}</span><span class="k">Unreadable</span></div>` : ''}
    <div class="cmp-stat"><span class="n">${s.shared}</span><span class="k">Shared subsections</span></div>
    <div class="cmp-stat"><span class="n${s.conflicts ? ' flag' : ''}">${s.conflicts}</span><span class="k">Conflicts</span></div>
    <div class="cmp-stat"><span class="n">${s.sectionsAffected}</span><span class="k">Sections affected</span></div>
    <div class="cmp-stat"><span class="n">${s.agreeing}</span><span class="k">In agreement</span></div>
    <div class="cmp-stat"><span class="n">${s.formOnly}</span><span class="k">Form differs only</span></div>`;
  out.appendChild(sum);

  // ── documents ──
  const docs = document.createElement('details');
  docs.className = 'fld-docs';
  docs.open = fld.documents.length <= 8;
  const num = v => (v === null || v === undefined) ? '' : v;
  docs.innerHTML = `
    <summary>Documents (${fld.documents.length})${s.failed ? `<span class="warn">${pl(s.failed, 'file')} could not be read</span>` : ''}</summary>
    <div class="fld-table-wrap"><table>
      <thead><tr><th></th><th>File</th><th>Subsections</th><th>Sections</th><th>Instructions</th><th>Instruction-only</th><th>Conflicts</th></tr></thead>
      <tbody>${fld.documents.map(d => d.error
        ? `<tr class="error"><td>${docTagHtml(d)}</td><td class="path">${esc(d.relPath || d.name)}</td><td colspan="5">⚠ ${esc(d.error)}</td></tr>`
        : `<tr><td>${docTagHtml(d)}</td><td class="path">${esc(d.relPath || d.name)}</td>
             <td class="num">${num(d.units)}</td><td class="num">${num(d.sections)}</td><td class="num">${num(d.instructions)}</td>
             <td class="num">${num(d.instructionOnly)}</td><td class="num">${num(d.conflicts)}</td></tr>`).join('')}
      </tbody></table></div>`;
  out.appendChild(docs);

  if (!s.conflicts) {
    out.insertAdjacentHTML('beforeend', s.shared
      ? `<div class="empty-state"><div class="icon">✅</div>No conflicts detected.<br>Every subsection shared by these documents has matching text.</div>`
      : `<div class="empty-state"><div class="icon">🔍</div>No subsection appears in more than one document.</div>`);
    return;
  }

  // ── filters ──
  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.innerHTML = `
    <input type="search" class="fld-search" placeholder="Search § number, heading or text…" aria-label="Search conflicts">
    <select class="fld-select" data-f="doc" aria-label="Filter by document">
      <option value="all">All documents</option>
      ${fld.documents.filter(d => !d.error && d.conflicts).map(d =>
        `<option value="${d.id}">${esc(d.tag + ' · ' + trunc(d.name, 32))} (${d.conflicts})</option>`).join('')}
    </select>
    <select class="fld-select" data-f="type" aria-label="Filter by conflict type">
      <option value="all">All conflict types</option>
      <option value="text">Text vs. text</option>
      <option value="instruction">Instruction vs. instruction</option>
      <option value="form">Form differs</option>
      <option value="multi">3 or more variants</option>
    </select>
    <select class="fld-select" data-f="sim" aria-label="Filter by similarity">
      <option value="all">Any similarity</option>
      ${SIM_BANDS.map(b => {
        const n = fld.conflicts.filter(c => simBand(c.minSimilarity, c.formOnly) === b.id).length;
        return `<option value="${b.id}">${b.label} (${b.range}) · ${n}</option>`;
      }).join('')}
    </select>
    <span class="filter-label" style="margin-left:0.5rem">Sort</span>
    <button class="filter-pill active" data-sort="number" type="button">Section order</button>
    <button class="filter-pill" data-sort="divergent" type="button">Most divergent</button>
    <span class="filter-count" id="fldCount"></span>`;
  out.appendChild(bar);

  let timer = null;
  bar.querySelector('.fld-search').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fldView.q = e.target.value.replace(/§/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      fldView.shown = FLD_PAGE;
      renderFolderList();
    }, 150);
  });
  bar.querySelectorAll('.fld-select').forEach(sel => sel.addEventListener('change', () => {
    fldView[sel.dataset.f] = sel.value;
    fldView.shown = FLD_PAGE;
    renderFolderList();
  }));
  bar.querySelectorAll('[data-sort]').forEach(btn => btn.addEventListener('click', () => {
    fldView.sort = btn.dataset.sort;
    bar.querySelectorAll('[data-sort]').forEach(b => b.classList.toggle('active', b === btn));
    renderFolderList();
  }));

  const hdr = document.createElement('div');
  hdr.className = 'amendments-header';
  hdr.innerHTML = `<h2>Conflicting Subsections</h2><span class="badge">${s.conflicts} found</span>`;
  out.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'amendment-cards';
  list.id = 'fldList';
  out.appendChild(list);

  const more = document.createElement('button');
  more.className = 'show-more';
  more.id = 'fldMore';
  more.type = 'button';
  more.addEventListener('click', () => { fldView.shown += FLD_PAGE; renderFolderList(); });
  out.appendChild(more);

  renderFolderList();
}

function renderFolderList() {
  let items = fld.conflicts.filter(fldMatches);
  if (fldView.sort === 'divergent') {
    // Form-only conflicts carry no similarity; rank them with the near-identical.
    items = items.slice().sort((a, b) =>
      ((a.minSimilarity ?? 1) - (b.minSimilarity ?? 1)) || (a.id - b.id));
  }

  const filtered = items.length !== fld.conflicts.length;
  document.getElementById('fldCount').textContent = filtered
    ? `${items.length} of ${fld.conflicts.length} shown` : '';

  const list = document.getElementById('fldList');
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><div class="icon">🔍</div>No conflicts match these filters.</div>`;
  }
  for (const c of items.slice(0, fldView.shown)) list.appendChild(buildFolderCard(c));

  const more = document.getElementById('fldMore');
  const remaining = items.length - fldView.shown;
  more.hidden = remaining <= 0;
  more.textContent = `Show ${Math.min(FLD_PAGE, remaining)} more · ${remaining} remaining`;
}

function buildFolderCard(c) {
  const card = document.createElement('div');
  card.className = 'conflict-card';

  // Presence strip: every document when the folder is small, else only holders.
  const present = new Set(c.docs);
  let tags;
  if (fld.documents.length <= 12) {
    tags = fld.documents.map(d => docTagHtml(d, present.has(d.id) ? '' : 'absent')).join('');
  } else {
    const ids = [...present];
    tags = ids.slice(0, 8).map(id => docTagHtml(fld.docById.get(id))).join('')
      + (ids.length > 8 ? `<span class="sec-more">+${ids.length - 8}</span>` : '');
  }

  const badges =
    (c.variantCount > 2 ? `<span class="sec-badge variants">${c.variantCount} variants</span>` : '')
    + (c.hasElision ? `<span class="sec-badge elision" title="Unchanged text elided with * * *">* * *</span>` : '')
    + (c.formsDiffer ? `<span class="sec-badge forms" title="One document sets out the text, another gives only the amendment instruction">${c.formOnly ? 'form differs' : 'mixed form'}</span>` : '');
  const sim = c.formOnly ? '—' : `${Math.round(c.minSimilarity * 100)}% alike`;

  const instrHtml = c.instructions.length ? `
    <div class="instr-block">
      <div class="instr-head">Amendment instructions affecting § ${esc(c.section)}</div>
      ${c.instructions.map(i => `
        <div class="instr-line">
          ${docTagHtml(fld.docById.get(i.doc))}
          <span class="instr-num">${i.num ? esc(i.num) + '.' : '•'}</span>
          <span class="instr-text">${esc(i.text.replace(INSTRUCTION_RE, '$2'))}</span>
        </div>`).join('')}
    </div>` : '';

  const legend = `
    <div class="variant-legend">
      ${c.variants.map((v, vi) => `
        <div class="variant-row">
          <span class="variant-id">V${vi + 1}</span>
          <span class="variant-kind">${v.kind === 'instruction' ? 'instruction' : 'amendatory text'}</span>
          <span class="sec-docs">${v.docs.slice(0, 10).map(id => docTagHtml(fld.docById.get(id))).join('')}</span>
          <span class="variant-names">${esc(v.docs.map(id => fld.docById.get(id)?.name ?? '').join(' · '))}</span>
        </div>`).join('')}
    </div>`;

  card.innerHTML = `
    <div class="conflict-card-header">
      <span class="sec-num">§ ${esc(c.section)}</span>
      <span class="sec-path">${esc(c.pathLabel || c.path || 'section body')}</span>
      <span class="sec-title${c.title ? '' : ' untitled'}">${esc(c.title || '')}</span>
      ${badges}
      <span class="sec-badge sim">${sim}</span>
      <span class="sec-docs">${tags}</span>
      <span class="amend-toggle">▼</span>
    </div>
    <div class="conflict-body">
      ${instrHtml}
      ${legend}
      <div class="pair-picker">
        <span>Redline</span>
        <select class="pick-a" aria-label="Left variant"></select>
        <span class="vs">vs</span>
        <select class="pick-b" aria-label="Right variant"></select>
        <span class="pair-note"></span>
      </div>
      <div class="redline-area"></div>
    </div>`;

  const selA = card.querySelector('.pick-a');
  const selB = card.querySelector('.pick-b');
  const options = c.variants.map((_, vi) => `<option value="${vi}">${esc(fldVariantLabel(c, vi))}</option>`).join('');
  selA.innerHTML = options;
  selB.innerHTML = options;
  selA.value = String(c.defaultPair[0]);
  selB.value = String(c.defaultPair[1]);

  const area = card.querySelector('.redline-area');
  const note = card.querySelector('.pair-note');

  let drawSeq = 0;
  function draw() {
    const seq = ++drawSeq;
    note.className = 'pair-note';
    note.textContent = '';
    if (selA.value === ECFR_SIDE || selB.value === ECFR_SIDE) {
      if (selA.value === selB.value) {
        area.innerHTML = `<div class="docx-note">Pick a variant to compare with the current eCFR.</div>`;
        return;
      }
      const ecfrRight = selB.value === ECFR_SIDE;
      const vi = Number(ecfrRight ? selA.value : selB.value);
      const v = c.variants[vi];
      drawEcfrRedline(area, note, c.section, c.path, c.pathLabel || c.path, {
        text: v.text, kind: v.kind, hasElision: v.hasElision, label: fldVariantLabel(c, vi),
      }, ecfrRight, () => seq === drawSeq);
      return;
    }

    const ia = Number(selA.value), ib = Number(selB.value);
    const va = c.variants[ia], vb = c.variants[ib];

    if (ia === ib) {
      area.innerHTML = `<div class="docx-note">Pick two different variants to see a redline.</div>`;
      return;
    }

    if (va.kind !== vb.kind) {
      const txt = va.kind === 'text' ? ia : ib;
      const ins = va.kind === 'text' ? ib : ia;
      note.textContent = 'different forms';
      area.innerHTML = `
        <div class="docx-note">⚠ These variants express the subsection differently, so they are shown side by side rather than redlined.
        <strong>V${txt + 1}</strong> sets out the amendatory text; <strong>V${ins + 1}</strong> gives only the amendment instruction.</div>
        ${renderDiffRows(
          [{ type: 'diff', label: '', oldHtml: esc(c.variants[txt].text), newHtml: esc(c.variants[ins].text) }],
          `${fldVariantLabel(c, txt)} · amendatory text`,
          `${fldVariantLabel(c, ins)}`)}`;
      return;
    }

    const pair = c.pairs.find(p => (p.a === ia && p.b === ib) || (p.a === ib && p.b === ia));
    if (!pair) {
      area.innerHTML = `<div class="ecfr-error">⚠ The dataset has no redline for this pair.</div>`;
      return;
    }
    note.textContent = `${Math.round(pair.similarity * 100)}% alike`;

    const notes =
      ((va.hasElision || vb.hasElision)
        ? `<div class="docx-note">⋯ This subsection carries a <code>* * *</code> elision — text not reprinted is unchanged and is not compared.</div>` : '')
      + (pair.rows.some(r => r.coarse)
        ? `<div class="docx-note">This passage is too long for a word-level redline, so it is marked as a whole.</div>` : '');

    area.innerHTML = notes + renderDiffRows(
      fldRowsToDiffRows(pair.rows, pair.a !== ia),
      fldVariantLabel(c, ia),
      fldVariantLabel(c, ib));
  }

  addEcfrChoice(card, c.section, selA, selB, draw);
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

// ── folder view wiring ──

document.getElementById('fldFileInput').addEventListener('change', e => {
  loadFolderDataset(e.target.files[0]);
  e.target.value = '';
});

const fua = document.getElementById('fldUploadArea');
fua.addEventListener('dragover', e => { e.preventDefault(); fua.classList.add('drag-over'); });
fua.addEventListener('dragleave', () => fua.classList.remove('drag-over'));
fua.addEventListener('drop', e => {
  e.preventDefault(); fua.classList.remove('drag-over');
  loadFolderDataset(e.dataTransfer.files[0]);
});
