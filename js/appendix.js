// RuleCheck — CFR appendices: Roman-numeral paragraph paths and the eCFR appendix text.

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
// so that paragraph is cited VIII.B.6.a(3)(i). Other appendices use "Section
// IV" headings, unnumbered headings ("Introduction", "General Information"),
// or "Criterion 17—…" paragraphs, which are cited by name wherever they sit.
// Paragraphs are keyed by that path, and a draft paragraph is only compared
// with the same path in the eCFR.

// "appendix D to part 52", "Appendix D to Part 52--Design Certification Rule…"
const APPENDIX_REF_RE = /\bappendix\s+([A-Z]{1,2}(?:-\d+)?|\d{1,2})\s+(?:to|of)\s+(?:10\s+CFR\s+)?part\s+(\d+[A-Za-z]?)\b/i;
// "VIII. Processes for Changes and Departures", "Section IV", "Section VI. Alternative …"
const APX_ROMAN_HEAD_RE = /^(?:Section\s+)?([IVXL]+)\.?(?:\s+(.*))?$/;
// "Criterion 17—Electric power systems. …"
const APX_CRITERION_RE = /^Criterion\s+(\d+[A-Za-z]?)\b/;
// "* * *" opening a paragraph's text: its existing wording is kept up to here.
const APX_STARS_LEAD_RE = /^\*\s*\*\s*\*(?:\s*\*)*\s*/;
const APX_TITLE_PATH = '(title)';

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

// The appendix an instruction amends. "Add appendix T to read as follows"
// names no part; `partHint` is the part whose heading it falls under.
function appendixRef(text, partHint = null) {
  const plain = unquoted(text);
  let m = plain.match(APPENDIX_REF_RE);
  if (!m && partHint) {
    const bare = plain.match(/^(?:\S+\.\s+)?(?:Add|Revise|Remove|Amend|Republish|In)\s+(?:and\s+republish\s+)?(?:new\s+)?appendix\s+([A-Z]{1,2}(?:-\d+)?)\b/i);
    if (bare) m = [bare[0], bare[1], partHint];
  }
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

// The FR prints an asterisk set off by a space ("Tier 2 * information") and a
// dash as "--"; the eCFR does not.
function cleanAppendixText(s) {
  return frSectionText(s.replace(/\s+/g, ' ')).replace(/(\w) \*(?=[\s,.;:)]|$)/g, '$1*').trim();
}

// "[3] The use of 25 rem …" — footnote text, not a paragraph of the appendix.
const APX_FOOTNOTE_RE = /^\[\d{1,3}\]\s/;

function romanValue(s) {
  const v = { I: 1, V: 5, X: 10, L: 50 };
  if (!/^[IVXL]+$/.test(s)) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) n += v[s[i]] < (v[s[i + 1]] || 0) ? -v[s[i]] : v[s[i]];
  return n;
}

// An unnumbered heading is keyed by its words.
function headingKey(text) {
  return substantiveKey(text);
}

// Blocks [{ kind: 'title' | 'heading' | 'para' | 'stars', text }] → chunks in order:
//   { type: 'header', path, text }     heading; text null for a "II. * * *" marker
//   { type: 'para', path, text, elidedLead }
//   { type: 'omit' }                   "* * * * *"
// elidedLead: the text follows "* * *" — it is added to the paragraph's
// existing wording, which is not reprinted. A paragraph's undesignated
// follow-on paragraphs are joined to it with "\n".
function appendixChunks(blocks) {
  const out = [];
  let stack = [];
  let open = null;   // the last paragraph, which an undesignated one continues
  const heading = (path, text) => {
    stack = [];
    stack[1] = path;
    out.push({ type: 'header', path, text });
    open = null;
  };

  for (const b of blocks) {
    if (b.kind === 'stars') { out.push({ type: 'omit' }); open = null; continue; }
    const text = cleanAppendixText(b.text);
    if (APX_FOOTNOTE_RE.test(text)) continue;
    if (b.kind === 'title' || APPENDIX_HEAD_RE.test(text)) {
      out.push({ type: 'header', path: APX_TITLE_PATH, text });
      stack = []; open = null;
      continue;
    }
    // "II. * * *" (a heading kept as it is) and "Section VI. …" headings. "I.",
    // "V." or "X." after a later Roman heading is a lettered sub-heading
    // ("I. Onsite Protective Actions …" under IV).
    let roman = text.match(APX_ROMAN_HEAD_RE);
    if (roman && roman[1].length === 1 && stack[1] && romanValue(stack[1]) >= romanValue(roman[1])) roman = null;
    const romanMarker = roman && roman[2] !== undefined && APX_STARS_LEAD_RE.test(roman[2]) && !roman[2].replace(APX_STARS_LEAD_RE, '');
    if (romanMarker) { heading(roman[1], null); continue; }
    // An eCFR heading element is a heading whatever its punctuation ("I. Purpose.").
    if (roman && (/^Section\s/.test(text) || b.strong || (b.kind === 'heading' && !/^[IVXL]\.\s+\S+.*[.;:]$/.test(text)))) {
      heading(roman[1], text);
      continue;
    }
    if (APX_CRITERION_RE.test(text)) {
      stack = [];
      stack[1] = `Criterion ${text.match(APX_CRITERION_RE)[1]}`;
      out.push(open = { type: 'para', path: stack[1], text, elidedLead: false });
      continue;
    }

    let { tokens, rest } = readAppendixDesignators(text);
    if (!tokens.length) {
      if (b.kind === 'heading') { heading(headingKey(text), text); continue; }
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
    out.push(open = { type: 'para', path: appendixPath(stack), text: rest, elidedLead });
  }
  return out;
}

// ── blocks from each source ─────────────────────────────────────────────────

// Working drafts: one block per paragraph. A short Roman-numbered line without
// closing punctuation is a heading ("V. Applicable Regulations").
function paragraphAppendixBlocks(paras) {
  const blocks = [];
  for (const p of paras) {
    const t = p.trim();
    if (!t) continue;
    if (SIGNATURE_RE.test(t)) break;
    if (APPENDIX_HEAD_RE.test(t)) blocks.push({ kind: 'title', text: t });
    else if (ELISION_RE.test(t) || /^\*(?:\s*\*){4}\s*$/.test(t)) blocks.push({ kind: 'stars' });
    else if (t.length < 120 && !/[.;:,]$/.test(t) && (APX_ROMAN_HEAD_RE.test(t) || !readAppendixDesignators(t).tokens.length)
             && /^[A-Z]/.test(t) && t.split(/\s+/).length <= 12) blocks.push({ kind: 'heading', text: t });
    else blocks.push({ kind: 'para', text: t });
  }
  return blocks;
}

// eCFR appendix XML: the title, HD1–HD3 headings and P/FP paragraphs, without footnotes.
function ecfrAppendixBlocks(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return null;
  const blocks = [];
  const head = doc.querySelector('DIV9 > HEAD, DIV5 > HEAD, HEAD');
  if (head) blocks.push({ kind: 'title', text: head.textContent.replace(/\s+/g, ' ').trim() });
  for (const el of doc.querySelectorAll('HD1, HD2, HD3, P, FP, FP-1, FP-2')) {
    if (el.closest('FTNT, NOTE, EDNOTE, CITA, AUTH, SOURCE, GPOTABLE')) continue;
    const copy = el.cloneNode(true);
    for (const su of copy.querySelectorAll('SU')) {
      if (su.nextElementSibling && su.nextElementSibling.nodeName === 'FTREF') su.remove();   // footnote mark
    }
    const text = copy.textContent.replace(/\s+/g, ' ').trim();
    if (text) blocks.push(el.nodeName.startsWith('HD') ? { kind: 'heading', text, strong: true } : { kind: 'para', text });
  }
  return blocks;
}

// ── instruction targets ─────────────────────────────────────────────────────
//
// "Revise Sections V.A, VI.B.1 and 7, VII, and VIII.B.6" → V.A, VI.B.1,
// VI.B.7, VII, VIII.B.6. A short reference continues the one before it ("7"
// after "VI.B.1"), or the context the instruction set up ("In appendix A to
// part 52, section VIII, … In B, … revise paragraph 3" → VIII.B.3).

const APX_TARGET_TOKEN_RE = /^(?:[IVXL]+|[A-Z]|\d{1,3}|[a-z])(?:\.(?:[A-Z]|\d{1,3}|[a-z]))*(?:\((?:\d{1,3}|[ivx]{1,5}|[a-z]|[A-Z])\))*\.?(?![\w])/;

function appendixPathComps(token) {
  const [dotted, ...parens] = token.replace(/\.$/, '').split('(');
  return [...dotted.split('.').filter(Boolean), ...parens.map(p => `(${p}`)];
}

function joinAppendixComps(comps) {
  return comps.reduce((s, c) => (c.startsWith('(') ? s + c : s ? `${s}.${c}` : c), '');
}

function appendixCompKind(c, i) {
  if (c.startsWith('(')) return 'p';
  if (/^\d+$/.test(c)) return 'n';
  if (/^[a-z]$/.test(c)) return 'l';
  if (i === 0 && /^[IVXL]+$/.test(c)) return 'R';   // the first component is the Roman heading
  return /^[A-Z]$/.test(c) ? 'C' : 'R';
}

// A reference read against `base` (the path it is relative to, as components).
// A Roman numeral that is plainly a heading ("VIII", "V.A") starts afresh;
// anything else replaces the base from its own level down ("7" after
// "VI.B.1" → VI.B.7), or hangs below it ("3.a" under VIII.B → VIII.B.3.a).
function resolveAppendixRef(comps, base) {
  if (/^[IVXL]+$/.test(comps[0]) && (comps[0].length > 1 || comps.length > 1 || !base.length)) return comps;
  if (!base.length) return null;
  const kind = appendixCompKind(comps[0], 1);
  for (let p = base.length - 1; p >= 1; p--) {
    if (appendixCompKind(base[p], p) === kind) return base.slice(0, p).concat(comps);
  }
  return base.concat(comps);
}

function bumpComp(c) {
  if (/^\d+$/.test(c)) return String(Number(c) + 1);
  if (/^[a-zA-Z]$/.test(c)) return String.fromCharCode(c.charCodeAt(0) + 1);
  return null;
}

// Targets in one stretch of instruction text, read against `base`:
// [{ path, intro }] — intro: only the paragraph's introductory text.
function appendixTargets(text, base = []) {
  text = unquoted(text);
  const out = [];
  const push = (comps, intro) => {
    const path = joinAppendixComps(comps);
    if (!out.some(t => t.path === path)) out.push({ path, intro });
  };
  const kw = /\b(?:Sections?|paragraphs?|criteri(?:on|a))\s+/gi;
  let m;
  while ((m = kw.exec(text)) !== null) {
    const criteria = /^criteri/i.test(m[0]);
    const section = /^sections?/i.test(m[0]);
    let pos = m.index + m[0].length;
    let prev = null;
    for (;;) {
      const rest = text.slice(pos);
      const t = criteria ? /^\d+[A-Za-z]?(?![\w])/.exec(rest) : APX_TARGET_TOKEN_RE.exec(rest);
      if (!t) break;
      const comps = criteria ? [`Criterion ${t[0]}`] : appendixPathComps(t[0]);
      // "section I" names a Roman heading outright.
      const resolved = criteria || (section && /^[IVXL]+$/.test(comps[0])) ? comps : resolveAppendixRef(comps, prev || base);
      if (!resolved) break;
      pos += t[0].length;
      const intro = /^\s*(?:introductory text|(?:first|second|last) sentence of the introductory text)/i.test(text.slice(pos));
      // "IV.5. through 7." — a range of siblings
      const range = /^\s*through\s+/i.exec(text.slice(pos));
      if (range && prev !== resolved) {
        const endTok = APX_TARGET_TOKEN_RE.exec(text.slice(pos + range[0].length));
        const end = endTok && resolveAppendixRef(appendixPathComps(endTok[0]), resolved);
        if (end && end.length === resolved.length) {
          let cur = resolved.slice();
          for (let guard = 0; guard < 60; guard++) {
            push(cur, false);
            if (cur[cur.length - 1] === end[end.length - 1]) break;
            const next = bumpComp(cur[cur.length - 1]);
            if (!next) break;
            cur = cur.slice(0, -1).concat(next);
          }
          pos += range[0].length + endTok[0].length;
          prev = end;
        } else {
          push(resolved, intro);
          prev = resolved;
        }
      } else {
        push(resolved, intro);
        prev = resolved;
      }
      const sep = /^(?:\s*introductory text)?(?:\s*(?:second|first|last) sentence of the introductory text)?(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)(?:(?:paragraphs?|Sections?)\s+)?/i.exec(text.slice(pos));
      if (!sep) break;
      pos += sep[0].length;
    }
    kw.lastIndex = pos;
  }
  return out;
}

// The path an instruction's wording places later references under:
// "section VIII, ``Processes …''" in the lead, "In B, …" or "In Section IV,"
// opening a clause.
function appendixContext(text, base = []) {
  const plain = unquoted(text);
  const sec = plain.match(/\b(?:in\s+)?section\s+([IVXL]+)\b(?!\.[A-Z0-9])/i);
  let ctx = base;
  if (sec && !/\b(?:revise|remove|add|reserve)\s+(?:and\s+\w+\s+)?section\s+[IVXL]+/i.test(plain)) ctx = [sec[1]];
  const sub = plain.match(/^\s*In\s+([A-Z]|\d{1,3})\b(?![.(])/);   // "In B, …", "In B ``Tier 2 …''"
  if (sub) ctx = resolveAppendixRef([sub[1]], ctx) || ctx;
  return ctx;
}

// Complete an amendment to an appendix (see finishAmendment).
function finishAppendixAmendment(amend, apx, bodyText, paraMode) {
  const lines = bodyText.split('\n');
  return {
    ...amend, sections: [], part: apx.part, appendix: apx,
    appendixChunks: appendixChunks(paraMode ? paragraphAppendixBlocks(lines) : frBlocks(lines).map(b =>
      b.kind === 'heading' && APPENDIX_HEAD_RE.test(b.text) ? { ...b, kind: 'title' } : b)),
    edits: instructionEdits(amend.instruction, 'appendix', ''),
    proposedChunks: [], bodyParas: [],
  };
}
