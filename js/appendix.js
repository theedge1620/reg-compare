// RuleCheck — CFR appendices: Roman-numeral paragraph paths and redlines against the eCFR appendix.

// ─────────────────────────────────────────────────────────────────────────────
// Appendix structure
// ─────────────────────────────────────────────────────────────────────────────
//
// Appendices are not lettered like sections. The design-certification
// appendices to part 52, for example, nest by designator type:
//
//   VIII. Processes for Changes and Departures   ← Roman heading (level 1)
//   B. Tier 2 information.                       ← capital        (2)
//   6. a. An applicant who …                     ← digit, letter  (3, 4)
//   (3) (i) Result in a change …                 ← (digit), (roman) (5, 6)
//
// so that paragraph is cited VIII.B.6.a(3)(i). Paragraphs are keyed by that
// path, and a draft paragraph is only compared with the same path in the eCFR.

// "appendix D to part 52", "Appendix D to Part 52--Design Certification Rule…"
const APPENDIX_REF_RE = /\bappendix\s+([A-Z]{1,2}(?:-\d+)?|\d{1,2})\s+(?:to|of)\s+(?:10\s+CFR\s+)?part\s+(\d+[A-Za-z]?)\b/i;
// "VIII. Processes for Changes and Departures"
const APX_HEADING_RE = /^([IVXL]+)\.\s+(\S.*)$/;
// "* * *" opening a paragraph's text: its existing wording is kept up to here.
const APX_STARS_LEAD_RE = /^\*\s*\*\s*\*(?:\s*\*)*\s*/;
const APX_STARS_LINE_RE = /^\*(?:\s*\*){2,}\s*$/;

// Designator shapes in nesting order. A compound ("6. a.", "D.1.", "(3) (i)")
// must go strictly deeper, so "A. Tier 1 …" stops after the "A.".
const APX_LEVELS = [
  [/^([A-Z])\.(?=\s|\d|$)/, 2],
  [/^(\d{1,3})\.(?=\s|[a-z]\.|$)/, 3],
  [/^([a-z])\.(?=\s|\(|$)/, 4],
  [/^\((\d{1,3})\)/, 5],
  [/^\(([ivx]{1,5})\)/, 6],
  [/^\(([a-z])\)/, 7],
  [/^\(([A-Z])\)/, 8],
];

function appendixRef(text) {
  const m = unquoted(text).match(APPENDIX_REF_RE);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  return { letter, part: m[2], id: `Appendix ${letter} to Part ${m[2]}` };
}

function appendixEcfrUrl(apx) {
  return `https://www.ecfr.gov/current/title-10/part-${apx.part}/appendix-${encodeURIComponent(apx.id)}`;
}

// Leading designators deeper than `after`: { tokens: [{ level, label }], rest }.
function readAppendixDesignators(text, after = 0) {
  const tokens = [];
  let rest = text, last = after;
  for (;;) {
    let hit = null;
    for (const [re, level] of APX_LEVELS) {
      const m = rest.match(re);
      if (m && level > last) { hit = { level, label: m[1], len: m[0].length }; break; }
    }
    if (!hit) break;
    tokens.push(hit);
    last = hit.level;
    rest = rest.slice(hit.len).replace(/^\s+/, '');
  }
  return { tokens, rest };
}

// stack[level] = label → "VIII.B.6.a(3)(i)"
function appendixPath(stack) {
  let s = '';
  for (let l = 1; l < stack.length; l++) {
    if (!stack[l]) continue;
    s += l >= 5 ? `(${stack[l]})` : (s ? '.' : '') + stack[l];
  }
  return s;
}

function pushDesignators(stack, tokens) {
  stack.length = tokens[0].level;
  for (const t of tokens) stack[t.level] = t.label;
  stack.length = tokens[tokens.length - 1].level + 1;
}

// The FR prints an asterisk set off by a space ("Tier 2 * information"); the
// eCFR does not ("Tier 2* information").
function cleanAppendixText(s) {
  return s.replace(/\s+/g, ' ').replace(/(\w) \*(?=[\s,.;:)]|$)/g, '$1*').trim();
}

// Blocks [{ kind: 'heading' | 'para' | 'stars', text }] → chunks in order:
//   { type: 'header', path, text }     Roman heading
//   { type: 'para', path, text, elidedLead }
//   { type: 'omit' }                   "* * * * *"
// elidedLead: the text follows "* * *" — it is added to the paragraph's
// existing wording, which is not reprinted.
function appendixChunks(blocks) {
  const out = [];
  let stack = [];
  let open = null;   // the last paragraph, which an undesignated one continues
  for (const b of blocks) {
    if (b.kind === 'stars') { out.push({ type: 'omit' }); open = null; continue; }
    if (b.kind === 'heading') {
      const m = b.text.match(APX_HEADING_RE);
      stack = [];
      stack[1] = m ? m[1] : b.text;
      out.push({ type: 'header', path: stack[1], text: cleanAppendixText(b.text) });
      open = null;
      continue;
    }
    let { tokens, rest } = readAppendixDesignators(b.text);
    if (!tokens.length) {
      const text = cleanAppendixText(b.text);
      if (open) open.text += (open.text ? '\n' : '') + text;
      else out.push(open = { type: 'para', path: appendixPath(stack), text, elidedLead: false });
      continue;
    }
    pushDesignators(stack, tokens);
    let elidedLead = false;
    if (APX_STARS_LEAD_RE.test(rest)) {
      rest = rest.replace(APX_STARS_LEAD_RE, '');
      // "B. * * * 1. All nuclear …": B's own text is unchanged; B.1 follows.
      const more = readAppendixDesignators(rest, tokens[tokens.length - 1].level);
      if (more.tokens.length) { pushDesignators(stack, more.tokens); rest = more.rest; }
      else if (rest) elidedLead = true;
      else { open = null; continue; }   // "B. * * *" only marks the path
    }
    out.push(open = { type: 'para', path: appendixPath(stack), text: cleanAppendixText(rest), elidedLead });
  }
  return out;
}

// ── blocks from each source ─────────────────────────────────────────────────

// Federal Register plain text: a paragraph starts on an indented line and runs
// on through the unindented lines below it; headings stand alone after a blank.
function frAppendixBlocks(lines) {
  const blocks = [];
  let cur = null, afterBlank = true;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || /^\[\[Page \d+\]\]$/.test(t)) { afterBlank = true; continue; }
    if (SIGNATURE_RE.test(t)) break;
    if (APPENDIX_HEAD_RE.test(t)) { cur = null; afterBlank = false; continue; }
    if (APX_STARS_LINE_RE.test(t)) { blocks.push({ kind: 'stars' }); cur = null; afterBlank = false; continue; }
    if (/^\s{2,}\S/.test(raw)) {
      blocks.push(cur = { kind: 'para', text: t });
    } else if (!cur || (afterBlank && APX_HEADING_RE.test(t) && t.length < 120)) {
      const heading = APX_HEADING_RE.test(t) && t.length < 120;
      blocks.push({ kind: heading ? 'heading' : 'para', text: t });
      cur = heading ? null : blocks[blocks.length - 1];
    } else {
      // The FR wraps at hyphens and keeps them: "short-" + "term".
      cur.text += (cur.text.endsWith('-') ? '' : ' ') + t;
    }
    afterBlank = false;
  }
  return blocks;
}

// Working drafts: one block per paragraph. A short Roman-numbered line without
// closing punctuation is a heading ("V. Applicable Regulations").
function paragraphAppendixBlocks(paras) {
  const blocks = [];
  for (const p of paras) {
    const t = p.trim();
    if (!t) continue;
    if (SIGNATURE_RE.test(t)) break;
    if (APPENDIX_HEAD_RE.test(t)) continue;
    if (APX_STARS_LINE_RE.test(t)) blocks.push({ kind: 'stars' });
    else if (APX_HEADING_RE.test(t) && t.length < 120 && !/[.;:,]$/.test(t)) blocks.push({ kind: 'heading', text: t });
    else blocks.push({ kind: 'para', text: t });
  }
  return blocks;
}

// eCFR appendix XML: HD1 headings and P/FP paragraphs, without footnotes.
function ecfrAppendixBlocks(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const blocks = [];
  for (const el of doc.querySelectorAll('HD1, HD2, HD3, P, FP, FP-1, FP-2')) {
    if (el.closest('FTNT, NOTE, EDNOTE, CITA, AUTH, SOURCE, GPOTABLE')) continue;
    const copy = el.cloneNode(true);
    for (const su of copy.querySelectorAll('SU')) {
      if (su.nextElementSibling && su.nextElementSibling.nodeName === 'FTREF') su.remove();   // footnote mark
    }
    const text = copy.textContent.replace(/\s+/g, ' ').trim();
    if (text) blocks.push({ kind: el.nodeName === 'HD1' ? 'heading' : 'para', text });
  }
  return blocks;
}

// ── the instruction ─────────────────────────────────────────────────────────

// Paragraphs an appendix instruction names:
//   "Revise Sections V.A, VI.B.1 and 7, VII, and VIII.B.6"
//     → ["V.A", "VI.B.1", "VI.B.7", "VII", "VIII.B.6"]
// A short reference continues the one before it ("7" after "VI.B.1") when it
// is the same kind of designator as the part it replaces.
const APX_TARGET_TOKEN_RE = /^(?:[IVXL]+|[A-Z]|\d{1,3}|[a-z])(?:\.(?:[A-Z]|\d{1,3}|[a-z]))*(?:\((?:\d{1,3}|[ivx]{1,5}|[a-z]|[A-Z])\))*(?![\w])/;

function appendixPathComps(token) {
  const [dotted, ...parens] = token.split('(');
  return [...dotted.split('.'), ...parens.map(p => `(${p}`)];
}

function joinAppendixComps(comps) {
  return comps.reduce((s, c) => (c.startsWith('(') ? s + c : s ? `${s}.${c}` : c), '');
}

function appendixTargets(clause) {
  const kind = c => /^\(/.test(c) ? 'p' : /^\d+$/.test(c) ? 'n' : /^[a-z]$/.test(c) ? 'l' : /^[A-Z]$/.test(c) ? 'C' : 'R';
  const text = unquoted(clause);
  const out = [];
  const kw = /\b(?:Sections?|paragraphs?)\s+/gi;
  let m;
  while ((m = kw.exec(text)) !== null) {
    let pos = m.index + m[0].length;
    let prev = null;
    for (;;) {
      const t = APX_TARGET_TOKEN_RE.exec(text.slice(pos));
      if (!t) break;
      const comps = appendixPathComps(t[0]);
      let path = null;
      if (prev && comps.length < prev.length && kind(comps[0]) === kind(prev[prev.length - comps.length])) {
        path = prev.slice(0, prev.length - comps.length).concat(comps);
      } else if (/^[IVXL]+$/.test(comps[0])) {
        path = comps;
      }
      if (!path) break;
      const joined = joinAppendixComps(path);
      if (!out.includes(joined)) out.push(joined);
      prev = path;
      pos += t[0].length;
      const sep = /^(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)/.exec(text.slice(pos));
      if (!sep) break;
      pos += sep[0].length;
    }
    kw.lastIndex = pos;
  }
  return out;
}

// What the instruction does besides reprinting text:
//   revised  paths it revises — eCFR paragraphs under them that the reprinted
//            text leaves out are removed
//   subs     in-place edits: [{ paths, ops, wherever }]
function appendixInstructionEdits(instruction) {
  const body = instruction.replace(/^\s*\S+\.\s+/, '');
  const { clauses } = splitInstructionClauses(body);
  const revised = [], subs = [];
  for (const cl of clauses.length ? clauses : [body]) {
    if (clauses.length ? /^(?:Revise|Republish)\b/i.test(cl) : /\b(?:revis|republish)/i.test(cl)) {
      for (const p of appendixTargets(cl)) if (!revised.includes(p)) revised.push(p);
    }
    if (/^(?:Revise|Add|Republish)\b/i.test(cl)) continue;
    const ops = extractOps(normalizeQuotes(cl));
    const paths = appendixTargets(cl);
    if (ops.length && paths.length) subs.push({ paths, ops, wherever: /wherever it appears/i.test(cl) });
  }
  return { revised, subs };
}

// Complete an amendment to an appendix (see finishAmendment).
function finishAppendixAmendment(amend, apx, bodyText, paraMode) {
  const lines = bodyText.split('\n');
  const { revised, subs } = appendixInstructionEdits(amend.instruction);
  return {
    ...amend, sections: [], part: apx.part, appendix: apx,
    appendixChunks: appendixChunks(paraMode ? paragraphAppendixBlocks(lines) : frAppendixBlocks(lines)),
    appendixRevised: revised, appendixSubs: subs,
    proposedChunks: [], substitutions: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Redline rows: proposed appendix text against the eCFR appendix
// ─────────────────────────────────────────────────────────────────────────────
//
// Rows follow the proposed text. In-place edits and paragraphs a revision
// drops are slotted in by their position in the eCFR, so the redline reads in
// the appendix's own order.

// A paragraph rewritten outright reads better struck whole and replaced than
// as a word diff that threads the few shared words ("Tier", "the") through it.
const APX_REWRITE_KEEP = 0.4;   // below this share of old text kept, strike the whole

function appendixParagraphDiff(oldText, newText) {
  const d = computeDiff(oldText, newText);
  const kept = d.oldHtml.replace(/<span class="diff-del">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');
  if (kept.trim().length >= APX_REWRITE_KEEP * Math.max(oldText.length, newText.length)) return d;
  return {
    oldHtml: `<span class="diff-del">${esc(oldText)}</span>`,
    newHtml: `<span class="diff-add">${esc(newText)}</span>`,
  };
}

function appendixDiffRows(amend, ecfrChunks) {
  const ref = new Map();   // path (headings "#path") → { path, text, idx }
  ecfrChunks.forEach((c, idx) => {
    if (c.type === 'omit') return;
    const key = (c.type === 'header' ? '#' : '') + c.path;
    const prev = ref.get(key);
    if (prev) prev.text += '\n' + c.text;
    else ref.set(key, { path: c.path, text: c.text, idx });
  });

  // Match each proposed chunk. The FR sometimes drops a lone first designator
  // ("A." where the eCFR has "A.1."); text under a path the eCFR leaves empty
  // then matches its unclaimed first child.
  const proposedPaths = new Set(amend.appendixChunks.filter(c => c.type === 'para').map(c => c.path));
  const matched = new Set();
  const resolved = amend.appendixChunks.map(c => {
    if (c.type === 'omit') return { c };
    if (c.type === 'header') return { c, r: ref.get('#' + c.path) };
    let r = ref.get(c.path);
    if (!r && c.text) {
      for (const child of [`${c.path}.1`, `${c.path}(1)`]) {
        if (ref.has(child) && !proposedPaths.has(child) && !matched.has(child)) { r = { ...ref.get(child), implied: true }; break; }
      }
    }
    if (r) matched.add(r.path);
    return { c, r };
  });

  const inScope = path => amend.appendixRevised.some(R => path === R || path.startsWith(R + '.') || path.startsWith(R + '('));
  const pending = [];   // { idx, row, kind: 'del' | 'sub' }
  for (const [key, r] of ref) {
    if (key.startsWith('#') || matched.has(r.path) || !inScope(r.path)) continue;
    pending.push({ idx: r.idx, kind: 'del',
      row: { type: 'diff', label: r.path, oldHtml: `<span class="diff-del">${esc(r.text)}</span>`, newHtml: '' } });
  }
  for (const sub of amend.appendixSubs) {
    for (const path of sub.paths) {
      const r = ref.get(path);
      if (!r || matched.has(path)) continue;
      const amended = applySubstitutions(r.text, sub.ops, sub.wherever);
      if (amended === r.text) continue;
      const { oldHtml, newHtml } = computeDiff(r.text, amended);
      pending.push({ idx: r.idx, kind: 'sub', row: { type: 'diff', label: path, oldHtml, newHtml } });
    }
  }
  pending.sort((a, b) => a.idx - b.idx);

  const rows = [];
  const take = k => { const out = []; while (pending.length && pending[0].idx < k) out.push(pending.shift()); return out; };
  const nextIdx = i => { for (let j = i + 1; j < resolved.length; j++) if (resolved[j].r) return resolved[j].r.idx; return Infinity; };

  resolved.forEach(({ c, r }, i) => {
    if (c.type === 'omit') {
      // Dropped paragraphs belong to the text above the stars; in-place edits
      // further on sit in the unchanged stretch the stars stand for.
      const due = take(nextIdx(i));
      rows.push(...due.filter(p => p.kind === 'del').map(p => p.row), { type: 'omit' });
      const subs = due.filter(p => p.kind === 'sub');
      if (subs.length) rows.push(...subs.map(p => p.row), { type: 'omit' });
      return;
    }
    if (r) rows.push(...take(r.idx).map(p => p.row));
    if (c.type === 'header') {
      if (!r || substantiveKey(r.text) === substantiveKey(c.text)) rows.push({ type: 'header', text: c.text });
      else rows.push({ type: 'diff', label: '', ...computeDiff(r.text, c.text) });
      return;
    }
    const label = r && r.implied ? `${r.path} (unnumbered in the draft)` : c.path;
    if (!r) {
      rows.push({ type: 'diff', label, oldHtml: '',
        newHtml: `<span class="diff-add">${esc((c.elidedLead ? '* * * ' : '') + c.text)}</span>` });
      return;
    }
    rows.push({ type: 'diff', label, ...appendixParagraphDiff(r.text, c.elidedLead ? `${r.text} ${c.text}` : c.text) });
  });
  rows.push(...take(Infinity).map(p => p.row));
  return rows;
}
