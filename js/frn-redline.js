// RuleCheck — FRN vs. eCFR tab — what an instruction does, and the redline it produces.

// ─────────────────────────────────────────────────────────────────────────────
// Instruction edits
// ─────────────────────────────────────────────────────────────────────────────
//
// Besides the text it reprints, an instruction says what happens to text it
// doesn't reprint:
//   revised   [{ section, path, intro }]   paragraphs replaced by the reprinted
//             text — what the reprint leaves out of them is removed. intro:
//             only the introductory text; its sub-paragraphs stay.
//   removals  [{ section, path | term, reserve }]
//   subs      [{ section, paths, ops, wherever, last, heading }]  in-place edits
//   whole     { section, op: 'revise' | 'remove' | 'add', reserve }  the whole
//             section or appendix
// `kind` is 'section' (designators "(a)(1)") or 'appendix' ("VIII.B.6").

const EDIT_VERB_RE = /\b(revis(?:e|ing)(?:\s+and\s+republish(?:ing)?)?|republish(?:ing)?|remov(?:e|ing)\s+and\s+reserv(?:e|ing)|remov(?:e|ing)|reserv(?:e|ing)|add(?:ing)?|redesignat(?:e|ing)|amend(?:ing)?)\b/gi;
const PASSIVE_EDIT_RE = /\b(?:is|are)\s+(revised|removed|reserved)\b/i;

// Lettered clauses: "In § 110.45: a. … ; and b. …". The FR also letters
// clauses after a comma or a closing quote ("In appendix A to part 50, a. Under
// the heading ``Introduction,'' …. b. …").
function editClauses(body) {
  const marks = [];
  let expect = 'a';
  for (const m of body.matchAll(/([:;.,'"”])\s+(?:and\s+)?([a-z])\.\s+/g)) {
    if (m[2] !== expect) continue;
    marks.push(m);
    expect = String.fromCharCode(expect.charCodeAt(0) + 1);
  }
  if (!marks.length) return { lead: body, clauses: [] };
  return {
    lead: body.slice(0, marks[0].index + 1).trim(),
    clauses: marks.map((m, i) => body.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index + 1 : body.length).trim()),
  };
}

function instructionEdits(instruction, kind, defaultSection) {
  const body = instruction.replace(/^\s*(?:\d{1,3}|X{1,3}|x{2,3})\.\s+/, '');
  const { lead, clauses } = editClauses(body);
  const edits = { revised: [], removals: [], subs: [], whole: null };
  const leadBase = kind === 'appendix' ? appendixContext(lead) : [];

  for (const clause of clauses.length ? clauses : [body]) {
    const section = kind === 'section' ? (instructionSections(clause)[0] || defaultSection) : '';
    const base = kind === 'appendix' ? appendixContext(clause, leadBase) : [];
    const quoted = normalizeQuotes(clause);
    const terms = instructionDefinitionTerms(quoted);
    // "In the definition for ``Basic component'', revise paragraph (1)(i)" —
    // paragraphs inside that definition.
    const inTerm = kind === 'section' && terms.length === 1 ? `“${termKey(terms[0])}”` : '';
    const targetsIn = text => (kind === 'appendix' ? appendixTargets(text, base)
      : sectionTargets(text).map(t => ({ ...t, path: inTerm + t.path })));

    // "remove the definition for ``X''", "the definition for ``X'' is removed"
    let removedDefs = false;
    for (const { verb, text } of editSegments(quoted)) {
      if (!/^remov|^removed$/i.test(verb) || !/\bdefinitions?\b/i.test(text)) continue;
      for (const term of instructionDefinitionTerms(text)) {
        edits.removals.push({ section, term, path: kind === 'section' ? `“${termKey(term)}”` : null, reserve: false });
        removedDefs = true;
      }
    }
    if (removedDefs) continue;

    const ops = extractOps(quoted);
    if (ops.length) {
      let paths = targetsIn(clause).map(t => t.path);
      if (!paths.length && inTerm) paths = [inTerm];
      // "Amend section I by revising paragraph C.6. by removing …" names I.C.6.
      paths = paths.filter(p => !paths.some(q => q !== p && isUnderPath(p, q)));
      for (const op of ops) {
        if (op.remove) op.remove = frSectionText(op.remove);
        if (op.add) op.add = frSectionText(op.add);
      }
      edits.subs.push({
        section, paths, ops,
        wherever: /wherever it appears/i.test(clause),
        last: /\blast paragraph\b/i.test(clause),
        heading: (quoted.match(/\bheading\s+"([^"]+?)[,.]?"/i) || clause.match(/^\s*In the ([A-Z][\w ]*?),/) || [])[1] || null,
      });
      continue;
    }

    for (const { verb, text } of editSegments(quoted)) {
      const targets = targetsIn(text);
      // "the introductory paragraphs to Section I", "the introductory text of paragraph (a)"
      const intro = /\bintroductory\s+(?:text|paragraphs?)\s+(?:to|of|in)\b/i.test(text);
      if (/^(?:revis|republish)/i.test(verb)) {
        if (targets.length) edits.revised.push(...targets.map(t => ({ section, path: t.path, intro: t.intro || intro })));
        else if (namesWhole(text, kind)) edits.whole = { section, op: 'revise' };
      } else if (/^(?:remov|reserv)/i.test(verb)) {
        const reserve = /reserv/i.test(verb);
        if (targets.length) edits.removals.push(...targets.map(t => ({ section, path: t.path, reserve })));
        else if (namesWhole(text, kind)) edits.whole = { section, op: 'remove', reserve };
      } else if (/^add/i.test(verb) && !targets.length && namesWhole(text, kind)) {
        edits.whole = { section, op: 'add' };
      }
    }
  }
  return edits;
}

// A clause split at its verbs: "revise paragraph (a)(1), remove and reserve
// paragraph (a)(2), and add …" → three segments. A passive clause ("criteria
// 17, 19 … are revised") is one segment.
// Verbs inside quoted wording don't count; the segments keep their quotes.
// A passive "the definition for ``X'' is removed" runs up to its verb.
function editSegments(clause) {
  const masked = clause.replace(QUOTED_RE, q => ' '.repeat(q.length));
  const marks = [...masked.matchAll(EDIT_VERB_RE)];
  if (!marks.length) {
    const p = masked.match(PASSIVE_EDIT_RE);
    return p ? [{ verb: p[1], text: clause }] : [];
  }
  return marks.map((m, i) => ({ verb: m[1], text: clause.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : clause.length) }));
}

// "Revise Sec. 50.46a to read …", "Remove and reserve Sec. 52.33", "Add appendix T …",
// but not "Revise the section heading" or "the title of Appendix I".
function namesWhole(text, kind) {
  text = unquoted(text);
  if (/\b(?:heading|title|introductory)\b/i.test(text)) return false;
  return kind === 'appendix' ? /\bappendix\s+[A-Z0-9]/i.test(text) : /(?:Sec\.|§)\s*\d+\.\d+[A-Za-z]*\b(?!\s*\()/.test(text);
}

function hasEdits(edits) {
  return Boolean(edits && (edits.revised.length || edits.removals.length || edits.subs.length || edits.whole));
}

// ── section designator targets ──────────────────────────────────────────────
//
// "paragraphs (a)(4) and (5)" → (a)(4), (a)(5); "(b) through (d)" → (b), (c),
// (d); "Sec. 20.1601(f)" → (f). A shorter reference replaces the previous one
// from the first level of its own kind.

const SEC_TARGET_RE = /^(?:\((?:[a-z]{1,2}|\d{1,3}|[ivxlc]{1,6}|[A-Z]{1,2})\))+/;
const ROMANS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx', 'xxi', 'xxii', 'xxiii', 'xxiv', 'xxv'];

function designatorKinds(group) {
  const t = group.slice(1, -1);
  if (/^\d+$/.test(t)) return ['n'];
  if (/^[ivx]$/.test(t)) return ['l', 'r'];
  if (/^[a-z]{1,2}$/.test(t) && !ROMANS.includes(t)) return ['l'];
  if (ROMANS.includes(t)) return ['r'];
  return ['U'];
}

// Only a single designator is relative; "(b)(10)" is stated in full.
function resolveSectionRef(comps, prev) {
  if (!prev || comps.length > 1 || comps.length >= prev.length) return comps;
  const kinds = designatorKinds(comps[0]);
  for (let p = prev.length - 1; p >= 0; p--) {
    if (designatorKinds(prev[p]).some(k => kinds.includes(k))) return prev.slice(0, p).concat(comps);
  }
  return comps;
}

// The designator after `group`, counting in roman numerals when `roman`.
function nextDesignator(group, roman) {
  const t = group.slice(1, -1);
  if (/^\d+$/.test(t)) return `(${Number(t) + 1})`;
  const r = ROMANS.indexOf(t);
  if (roman && r !== -1 && r + 1 < ROMANS.length) return `(${ROMANS[r + 1]})`;
  if (/^[a-zA-Z]$/.test(t)) return `(${String.fromCharCode(t.charCodeAt(0) + 1)})`;
  return null;
}

function sectionTargets(text) {
  text = unquoted(text);
  const out = [];
  const push = (comps, intro) => {
    const path = comps.join('');
    if (!out.some(t => t.path === path)) out.push({ path, intro });
  };
  const kw = /\bparagraphs?\s+|(?:§|Sec\.)\s*\d+\.\d+[A-Za-z]*(?=\()/g;
  let m;
  while ((m = kw.exec(text)) !== null) {
    let pos = m.index + m[0].length;
    let prev = null;
    for (;;) {
      const tok = SEC_TARGET_RE.exec(text.slice(pos));
      if (!tok) break;
      const comps = resolveSectionRef(tok[0].match(/\([^)]+\)/g), prev);
      pos += tok[0].length;
      const intro = /^\s*introductory text/i.test(text.slice(pos));
      const range = /^\s*through\s+/i.exec(text.slice(pos));
      const endTok = range && SEC_TARGET_RE.exec(text.slice(pos + range[0].length));
      if (endTok) {
        const end = resolveSectionRef(endTok[0].match(/\([^)]+\)/g), comps);
        // "(iv) through (xiii)" counts in roman numerals; "(b) through (d)" in letters.
        const ends = [comps[comps.length - 1], end[end.length - 1]].map(g => g.slice(1, -1));
        const roman = ends.some(t => t.length > 1 && ROMANS.includes(t)) || ends.every(t => ROMANS.includes(t) && t !== 'c');
        let cur = comps;
        for (let guard = 0; guard < 60 && cur; guard++) {
          push(cur, false);
          if (cur[cur.length - 1] === end[end.length - 1] || cur.length !== end.length) break;
          const next = nextDesignator(cur[cur.length - 1], roman);
          cur = next && cur.slice(0, -1).concat(next);
        }
        pos += range[0].length + endTok[0].length;
        prev = end;
      } else {
        push(comps, intro);
        prev = comps;
      }
      const sep = /^(?:\s*introductory text)?(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+)(?:paragraphs?\s+)?/i.exec(text.slice(pos));
      if (!sep) break;
      pos += sep[0].length;
    }
    kw.lastIndex = pos;
  }
  return out;
}

// Is `path` inside `parent`? Works for "(a)(1)" under "(a)" and "VIII.B.6.a" under "VIII.B.6".
function isUnderPath(parent, path) {
  if (!parent) return Boolean(path);
  if (path.length <= parent.length || !path.startsWith(parent)) return false;
  return /^[.(]/.test(path.slice(parent.length)) || /[”)]$/.test(parent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Redline rows against the eCFR
// ─────────────────────────────────────────────────────────────────────────────
//
//   draft  [{ type: 'omit' | 'header' | 'para', path, label, text, elidedLead, hasElision }]
//   ref    [{ type: 'header' | 'para', path, label, text }]   the eCFR, in order
//
// Units whose text holds several paragraphs (undesignated paragraphs, or
// definitions) are compared paragraph by paragraph: each draft paragraph is
// paired with the eCFR paragraph of the same path it best matches. Rows follow
// the draft; removed paragraphs and in-place edits are slotted in by their
// eCFR position, so the redline reads in the regulation's own order.
// gapOmits: mark skipped eCFR text with "* * *" (sections, whose reprinted
// text is parsed without its elision lines).
// Returns { rows, notes }.

const MATCH_MIN_SIMILARITY = 0.4;
const REWRITE_KEEP = 0.4;   // below this share of old text kept, strike the whole

// A paragraph rewritten outright reads better struck whole and replaced than
// as a word diff that threads the few shared words ("Tier", "the") through it.
function paragraphRedline(oldText, newText) {
  if (substantiveKey(oldText) === substantiveKey(newText)) return { oldHtml: esc(oldText), newHtml: esc(newText) };
  const d = computeDiff(oldText, newText);
  const kept = d.oldHtml.replace(/<span class="diff-del">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');
  if (kept.trim().length >= REWRITE_KEEP * Math.max(oldText.length, newText.length)) return d;
  return {
    oldHtml: `<span class="diff-del">${esc(oldText)}</span>`,
    newHtml: `<span class="diff-add">${esc(newText)}</span>`,
  };
}

function definitionKey(text) {
  const t = definitionTerm(text);
  return t ? termKey(t) : null;
}

// The FR may set out "(1) … (2) …" as paragraphs of their own where the eCFR
// runs them into the paragraph that introduces them ("Criterion 17—… assure
// that (1) specified … and (2) the core …"). Where the eCFR has nothing under
// a path, the draft's sub-paragraphs are run back in, and paragraphs that
// follow the last of them become the parent's own follow-on paragraphs.
function inlineSubparagraphs(draft, ref) {
  const refPaths = new Set(ref.filter(u => u.type === 'para').map(u => u.path));
  const out = [];
  for (const u of draft) {
    const parent = u.type === 'para' && [...out].reverse().find(p => p.type === 'para' && isUnderPath(p.path, u.path));
    if (parent && refPaths.has(parent.path) && ![...refPaths].some(p => isUnderPath(parent.path, p))) {
      const [first, ...more] = u.text.split('\n');
      const lines = parent.text.split('\n');
      if (parent.inlined) lines[lines.length - 1] += ` ${u.path.slice(parent.path.length)} ${first}`;
      else lines[lines.length - 1] = `${lines[lines.length - 1].replace(/:$/, '')} ${u.path.slice(parent.path.length)} ${first}`;
      parent.text = [...lines, ...more].join('\n');
      parent.inlined = !more.length;
      continue;
    }
    out.push(u.type === 'para' ? { ...u } : u);
  }
  return out;
}

function buildReferenceRows(draft, ref, edits, { gapOmits = false, appendix = false } = {}) {
  edits = edits || { revised: [], removals: [], subs: [], whole: null };
  const notes = [];
  if (appendix) draft = inlineSubparagraphs(draft, ref);

  // ── paragraphs ──
  const R = [];
  for (const u of ref) {
    if (u.type === 'header') { R.push({ header: true, path: u.path, text: u.text, idx: R.length }); continue; }
    u.text.split('\n').filter(t => t.trim()).forEach((text, pi) =>
      R.push({ path: u.path, label: u.label ?? u.path, text, pi, idx: R.length }));
  }
  const D = [];
  draft.forEach((u, ui) => {
    if (u.type === 'omit') { D.push({ omit: true }); return; }
    if (u.type === 'header') { D.push({ header: true, path: u.path, text: u.text }); return; }
    u.text.split('\n').filter(t => t.trim()).forEach((text, pi) =>
      D.push({ path: u.path, label: u.label ?? u.path, text, pi, unit: ui, elidedLead: pi === 0 && u.elidedLead }));
  });
  const elidedAfter = new Set();   // draft paths whose sub-paragraphs the draft keeps by "* * *"
  draft.forEach((u, ui) => {
    if (u.type !== 'para') return;
    if (u.hasElision || (draft[ui + 1] && draft[ui + 1].type === 'omit')) elidedAfter.add(u.path);
  });
  const draftHasElision = draft.some(u => u.type === 'omit' || u.hasElision);

  // ── pair draft paragraphs with eCFR paragraphs ──
  const byPath = new Map();
  for (const r of R) {
    if (r.header) continue;
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  const draftCount = new Map();
  for (const d of D) if (!d.omit && !d.header) draftCount.set(d.path, (draftCount.get(d.path) || 0) + 1);
  const draftPaths = new Set(draftCount.keys());

  for (const d of D) {
    if (d.omit) continue;
    if (d.header) {
      // The heading with the same words — the last of them, since a table of
      // contents repeats the headings first — else the first of that number.
      const same = R.filter(r => r.header && r.path === d.path && !r.matched);
      d.r = (d.text && same.filter(r => substantiveKey(r.text) === substantiveKey(d.text)).pop()) || same[0];
      if (d.r) d.r.matched = true;
      continue;
    }
    let cands = (byPath.get(d.path) || []).filter(r => !r.matched);
    let implied = false;
    // The FR sometimes drops a lone first designator ("A." where the eCFR has
    // "A.1."); its text then matches the path's unclaimed first child.
    if (!cands.length && appendix && d.pi === 0) {
      for (const child of [`${d.path}.1`, `${d.path}(1)`]) {
        const c = (byPath.get(child) || []).filter(r => !r.matched);
        if (c.length && !draftPaths.has(child)) { cands = c; implied = true; break; }
      }
    }
    if (!cands.length) continue;
    let pick = null;
    const total = (byPath.get(cands[0].path) || []).length;
    if (total === 1 && (draftCount.get(d.path) || 0) === 1) pick = cands[0];
    else {
      const dk = definitionKey(d.text);
      let best = -1;
      for (const c of cands) {
        const s = dk && dk === definitionKey(c.text) ? 2 : similarity(d.text, c.text);
        if (s > best) { best = s; pick = c; }
      }
      if (best < MATCH_MIN_SIMILARITY) {
        pick = total === draftCount.get(d.path) ? cands.find(c => c.pi === d.pi) || null : null;
      }
    }
    if (pick) { d.r = pick; pick.matched = true; d.implied = implied; }
  }

  // ── removed text, and in-place edits ──
  const pending = [];   // { idx, row, kind: 'del' | 'sub' }
  const struck = new Set();
  const strike = (r, reserve) => {
    if (r.header || r.matched || struck.has(r)) return;
    struck.add(r);
    pending.push({ idx: r.idx, kind: 'del', reserve, row: { type: 'diff', label: r.label,
      oldHtml: `<span class="diff-del">${esc(r.text)}</span>`,
      newHtml: reserve ? `<span class="diff-add">[Reserved]</span>` : '' } });
  };

  const paras = R.filter(r => !r.header);
  if (edits.whole && edits.whole.op === 'remove') paras.forEach((r, i) => strike(r, edits.whole.reserve && i === 0));
  if (edits.whole && edits.whole.op === 'revise' && !draftHasElision) paras.forEach(r => strike(r, false));
  for (const rev of edits.revised) {
    for (const r of paras) {
      if (r.path === rev.path && !rev.intro && draftPaths.has(r.path) && !elidedAfter.has(r.path)) strike(r, false);
      else if (isUnderPath(rev.path, r.path) && !rev.intro && !elidedAfter.has(rev.path)
               && !draft.some(u => u.type === 'para' && u.path !== rev.path && isUnderPath(u.path, r.path) && elidedAfter.has(u.path))) strike(r, false);
    }
  }
  const unfound = [];
  for (const rm of edits.removals) {
    const key = rm.term ? termKey(rm.term) : null;
    const hit = paras.filter(r => (rm.path && (r.path === rm.path || isUnderPath(rm.path, r.path)))
      || (key && definitionKey(r.text) === key));
    if (!hit.length) unfound.push(rm.term ? `the definition “${rm.term}”` : rm.path);
    // "[Reserved]" is shown once — unless the draft prints it ("II. [Reserved]").
    const printed = draft.some(u => u.type !== 'omit' && u.path === rm.path);
    hit.forEach((r, i) => strike(r, rm.reserve && i === 0 && !printed));
  }
  if (unfound.length) {
    notes.push(`Not in the current text, so not shown as removed (it may already be reserved): ${unfound.join(', ')}.`);
  }

  // Several edits may land in one paragraph ("shall" → "must", then "NRC" →
  // "NRC Headquarters"); each works on the text the ones before it left.
  const changed = new Map();   // ref paragraph → amended text
  const textOf = r => changed.get(r) ?? r.text;
  for (const sub of edits.subs) {
    let cands = sub.paths.length
      ? paras.filter(r => sub.paths.includes(r.path))
      : paras;
    if (sub.heading) {
      // Every heading of that name (a table of contents repeats them): the text under each.
      const ranges = R.filter(r => r.header && substantiveKey(r.text) === substantiveKey(sub.heading)).map(h => {
        const next = R.find(r => r.header && r.idx > h.idx);
        return [h.idx, next ? next.idx : Infinity];
      });
      if (ranges.length) cands = cands.filter(r => ranges.some(([a, b]) => r.idx > a && r.idx < b));
    }
    cands = cands.filter(r => !r.matched);   // reprinted text outranks an edit
    for (const op of sub.ops) {
      if (op.remove) {
        const re = new RegExp(escapeRegex(op.remove), 'i');
        let hits = cands.filter(r => re.test(textOf(r)));
        if (!hits.length) { notes.push(`Could not find “${op.remove}”${sub.paths.length ? ` in ${sub.paths.join(', ')}` : ''}.`); continue; }
        // Once in each paragraph named, or once in all — unless "wherever it appears".
        if (!sub.wherever) {
          const groups = sub.paths.length > 1 ? sub.paths.map(p => hits.filter(r => r.path === p)).filter(g => g.length) : [hits];
          hits = groups.map(g => (sub.last ? g[g.length - 1] : g[0]));
        }
        for (const r of hits) changed.set(r, applySubstitutions(textOf(r), [op], sub.wherever));
      } else if (cands.length) {
        // A whole sentence, or an addition: the named paragraph, else the last.
        const r = op.sentence === 'first' ? cands[0] : cands[cands.length - 1];
        if (!op.sentence && !sub.paths.length) { notes.push(`Could not tell where to add “${op.add}”.`); continue; }
        changed.set(r, applySubstitutions(textOf(r), [op], false));
      }
    }
  }
  for (const [r, text] of changed) {
    if (text === r.text) continue;
    r.matched = true;
    pending.push({ idx: r.idx, kind: 'sub', row: { type: 'diff', label: r.label, ...computeDiff(r.text, text) } });
  }
  pending.sort((a, b) => a.idx - b.idx);

  // ── rows, in draft order ──
  const rows = [];
  let lastIdx = null;
  let lastPath = null;   // a run of paragraphs of one path is labelled once
  const emitted = new Set();
  const gap = k => {
    if (!gapOmits) return;
    const from = lastIdx === null ? 0 : lastIdx + 1;
    if (k > from && R.slice(from, k).some(r => !r.header && !emitted.has(r.idx))) rows.push({ type: 'omit' });
  };
  const emitRef = (idx, row, path) => {
    gap(idx);
    emitted.add(idx);
    lastIdx = lastIdx === null ? idx : Math.max(lastIdx, idx);
    rows.push({ ...row, label: path === lastPath ? '' : (row.label || '') });
    lastPath = path;
  };
  const flush = k => {
    while (pending.length && pending[0].idx < k) {
      const p = pending.shift();
      emitRef(p.idx, p.row, R[p.idx].path);
    }
  };
  const nextIdx = i => { for (let j = i + 1; j < D.length; j++) if (D[j].r) return D[j].r.idx; return Infinity; };

  D.forEach((d, i) => {
    if (d.omit) {
      // Removed paragraphs belong to the text above the stars; in-place edits
      // further on sit in the unchanged stretch the stars stand for.
      const k = nextIdx(i);
      while (pending.length && pending[0].idx < k && pending[0].kind === 'del') {
        const p = pending.shift();
        emitRef(p.idx, p.row, R[p.idx].path);
      }
      rows.push({ type: 'omit' });
      const before = rows.length;
      flush(k);
      if (rows.length > before) rows.push({ type: 'omit' });
      lastPath = null;
      return;
    }
    if (d.r) flush(d.r.idx);
    if (d.header) {
      const text = d.text ?? (d.r && d.r.text) ?? d.path;
      const row = !d.r || substantiveKey(d.r.text) === substantiveKey(text)
        ? { type: 'header', text: d.r && d.text === null ? d.r.text : text }
        : { type: 'diff', label: '', ...paragraphRedline(d.r.text, text) };
      if (d.r) { emitted.add(d.r.idx); lastIdx = lastIdx === null ? d.r.idx : Math.max(lastIdx, d.r.idx); }
      rows.push(row);
      lastPath = null;
      return;
    }
    if (!d.r) {
      // Text it replaces is struck first.
      const k = nextIdx(i);
      while (pending.length && pending[0].idx < k && pending[0].kind === 'del') {
        const p = pending.shift();
        emitRef(p.idx, p.row, R[p.idx].path);
      }
      rows.push({ type: 'diff', label: d.path === lastPath ? '' : d.label, oldHtml: '',
        newHtml: `<span class="diff-add">${esc((d.elidedLead ? '* * * ' : '') + d.text)}</span>` });
      lastPath = d.path;
      return;
    }
    emitRef(d.r.idx, {
      type: 'diff', label: d.implied ? `${d.r.label} (unnumbered in the draft)` : d.label,
      ...paragraphRedline(d.r.text, d.elidedLead ? `${d.r.text} ${d.text}` : d.text),
    }, d.implied ? d.r.path : d.path);
  });
  flush(Infinity);
  if (gapOmits && rows.length && R.slice(lastIdx === null ? 0 : lastIdx + 1).some(r => !r.header && !emitted.has(r.idx))) rows.push({ type: 'omit' });
  return { rows, notes };
}
