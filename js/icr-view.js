// RuleCheck — Info Collections tab: a working draft's information-collection sections vs. the existing rule.

// ═════════════════════════════════════════════════════════════════════════════
// VIEW 4 — Information collections (library built by build_icr_library.py)
// ═════════════════════════════════════════════════════════════════════════════
//
// data/icr-library.js holds the 10 CFR sections that each part's OMB-approval
// section (§ 50.8, § 30.8, …) lists as containing information collection
// requirements, with their control numbers and current text. A dropped working
// draft is parsed exactly as on Document Comparison; every section it touches
// that is on the list is shown, and each of its subsections is compared with
// the same subsection of the library text (compareWithReference).

const ICR_LIBRARY_SRC = 'data/icr-library.js';
const ICR_STATUS = {
  changed:     { label: 'changed',              cls: 'changed' },
  applied:     { label: 'changed (instruction)', cls: 'changed' },
  instruction: { label: 'instruction',          cls: 'forms' },
  missing:     { label: 'new',                  cls: 'new' },
  removed:     { label: 'removed',              cls: 'removed' },
  same:        { label: 'unchanged',            cls: 'same' },
};

let icrLibraryPromise = null;
const icrUnitCache = new Map();   // section → units Map of the library text
let icrResult = null;             // { fileName, sections[], other[], title10 }
let icrFilter = 'changed';

// Loaded on first use: it is several megabytes, and only this tab needs it.
function loadIcrLibrary() {
  if (window.RULECHECK_ICR) return Promise.resolve(window.RULECHECK_ICR);
  if (!icrLibraryPromise) {
    icrLibraryPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ICR_LIBRARY_SRC;
      s.onload = () => window.RULECHECK_ICR
        ? resolve(window.RULECHECK_ICR)
        : reject(new Error(`${ICR_LIBRARY_SRC} did not define the library.`));
      s.onerror = () => reject(new Error(`${ICR_LIBRARY_SRC} was not found — run build_icr_library.py to create it.`));
      document.head.appendChild(s);
    }).catch(e => { icrLibraryPromise = null; throw e; });
  }
  return icrLibraryPromise;
}

function icrSectionUnits(lib, section, title10) {
  if (!icrUnitCache.has(section)) {
    icrUnitCache.set(section, parseAmendmentDoc(lib.sections[section].paras, title10).units);
  }
  return icrUnitCache.get(section);
}

// "Revise § 50.8 to read as follows" sets out the whole section, so a library
// paragraph the draft no longer has has been removed — provided the draft
// elides nothing. A paragraph-level revision says nothing about the
// paragraphs it doesn't reprint.
function revisesWholeSection(instructions, section) {
  const sec = escapeRegex(section);
  const re = new RegExp(`(?:^|[:;.]\\s*(?:[a-z]\\.\\s+)?)Revise\\s+§\\s*${sec}(?:\\s+and\\s+(?:the\\s+)?section\\s+heading)?\\s+to\\s+read\\s+as\\s+follows`, 'i');
  return instructions.some(ins => ins.refs.includes(section) && re.test(ins.body));
}

// ── analysis ────────────────────────────────────────────────────────────────

function analyzeIcr(lib, parsed, title10) {
  const bySection = new Map();
  for (const unit of parsed.units.values()) {
    if (!bySection.has(unit.section)) bySection.set(unit.section, []);
    bySection.get(unit.section).push(unit);
  }
  for (const ins of parsed.instructions) {
    for (const r of ins.refs) if (!bySection.has(r)) bySection.set(r, []);
  }

  const sections = [], other = [];
  for (const [section, units] of bySection) {
    const entry = lib.sections[section];
    if (!entry) { other.push(section); continue; }

    const libUnits = icrSectionUnits(lib, section, title10);
    const rows = units.sort(compareUnits).map(unit => ({
      unit,
      cmp: compareWithReference(libUnits, section, unit.path,
        { text: unit.text, kind: unit.kind, hasElision: unit.hasElision }),
    }));
    // A "* * *" anywhere means omitted text is unchanged, not removed.
    if (revisesWholeSection(parsed.instructions, section) && !units.some(u => u.hasElision)) {
      const seen = new Set(units.map(u => u.path));
      for (const lu of libUnits.values()) {
        if (lu.kind === 'text' && !seen.has(lu.path)) {
          rows.push({ unit: { ...lu, text: '' }, cmp: { status: 'removed', refText: lu.text, draftText: '', sim: 0 } });
        }
      }
      rows.sort((a, b) => compareUnits(a.unit, b.unit));
    }
    const counts = {};
    for (const r of rows) counts[r.cmp.status] = (counts[r.cmp.status] || 0) + 1;
    sections.push({
      section, entry, rows, counts,
      changed: rows.some(r => r.cmp.status !== 'same'),
      instructions: parsed.instructions.filter(ins => ins.refs.includes(section)),
    });
  }
  sections.sort((a, b) => compareSectionNumbers(a.section, b.section));
  other.sort(compareSectionNumbers);
  return { sections, other };
}

// ── rendering ───────────────────────────────────────────────────────────────

function icrControlsHtml(entry) {
  const seen = new Set();
  return entry.controls.filter(c => {
    const k = c.number + '|' + c.what;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(c => `<span class="icr-control" title="${esc(c.what)} — approved under § ${esc(c.source)}">OMB ${esc(c.number)}${
    c.what.startsWith('part ') ? '' : ` · ${esc(trunc(c.what, 40))}`}</span>`).join('');
}

function renderIcrLibraryInfo(lib) {
  const box = document.getElementById('icrLibrary');
  const n = Object.keys(lib.sections).length;
  const parts = Object.entries(lib.parts).sort((a, b) => Number(a[0]) - Number(b[0]));
  box.innerHTML = `
    <details class="fld-docs">
      <summary>Information-collection library · ${n} sections in ${parts.length} parts · 10 CFR as of ${esc(lib.snapshot || '?')}</summary>
      <div class="fld-table-wrap">
        <table>
          <thead><tr><th>Part</th><th>OMB section</th><th>Control no.</th><th>Sections with information collections</th></tr></thead>
          <tbody>${parts.map(([p, info]) => `
            <tr>
              <td class="num">${esc(p)}</td>
              <td class="num">§ ${esc(info.ombSection)}</td>
              <td class="num">${esc(info.controlNumbers.join(', '))}</td>
              <td class="path">${info.sections.map(s => esc(s)).join(', ')}${
                info.appendices.length ? `; appendi${info.appendices.length > 1 ? 'ces' : 'x'} ${esc(info.appendices.join(', '))}` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </details>`;
}

function renderIcr() {
  const out = document.getElementById('icrResults');
  out.innerHTML = '';
  if (!icrResult) return;
  const { sections, other, lib } = icrResult;
  const changed = sections.filter(s => s.changed);
  const totals = {};
  for (const s of sections) for (const [k, v] of Object.entries(s.counts)) totals[k] = (totals[k] || 0) + v;

  const sum = document.createElement('div');
  sum.className = 'cmp-summary';
  sum.innerHTML = `
    <div class="cmp-stat"><span class="n">${sections.length + other.length}</span><span class="k">Sections in draft</span></div>
    <div class="cmp-stat"><span class="n">${sections.length}</span><span class="k">With info collections</span></div>
    <div class="cmp-stat"><span class="n${changed.length ? ' flag' : ''}">${changed.length}</span><span class="k">Of those, changed</span></div>
    <div class="cmp-stat"><span class="n">${(totals.changed || 0) + (totals.applied || 0)}</span><span class="k">Subsections changed</span></div>
    <div class="cmp-stat"><span class="n">${totals.missing || 0}</span><span class="k">New subsections</span></div>
    <div class="cmp-stat"><span class="n">${totals.removed || 0}</span><span class="k">Removed</span></div>`;
  out.appendChild(sum);

  if (!sections.length) {
    out.innerHTML += `<div class="empty-state"><div class="icon">✅</div>None of the ${other.length} section${other.length !== 1 ? 's' : ''} this document amends contains information collection requirements.</div>`;
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.innerHTML = `<span class="filter-label">Show</span>`;
  for (const [value, label] of [['changed', `Changed (${changed.length})`], ['all', `All (${sections.length})`]]) {
    const b = document.createElement('button');
    b.className = 'filter-pill' + (icrFilter === value ? ' active' : '');
    b.textContent = label;
    b.dataset.value = value;
    bar.appendChild(b);
  }
  bar.addEventListener('click', e => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    icrFilter = pill.dataset.value;
    renderIcr();
  });
  out.appendChild(bar);

  const hdr = document.createElement('div');
  hdr.className = 'amendments-header';
  hdr.innerHTML = `<h2>Sections with Information Collections</h2><span class="badge">${sections.length} found</span>`;
  out.appendChild(hdr);

  const list = document.createElement('div');
  list.className = 'amendment-cards';
  for (const s of sections) {
    if (icrFilter === 'changed' && !s.changed) continue;
    list.appendChild(buildIcrCard(s, lib));
  }
  if (!list.children.length) {
    list.innerHTML = `<div class="empty-state"><div class="icon">✅</div>The draft leaves the text of every information-collection section it touches unchanged.</div>`;
  }
  out.appendChild(list);

  if (other.length) {
    const note = document.createElement('div');
    note.className = 'docx-note icr-other';
    note.textContent = `Also amended, with no information collections listed: ${other.map(s => '§ ' + s).join(', ')}`;
    out.appendChild(note);
  }
}

function buildIcrCard(s, lib) {
  const card = document.createElement('div');
  card.className = 'conflict-card';
  const badges = Object.entries(ICR_STATUS)
    .filter(([k]) => s.counts[k])
    .map(([k, v]) => `<span class="sec-badge icr-${v.cls}">${s.counts[k]} ${v.label}</span>`).join('');

  const instrHtml = s.instructions.length ? `
    <div class="instr-block">
      <div class="instr-head">Amendment instructions affecting § ${esc(s.section)}</div>
      ${s.instructions.map(ins => `
        <div class="instr-line">
          <span class="instr-num">${ins.num ? esc(ins.num) + '.' : '•'}</span>
          <span class="instr-text">${esc(ins.text.replace(INSTRUCTION_RE, '$2'))}</span>
        </div>`).join('')}
    </div>` : '';

  card.innerHTML = `
    <div class="conflict-card-header">
      <span class="sec-num">§ ${esc(s.section)}</span>
      <span class="sec-title${s.entry.title ? '' : ' untitled'}">${esc(s.entry.title || '')}</span>
      ${badges}
      <span class="amend-toggle">▼</span>
    </div>
    <div class="conflict-body">
      <div class="icr-meta">
        <span>Listed in § ${s.entry.listedIn.map(esc).join(', § ')}</span>
        <span class="icr-controls">${icrControlsHtml(s.entry)}</span>
        ${ecfrLink(s.section)}
      </div>
      ${instrHtml}
      <div class="icr-rows"></div>
    </div>`;

  const ref = {
    short: 'regulation', name: 'the existing regulation',
    label: `Existing regulation (10 CFR as of ${lib.snapshot || '?'})`, link: '',
  };
  const rowsBox = card.querySelector('.icr-rows');
  for (const { unit, cmp } of s.rows) {
    const st = ICR_STATUS[cmp.status];
    const row = document.createElement('div');
    row.className = 'icr-row';
    const pct = cmp.status === 'changed' || cmp.status === 'applied' ? `<span class="sec-badge sim">${Math.round(cmp.sim * 100)}% alike</span>` : '';
    row.innerHTML = `
      <div class="icr-row-head">
        <span class="sec-path">${esc(unit.pathLabel || unit.path || 'section body')}</span>
        <span class="sec-badge icr-${st.cls}">${st.label}</span>${pct}
        <span class="icr-row-preview">${esc(trunc(cmp.draftText || cmp.refText, 110))}</span>
        <span class="amend-toggle">▼</span>
      </div>
      <div class="icr-row-body"><span class="pair-note"></span><div class="redline-area"></div></div>`;
    let drawn = false;
    row.querySelector('.icr-row-head').addEventListener('click', () => {
      row.classList.toggle('open');
      if (drawn) return;
      drawn = true;
      const area = row.querySelector('.redline-area');
      const note = row.querySelector('.pair-note');
      if (cmp.status === 'removed') {
        note.textContent = 'removed';
        area.innerHTML = `<div class="docx-note">The draft revises the whole of § ${esc(s.section)} and no longer contains this subsection.</div>`
          + renderDiffRows([{ type: 'diff', label: '', oldHtml: `<span class="diff-del">${esc(cmp.refText)}</span>`, newHtml: '' }],
            ref.label, `Draft — ${trunc(icrResult.fileName, 46)}`);
        return;
      }
      renderReferenceComparison(area, note, cmp, ref,
        `§ ${s.section}${unit.pathLabel || unit.path ? ' ' + (unit.pathLabel || unit.path) : ''}`,
        { ...unit, label: `Draft — ${trunc(icrResult.fileName, 46)}` }, false);
    });
    rowsBox.appendChild(row);
  }

  let opened = false;
  card.querySelector('.conflict-card-header').addEventListener('click', () => {
    card.classList.toggle('open');
    // A section with a single changed subsection opens straight to its redline.
    if (!opened) {
      opened = true;
      const rows = rowsBox.querySelectorAll('.icr-row');
      if (rows.length === 1) rows[0].querySelector('.icr-row-head').click();
    }
  });
  return card;
}

// ── file handling ───────────────────────────────────────────────────────────

async function handleIcrFile(file) {
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) {
    setStatusIn('icrStatusBar', '⚠️', 'Not a .docx file', 'This tab reads FRN working documents in Word .docx format.');
    return;
  }
  document.getElementById('icrResults').innerHTML = '';
  try {
    setStatusIn('icrStatusBar', '⏳', 'Loading the information-collection library…', ICR_LIBRARY_SRC);
    const lib = await loadIcrLibrary();
    setStatusIn('icrStatusBar', '⏳', 'Loading the eCFR section list…',
      'Title 10 section numbers are used to tell section headings from numbers that just start a line');
    const title10 = await getTitle10Sections();
    setStatusIn('icrStatusBar', '⏳', 'Reading document…', file.name);
    const parsed = parseAmendmentDoc(await readDocxParagraphs(file), title10.map);
    const { sections, other } = analyzeIcr(lib, parsed, title10.map);
    icrResult = { fileName: file.name, sections, other, lib };
    const changed = sections.filter(s => s.changed).length;
    setStatusIn('icrStatusBar', sections.length ? (changed ? '⚠️' : '✅') : '✅',
      sections.length
        ? `${sections.length} section${sections.length !== 1 ? 's' : ''} with information collections · ${changed} changed`
        : 'No information-collection sections amended',
      `${file.name} · compared with 10 CFR as of ${lib.snapshot || '?'} · click a section to see its subsections` + title10Note(title10));
    renderIcr();
  } catch (e) {
    console.error(e);
    setStatusIn('icrStatusBar', '⚠️', `Could not check ${file.name}`, e.message);
  }
}

document.getElementById('icrFileInput').addEventListener('change', e => {
  handleIcrFile(e.target.files[0]);
  e.target.value = '';
});

const iua = document.getElementById('icrUploadArea');
iua.addEventListener('dragover', e => { e.preventDefault(); iua.classList.add('drag-over'); });
iua.addEventListener('dragleave', () => iua.classList.remove('drag-over'));
iua.addEventListener('drop', e => {
  e.preventDefault(); iua.classList.remove('drag-over');
  handleIcrFile(e.dataTransfer.files[0]);
});

// Show what the library covers as soon as the tab is opened (or linked to).
function showIcrLibraryInfo() {
  loadIcrLibrary().then(renderIcrLibraryInfo).catch(e => {
    document.getElementById('icrLibrary').innerHTML = `<div class="ecfr-error">⚠ ${esc(e.message)}</div>`;
  });
}
document.querySelector('.tab[data-view="icr"]').addEventListener('click', showIcrLibraryInfo);
if (location.hash === '#icr') showIcrLibraryInfo();
