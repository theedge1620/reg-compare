// RuleCheck — Export a displayed redline as a Word (.docx) RLSO document.

// ─────────────────────────────────────────────────────────────────────────────
// DOCX — minimal ZIP writer (no dependencies)
// ─────────────────────────────────────────────────────────────────────────────
//
// The counterpart of docx-reader.js: a .docx is a ZIP archive of a few XML
// parts. Entries are stored uncompressed, which Word reads without complaint
// and keeps this to a CRC and two kinds of header.

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, text }] → Blob of a stored (method 0) ZIP archive.
function zipStore(files, mime) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, ZIP_LOCAL, true);
    local.setUint16(4, 20, true);              // version needed
    local.setUint16(6, 0x0800, true);          // UTF-8 names
    local.setUint16(8, 0, true);               // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local, name, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, ZIP_CD, true);
    cd.setUint16(4, 20, true);                 // version made by
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, ZIP_EOCD, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eocd], { type: mime });
}

// ─────────────────────────────────────────────────────────────────────────────
// RLSO — the two redline columns merged into one struck-out/underlined text
// ─────────────────────────────────────────────────────────────────────────────
//
// Each redline row is one paragraph shown twice: the left cell with its
// deletions marked, the right with its insertions. Both cells carry the same
// unchanged text in the same order, so walking them together yields the
// single-column RLSO run sequence: deletions, then insertions, at each change.

// A cell's runs as [{ kind: 'eq' | 'del' | 'add', text }], plus its label badge.
function rlsoCellRuns(cell) {
  const runs = [];
  let label = '';
  for (const n of cell.childNodes) {
    if (n.nodeType === 1 && n.classList.contains('para-label')) { label = n.textContent; continue; }
    const kind = n.nodeType !== 1 ? 'eq'
      : n.classList.contains('diff-del') ? 'del'
      : n.classList.contains('diff-add') ? 'add' : 'eq';
    pushRun(runs, kind, n.textContent);
  }
  return { label, runs };
}

function pushRun(runs, kind, text) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.kind === kind) last.text += text;
  else runs.push({ kind, text });
}

// Interleave a left (eq/del) and right (eq/add) cell. Returns null if their
// unchanged text disagrees — the cells were not a word-level redline.
function mergeRlsoRuns(left, right) {
  const out = [];
  let i = 0, j = 0, oi = 0, oj = 0;   // run index and char offset on each side
  while (i < left.length || j < right.length) {
    if (i < left.length && left[i].kind === 'del') { pushRun(out, 'del', left[i++].text); continue; }
    if (j < right.length && right[j].kind === 'add') { pushRun(out, 'add', right[j++].text); continue; }
    if (i >= left.length || j >= right.length) return null;
    const a = left[i].text.slice(oi), b = right[j].text.slice(oj);
    const k = Math.min(a.length, b.length);
    if (a.slice(0, k) !== b.slice(0, k)) return null;
    pushRun(out, 'eq', a.slice(0, k));
    oi += k; oj += k;
    if (oi === left[i].text.length) { i++; oi = 0; }
    if (oj === right[j].text.length) { j++; oj = 0; }
  }
  return out;
}

// A rendered redline pane → document paragraphs [{ runs, style }].
// Runs that span a line break (whole-text fallback diffs) become separate
// paragraphs, so the export is always one Word paragraph per text paragraph.
function rlsoParagraphs(pane) {
  const paras = [];
  for (const row of pane.querySelectorAll('.diff-row')) {
    if (row.dataset.kind === 'omit') { paras.push({ style: 'omit', runs: [{ kind: 'eq', text: '* * * * *' }] }); continue; }
    if (row.dataset.kind === 'header') {
      paras.push({ style: 'header', runs: [{ kind: 'eq', text: row.querySelector('.diff-cell').textContent }] });
      continue;
    }
    const left = rlsoCellRuns(row.querySelector('.diff-cell.current'));
    const right = rlsoCellRuns(row.querySelector('.diff-cell.proposed'));
    const merged = mergeRlsoRuns(left.runs, right.runs) || [
      ...left.runs.map(r => ({ kind: 'del', text: r.text })),
      ...right.runs.map(r => ({ kind: 'add', text: r.text })),
    ];

    let cur = [];
    const lines = [cur];
    for (const r of merged) {
      r.text.split('\n').forEach((piece, k) => {
        if (k) lines.push(cur = []);
        if (piece) cur.push({ kind: r.kind, text: piece });
      });
    }
    let first = true;
    for (const runs of lines) {
      if (!runs.some(r => r.text.trim())) continue;
      if (first && left.label) runs.unshift({ kind: 'label', text: left.label + ' ' });
      first = false;
      paras.push({ style: 'body', runs });
    }
  }
  return paras;
}

// What the redline is of, read from the card around it.
function rlsoContext(pane) {
  const text = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const amend = pane.closest('.amendment-card');
  if (amend) {
    const cfr = text(amend.querySelector('.amend-cfr'));
    return { heading: cfr || `Amendment ${text(amend.querySelector('.amend-num'))}`,
             subtitle: text(amend.querySelector('.amend-meta .instruction')) };
  }
  const card = pane.closest('.conflict-card');
  if (!card) return { heading: 'Redline', subtitle: '' };
  const row = pane.closest('.icr-row');
  const path = text(row ? row.querySelector('.icr-row-head .sec-path') : card.querySelector('.conflict-card-header .sec-path'));
  return {
    heading: [text(card.querySelector('.conflict-card-header .sec-num')), path === 'section body' ? '' : path].filter(Boolean).join(' '),
    subtitle: text(card.querySelector('.conflict-card-header .sec-title')),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WordprocessingML
// ─────────────────────────────────────────────────────────────────────────────

function xmlEsc(s) {
  return String(s)
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const RLSO_RUN_PROPS = {
  eq: '',
  del: '<w:strike/><w:color w:val="C00000"/>',
  add: '<w:u w:val="single"/><w:color w:val="0070C0"/>',
  label: '<w:b/>',
  bold: '<w:b/>',
  note: '<w:i/><w:color w:val="595959"/><w:sz w:val="20"/>',
};

function docxRun(kind, text) {
  const rpr = RLSO_RUN_PROPS[kind] || '';
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
}

function docxPara(runs, ppr = '') {
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${runs.map(r => docxRun(r.kind, r.text)).join('')}</w:p>`;
}

function buildRlsoDocx({ heading, subtitle, leftLabel, rightLabel, notes, paras }) {
  const spaced = '<w:spacing w:after="160"/>';
  const body = [
    docxPara([{ kind: 'eq', text: heading }], '<w:pStyle w:val="Title"/>'),
    subtitle ? docxPara([{ kind: 'bold', text: subtitle }], spaced) : '',
    docxPara([{ kind: 'note', text: `Redline of ${leftLabel} → ${rightLabel}. ` },
              { kind: 'del', text: 'Deleted text is struck through' },
              { kind: 'note', text: '; ' },
              { kind: 'add', text: 'added text is underlined' },
              { kind: 'note', text: `. Generated by RuleCheck on ${new Date().toLocaleDateString()}.` }], spaced),
    ...notes.map(n => docxPara([{ kind: 'note', text: n }], spaced)),
    ...paras.map(p => p.style === 'omit'
      ? docxPara(p.runs, `<w:jc w:val="center"/>${spaced}`)
      : docxPara(p.style === 'header' ? p.runs.map(r => ({ ...r, kind: 'bold' })) : p.runs, spaced)),
  ].join('');

  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  return zipStore([
    { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'word/styles.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>` },
    { name: 'word/document.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>` },
  ], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

// ─────────────────────────────────────────────────────────────────────────────
// Export button (rendered by renderDiffRows on every tab)
// ─────────────────────────────────────────────────────────────────────────────

function exportRlso(pane) {
  const ctx = rlsoContext(pane);
  const labels = pane.querySelectorAll('.diff-col-label');
  // The caveats shown above the redline (elisions, applied instructions) travel with it.
  const notes = [...pane.parentElement.querySelectorAll(':scope > .docx-note')]
    .map(n => n.textContent.replace(/\s+/g, ' ').replace(/§\s*\S+\s+on eCFR ↗/g, '').replace(/^[^\w§(]+/, '').trim())
    .filter(Boolean);
  const blob = buildRlsoDocx({
    ...ctx,
    leftLabel: labels[0]?.textContent || 'left', rightLabel: labels[1]?.textContent || 'right',
    notes, paras: rlsoParagraphs(pane),
  });
  const name = `RLSO ${ctx.heading}`.replace(/§\s*/g, '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.rlso-btn');
  if (!btn) return;
  e.stopPropagation();
  exportRlso(btn.closest('.diff-pane'));
});
