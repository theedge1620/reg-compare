// RuleCheck — Current eCFR text as a redline side on the comparison tabs.

// ─────────────────────────────────────────────────────────────────────────────
// Current eCFR text as a redline side (Document and Folder Comparison)
// ─────────────────────────────────────────────────────────────────────────────
//
// The eCFR section is read with the drafts' own parser (parseAmendmentDoc), so
// its paragraphs are keyed exactly like theirs — nested designators resolved,
// definitions by term — and a draft subsection is compared with the same
// subsection of the current rule. Sections are fetched when first asked for.

const ECFR_SIDE = 'ecfr';
const ecfrUnitCache = new Map();   // section → Promise<units Map>

// eCFR section XML → plain paragraphs, led by a "§ N Title" heading (the
// title tells the parser whether this is a definitions section).
//
// The eCFR prints a headed paragraph and its first child as one paragraph —
// "(c) <I>Filings after the deadline.</I> (1) Hearing requests …" — where
// drafts put "(1)" on its own line. Split those so "(i)" below resolves to
// (c)(1)(i) on both sides.
const ECFR_CHILD_START_RE = /^\((?:[a-z]{1,4}|\d{1,3}|[A-Z])\)\s/;

function ecfrSectionParagraphs(xmlText, section) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const clean = s => s.replace(/\s+/g, ' ').trim();
  const head = doc.querySelector('HEAD') || doc.querySelector('SUBJECT');
  const title = head ? clean(head.textContent).replace(/^§+\s*[\d.]+[A-Za-z]*\s*/, '') : '';
  const paras = [`§ ${section} ${title}`.trim()];

  for (const p of doc.querySelectorAll('P, FP, FP-1, FP-2, FPTEXT')) {
    if (p.closest('NOTE, FTNT, EDNOTE, CITA, AUTH, SOURCE')) continue;
    // Text up to the end of the paragraph's italic heading, and the rest.
    let lead = '', rest = '', past = false;
    for (const n of p.childNodes) {
      if (past) { rest += n.textContent; continue; }
      lead += n.textContent;
      if (n.nodeType === 1 && /^(?:E|I)$/.test(n.nodeName)) past = true;
    }
    const child = clean(rest).replace(/^[—–:.-]\s*/, '');   // "Heading—(1) …"
    if (past && /^\s*(?:\([A-Za-z0-9]+\))+\s*\S/.test(lead) && ECFR_CHILD_START_RE.test(child)) {
      paras.push(clean(lead), child);
    } else {
      const t = clean(p.textContent);
      if (t) paras.push(t);
    }
  }
  return paras;
}

function ecfrSectionUnits(section) {
  let p = ecfrUnitCache.get(section);
  if (!p) {
    p = fetchEcfrSectionXml(section.split('.')[0], section).then(xml => {
      const paras = ecfrSectionParagraphs(xml, section);
      if (!paras) throw new Error('the eCFR returned unreadable XML');
      return parseAmendmentDoc(paras).units;
    });
    p.catch(() => ecfrUnitCache.delete(section));   // let a later click retry
    ecfrUnitCache.set(section, p);
  }
  return p;
}

// Apply an instruction's "remove X and add Y" edits to the eCFR text of the
// paragraph at `path`. Strict: null unless every edit aimed at this paragraph
// finds its phrase, so a redline is never built on a guess.
function applyInstructionToEcfr(ecfrText, instruction, path) {
  const subs = parseSubstitutionInstruction(instruction)
    .filter(s => !s.para || (s.paras || [s.para]).includes(path));
  if (!subs.length) return null;
  let text = ecfrText;
  for (const { ops, wherever } of subs) {
    for (const op of ops) {
      if (!op.remove) return null;            // add-only: position unknown
      const re = new RegExp(escapeRegex(op.remove), wherever ? 'gi' : 'i');
      if (!re.test(text)) return null;
      text = text.replace(re, op.add);
    }
  }
  return text === ecfrText ? null : text;
}

// Compare one draft subsection with the same subsection of a reference text
// (the current eCFR, or the regulation library on the Info Collections tab).
//   units  the reference section parsed by parseAmendmentDoc
//   draft  { text, kind, hasElision, label }
// Returns { status, refText, draftText, sim } where status is
//   'missing'     no counterpart in the reference (new, or renumbered)
//   'same'        substantively identical
//   'changed'     differs — redline refText → draftText
//   'applied'     an instruction whose edits applied cleanly; draftText is the result
//   'instruction' an instruction whose edits could not be applied
function compareWithReference(units, section, path, draft) {
  let unit = units.get(`${section}|${path}`);
  // A draft that keeps "(a) Heading—(1) Text …" on one line is compared with
  // the reference heading and its first child joined the same way.
  const inline = unit && draft.text.match(/^[^()\n]*?[—–.:-]\s*\(([a-zA-Z0-9]+)\)\s/);
  const child = inline && units.get(`${section}|${path}(${inline[1]})`);
  if (child) unit = { ...unit, text: `${unit.text}—(${inline[1]}) ${child.text}` };

  if (!unit) return { status: 'missing', refText: '', draftText: draft.text, sim: null };
  if (draft.kind === 'instruction') {
    const amended = applyInstructionToEcfr(unit.text, draft.text, path);
    return amended !== null
      ? { status: 'applied', refText: unit.text, draftText: amended, sim: similarity(unit.text, amended) }
      : { status: 'instruction', refText: unit.text, draftText: draft.text, sim: null };
  }
  if (substantiveKey(unit.text) === substantiveKey(draft.text)) {
    return { status: 'same', refText: unit.text, draftText: draft.text, sim: 1 };
  }
  return { status: 'changed', refText: unit.text, draftText: draft.text, sim: similarity(unit.text, draft.text) };
}

// Draw a compareWithReference() result.
//   ref       { short: 'eCFR', name: 'the current eCFR', label, link }
//   refRight  reference on the right instead of the left
function renderReferenceComparison(area, note, cmp, ref, where, draft, refRight) {
  const show = (rows, draftLabel) => renderDiffRows(rows,
    refRight ? draftLabel : ref.label, refRight ? ref.label : draftLabel);
  const redline = (refText, draftText) => refRight
    ? diffParagraphBlocks(draftText, refText) : diffParagraphBlocks(refText, draftText);
  const sideBySide = (refText, draftText) => [{
    type: 'diff', label: '',
    oldHtml: esc(refRight ? draftText : refText), newHtml: esc(refRight ? refText : draftText),
  }];
  note.className = 'pair-note';

  switch (cmp.status) {
    case 'missing':
      note.textContent = `not in ${ref.short}`;
      area.innerHTML = `<div class="docx-note">${esc(where)} has no counterpart in ${esc(ref.name)} — the draft adds it, or numbers it differently. ${ref.link}</div>`
        + show(sideBySide('', cmp.draftText), draft.label);
      return;
    case 'applied':
      note.textContent = `instruction applied to ${ref.short} text`;
      area.innerHTML = `<div class="docx-note">This draft gives only the amendment instruction; its edits are applied to ${esc(ref.name)} text below. ${ref.link}</div>`
        + show(redline(cmp.refText, cmp.draftText), `${draft.label} — instruction applied`);
      return;
    case 'instruction':
      note.textContent = 'different forms';
      area.innerHTML = `<div class="docx-note">⚠ This draft gives only the amendment instruction, and its edits could not be applied to ${esc(ref.name)} text automatically, so the two are shown side by side. ${ref.link}</div>`
        + show(sideBySide(cmp.refText, cmp.draftText), `${draft.label} — instruction only`);
      return;
    case 'same':
      note.className = 'pair-note same';
      note.textContent = `Matches ${ref.short}`;
      area.innerHTML = `<div class="docx-note">✅ This draft's text for ${esc(where)} is the same as ${esc(ref.name)}. ${ref.link}</div>`;
      return;
  }
  note.textContent = `${Math.round(cmp.sim * 100)}% alike`;
  const elided = draft.hasElision
    ? `<div class="docx-note">⋯ The draft elides part of this subsection with <code>* * *</code>; that text is unchanged but will show as missing from the draft below.</div>`
    : '';
  area.innerHTML = elided + show(redline(cmp.refText, cmp.draftText), draft.label)
    + `<div class="docx-note">${ref.link}</div>`;
}

function ecfrLink(section) {
  return `<a href="https://www.ecfr.gov/current/title-10/part-${esc(section.split('.')[0])}/section-${esc(section)}" target="_blank">§ ${esc(section)} on eCFR ↗</a>`;
}

// Redline one draft's subsection against the current eCFR.
//   draft     { text, kind, hasElision, label }
//   ecfrRight eCFR on the right instead of the left
//   isCurrent false once the card has redrawn, so a slow fetch can't overwrite
async function drawEcfrRedline(area, note, section, path, pathLabel, draft, ecfrRight, isCurrent) {
  note.className = 'pair-note';
  note.textContent = '';
  area.innerHTML = `<div class="loading-ecfr"><div class="spinner"></div>Fetching current eCFR text for § ${esc(section)}…</div>`;

  let units;
  try {
    units = await ecfrSectionUnits(section);
  } catch (e) {
    if (!isCurrent()) return;
    note.textContent = 'not in eCFR';
    area.innerHTML = `<div class="ecfr-error">⚠ ${e.status === 404
      ? `§ ${esc(section)} is not in the current eCFR — the drafts may be adding it.`
      : `Could not retrieve § ${esc(section)} from the eCFR (${esc(e.message)}).`}</div>`;
    return;
  }
  const date = await getTitle10Date();
  if (!isCurrent()) return;

  const ref = { short: 'eCFR', name: 'the current eCFR', label: `Current eCFR (as of ${date})`, link: ecfrLink(section) };
  renderReferenceComparison(area, note, compareWithReference(units, section, path, draft), ref,
    `§ ${section}${pathLabel ? ' ' + pathLabel : ''}`, draft, ecfrRight);
}

// Add the eCFR choice to a card's pair picker and a one-click shortcut to it.
function addEcfrChoice(card, section, selA, selB, draw) {
  const opt = `<option value="${ECFR_SIDE}">eCFR · current § ${esc(section)}</option>`;
  selA.insertAdjacentHTML('afterbegin', opt);
  selB.insertAdjacentHTML('afterbegin', opt);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ecfr-btn';
  btn.textContent = 'Compare with current eCFR';
  // Keep the left-hand draft and move the eCFR in beside it, on the left.
  btn.addEventListener('click', () => {
    const keep = [selA.value, selB.value].find(v => v !== ECFR_SIDE) ?? selA.options[1].value;
    selA.value = ECFR_SIDE;
    selB.value = keep;
    draw();
  });
  card.querySelector('.pair-picker .vs').nextElementSibling.after(btn);
}
