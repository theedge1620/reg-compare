// RuleCheck — Amendment document parser shared by Document/Folder Comparison (ported in folder_compare.py).

// ─────────────────────────────────────────────────────────────────────────────
// Amendment document structure
// ─────────────────────────────────────────────────────────────────────────────
//
// These documents are amendment instruments, not flat prose. Three kinds of
// line carry structure:
//
//   46. In § 50.55a, revise paragraph (b)(2)…   ← numbered INSTRUCTION.
//                                                 Not regulation text. Always
//                                                 names the section it affects.
//   § 50.55a  Codes and standards.              ← SECTION heading.
//   (b)(2) The licensee shall…                  ← SUBSECTION, the unit we compare.
//   * * *                                       ← ELISION: nothing changes until
//                                                 the next listed subsection.
//
// Comparable units are keyed by section + subsection path, so a subsection is
// only ever compared against the same subsection of the same section.

// Numbered instruction. Working drafts circulate before the amendments are
// numbered, using an "XX." placeholder, so those count as instructions too.
const INSTRUCTION_RE  = /^(\d{1,3}|X{1,3}|x{2,3})\.\s+(.+)$/;
// A numbered line is an instruction only if it reads like one; otherwise it is
// a numbered regulation paragraph ("3. The Commission may not require …").
const INSTRUCTION_LEAD_RE = /^(?:In\s+(?:§|part\b|[Aa]ppendix\b|[Ss]ubpart\b|[Ss]ection\b|[Tt]able\b|paragraphs?\b|the\s+(?:definition|table|heading|introductory|undesignated|entry|list|authority|section))|§|(?:Revise|Add|Amend|Remove|Redesignate|Republish|Reserve|Designate|Transfer|Suspend|Correct|Effective)\b|The authority citation)/;
const INSTRUCTION_PASSIVE_RE = /\b(?:is|are)\s+(?:hereby\s+)?(?:amended|revised|added|removed|redesignated|republished|reserved|corrected|transferred|suspended)\b|\bto read as follows\b|\bcontinues to read\b/i;
// Unnumbered instructions — Word list numbering isn't stored as text — must be
// unmistakable: an instruction opening, amendatory wording, and a § reference.
const UNNUMBERED_LEAD_RE = /^(?:In\s+§|Revise\b|Add\b|Amend\b|Remove\b|Redesignate\b|Republish\b|The authority citation for part\b)/;
const AMENDATORY_RE = /:\s*$|\bto read as follows\b|\bin its place\b|\bremove and reserve\b|\bcontinues to read\b|\b(?:is|are)\s+(?:amended|revised|added|removed|redesignated|republished|reserved)\b|\bremove the (?:words?|phrases?|references?|definitions?|sentences?|entry|entries)\b|\bredesignat/i;
// Lettered clauses inside one instruction: "In § 110.45: a. In paragraph …; and b. …"
const CLAUSE_MARK_RE = /([:;.])\s+(?:and\s+)?([a-z])\.\s+/g;
// A clause that reprints regulation text rather than editing it in place.
const PRINTS_TEXT_RE = /^(?:Revise|Add|Republish)\b|\bto read as follows\b/i;
const SUBINSTR_RE     = /^([a-z])\.\s+(.+)$/;               // "a. Revise paragraph (b)…"
const SECTION_HEAD_RE = /^§{1,2}\s*(\d+[A-Za-z]?(?:\.\d+[A-Za-z]*)*)\s*[.:—–-]?\s*(.*)$/;
const DOTTED_HEAD_RE  = /^(\d+(?:\.\d+)+[A-Za-z]?)\.?\s+(.+)$/;
// "* * *" (or longer) alone on a line — the Federal Register elision marker.
const ELISION_RE      = /^\*(?:\s*\*){2,}\s*$/;
// Section references inside instruction text: "§ 50.55a", "§§ 50.55a", "Section 50.55a"
const SECTION_REF_RE  = /(?:§{1,2}|\bSections?\b|\bSecs?\.)\s*(\d+[A-Za-z]?(?:\.\d+[A-Za-z]*)*)/gi;

// A bare number opening a line ("2.326 Motions to reopen.") is a section
// heading only when something vouches for it; otherwise it is a quantity that
// happens to start the line ("0.001 rem in any one hour", "1.5 times the
// limit"). It counts when either:
//   • the governing instruction names that section — this covers sections that
//     are new in the rule and so not yet in the eCFR; or
//   • it is a Title 10 section in the eCFR AND the text after it matches that
//     section's eCFR heading. The number alone is not enough: "1.5" is a real
//     section (10 CFR 1.5).
// "§"-marked headings are explicit and are not checked.
const BARE_HEADING_MIN_SIMILARITY = 0.5;

function isBareSectionHeading(number, heading, instr, title10) {
  if (instr && instr.refs.includes(number)) return true;
  if (!title10 || !title10.has(number)) return false;
  return similarity(heading, title10.get(number)) >= BARE_HEADING_MIN_SIMILARITY;
}

// { num, body } when the line is an amendment instruction, else null. `body` is
// the instruction without its number; unnumbered instructions have num ''.
function readInstruction(line) {
  const m = line.match(INSTRUCTION_RE);
  if (m && !DOTTED_HEAD_RE.test(line)) {
    return INSTRUCTION_LEAD_RE.test(m[2]) || INSTRUCTION_PASSIVE_RE.test(m[2]) ? { num: m[1], body: m[2] } : null;
  }
  if (UNNUMBERED_LEAD_RE.test(line) && AMENDATORY_RE.test(line)
      && (instructionSectionRefs(line).length || /^The authority citation for part\b/.test(line))) {
    return { num: '', body: line };
  }
  return null;
}

// Split "In § 110.45: a. In paragraph (b)(3), remove …; and b. In paragraph
// (b)(4), remove …" into its lead ("In § 110.45:") and lettered clauses, so each
// clause can be compared with the matching clause of another document.
function splitInstructionClauses(body) {
  const marks = [];
  let expect = 'a';
  for (const m of body.matchAll(CLAUSE_MARK_RE)) {
    if (m[2] !== expect) continue;
    marks.push(m);
    expect = String.fromCharCode(expect.charCodeAt(0) + 1);
  }
  if (!marks.length) return { lead: body, clauses: [] };
  return {
    lead: body.slice(0, marks[0].index + 1).trim(),
    clauses: marks.map((m, i) => body.slice(m.index + m[0].length,
      i + 1 < marks.length ? marks[i + 1].index : body.length).trim()),
  };
}

// Quoted phrases in an instruction are text being removed or inserted
// ('remove the references “§ 50.83 or”'), not what the instruction amends.
const QUOTED_RE = /[“"][^“”"]*[”"]|``[^`]*?''/g;

function unquoted(text) {
  return text.replace(QUOTED_RE, ' ');
}

// Pull every section number an instruction claims to affect.
function instructionSectionRefs(text) {
  const refs = [];
  text = unquoted(text);
  SECTION_REF_RE.lastIndex = 0;
  let m;
  while ((m = SECTION_REF_RE.exec(text)) !== null) {
    const number = m[1].replace(/\.+$/, '');
    if (!refs.includes(number)) refs.push(number);
  }
  return refs;
}

// ── subsection designators ───────────────────────────────────────────────────
//
// The Federal Register nests paragraphs by designator *type*:
//   (a) letter → (1) digit → (i) roman → (A) upper → (1) italic → (i) italic
// Plain text loses the italics, so depth is inferred from the token's shape.
// The only real ambiguity is a single "i"/"v"/"x", which could be a first-level
// letter or a third-level roman numeral. The hierarchy itself resolves it: a
// letter's children are digits, a roman numeral's children are capitals — so
// the *next* designator in the document usually settles the question.

const ROMAN_RE = /^[ivxlcdm]+$/;
const ROMAN_SUCCESSOR = { i: 'ii', v: 'vi', x: 'xi' };
const ROMAN_PREDECESSOR = { v: 'iv', x: 'ix' };

function designatorLevel(token, stack, nextToken) {
  if (/^\d+$/.test(token)) return 2;                    // (1)
  if (/^[A-Z]+$/.test(token)) return 4;                 // (A)
  if (/^[a-z]$/.test(token)) {
    if (!'ivx'.includes(token)) return 1;               // unambiguous letter

    // ── ambiguous: (i) / (v) / (x) ──
    // "(iv)" then "(v)": the roman run continues, even when "(2)" follows —
    // unless a "(u)" letter run makes it just as likely a letter.
    const romanPrev = ROMAN_PREDECESSOR[token];
    if (romanPrev && stack[2] === `(${romanPrev})`
        && stack[0] !== `(${String.fromCharCode(token.charCodeAt(0) - 1)})`) return 3;
    if (nextToken) {
      // "(i)" then "(1)": digits are level 2, so (i) must be the level-1 parent.
      if (/^\d+$/.test(nextToken)) return 1;
      // "(i)" then "(A)": capitals are level 4, so (i) is the level-3 parent.
      if (/^[A-Z]+$/.test(nextToken)) return 3;
      // "(i)" then "(ii)": a roman run.
      if (nextToken === ROMAN_SUCCESSOR[token]) return 3;
      // "(i)" then "(j)": a letter run.
      if (nextToken === String.fromCharCode(token.charCodeAt(0) + 1)) return 1;
    }

    // Fall back to sequence: does it continue the level-1 letter run (…(h),(i))?
    const prev = stack[0];
    if (prev && /^\([a-z]\)$/.test(prev)) {
      const expected = String.fromCharCode(prev.charCodeAt(1) + 1);
      if (token === expected) return 1;
    }
    return stack[1] ? 3 : 1;
  }
  if (ROMAN_RE.test(token)) return 3;                   // (ii), (iv)
  if (/^[a-z]{2,}$/.test(token)) return 1;              // (aa), (bb) after (z)
  return 1;
}

// Read all leading "(x)" groups off a line.
// Returns { tokens, rest } or null when the line has no designator.
function leadingDesignators(line) {
  const tokens = [];
  let pos = 0;
  while (pos < line.length && line[pos] === '(') {
    const close = line.indexOf(')', pos);
    if (close === -1) break;
    const token = line.slice(pos + 1, close);
    if (!/^[A-Za-z0-9]{1,4}$/.test(token)) break;
    tokens.push(token);
    pos = close + 1;
  }
  if (!tokens.length) return null;
  return { tokens, rest: line.slice(pos).trim() };
}

// Resolve a designator line to a full path, maintaining the nesting stack.
function resolvePath(tokens, stack, nextToken) {
  // A compound designator like "(5)(i)" states its own depth but not its
  // parents: it hangs off whatever level its first token belongs to, so
  // "(5)(i)" under "(c)(2)(ii)" is "(c)(5)(i)", not a new root.
  const level = designatorLevel(tokens[0], stack, tokens[1] || nextToken);
  stack.length = Math.max(0, level - 1);
  tokens.forEach((t, i) => { stack[level - 1 + i] = `(${t})`; });
  stack.length = level - 1 + tokens.length;
  return stack.join('');
}

// Paragraph targets named inside an instruction:
//   "revise paragraph (c)(2)"                → ["(c)(2)"]
//   "revise paragraphs (a)(1) and (b)(2)"    → ["(a)(1)", "(b)(2)"]
//   "revise paragraph (c)(2) and remove paragraph (c)(3)" → ["(c)(2)", "(c)(3)"]
function instructionParaTargets(text) {
  const targets = [];
  text = unquoted(text);
  const kw = /\bparagraphs?\b/gi;
  let m;
  while ((m = kw.exec(text)) !== null) {
    let pos = m.index + m[0].length;
    // Consume runs of "(x)" groups, allowing ", " / " and " / " or " between them.
    for (;;) {
      const sep = /^(?:\s*(?:,|and|or)?\s*)/i.exec(text.slice(pos));
      const start = pos + (sep ? sep[0].length : 0);
      const des = leadingDesignators(text.slice(start));
      if (!des) break;
      const path = des.tokens.map(t => `(${t})`).join('');
      if (!targets.includes(path)) targets.push(path);
      pos = start + path.length;
    }
  }
  return targets;
}

// ── non-regulation text ─────────────────────────────────────────────────────
//
// Amendment documents carry structural and editorial lines that are not
// regulation text. Left alone, each is appended to whatever paragraph precedes
// it ("PART 11—…" onto the last paragraph of part 10, a footnote onto the
// paragraph above it) and makes that paragraph differ between documents.

const PART_HEAD_RE     = /^PART\s+\d+[A-Za-z]?\s*[—–-]/;                    // "PART 11—CRITERIA AND …"
const SUBPART_HEAD_RE  = /^Subpart\s+[A-Z]{1,3}(?:\s*[—–-]|\s+[A-Z][a-z])/;  // "Subpart B—Eligibility"
const APPENDIX_HEAD_RE = /^Appendix\s+[A-Z0-9]{1,3}\s+to\s+Part\s+\d+\s*[—–-]/i;
const EDITORIAL_RE     = /^(?:Authority:|Source:|Editorial Note:|Secs?\.$|_{3,}$)/; // citations, TOC "Sec.", footnote rule
const FOOTNOTE_TEXT_RE = /^\[(\d{1,3})\]\s/;                                 // "[1] The thirty-day …"
const BARE_FOOTNOTE_RE = /^(\d{1,2})\s+\S/;                                  // "1 In a highly expedited …"
// Inline footnote markers: digits glued to the end of a word or its punctuation
// ("criteria.1 Replies", "reactors1 "), or bracketed ("[1]").
const FOOTNOTE_MARK_RE = /([A-Za-z)\]”"’]|[A-Za-z][.,;:])(\d{1,2})(?=\s|$)/g;
const BRACKET_MARK_RE  = /\[(\d{1,3})\]/g;
// Regulation text follows the words of issuance and ends at the signature.
const ISSUANCE_RE      = /^For the reasons set (?:out|forth) in the preamble/i;
const SIGNATURE_RE     = /^(?:Dated\b|\[FR Doc\.)/;

// [begin, end) of the paragraphs holding regulation text. Without words of
// issuance the whole document is treated as amendatory text.
function regulationSpan(paras) {
  const issuance = paras.findIndex(p => ISSUANCE_RE.test(p.trim()));
  const begin = issuance === -1 ? 0 : issuance + 1;
  for (let i = begin; i < paras.length; i++) {
    if (SIGNATURE_RE.test(paras[i].trim())) return [begin, i];
  }
  return [begin, paras.length];
}

// ── definitions ─────────────────────────────────────────────────────────────
//
// Definitions sections ("§ 2.4 Definitions.") are not paragraph-lettered: each
// definition is its own paragraph, "Term means …", sometimes with numbered
// sub-paragraphs. Each definition becomes its own unit keyed by its term, so a
// definition is only ever compared with the same term's definition.

// "Term means …" — the term may contain abbreviation periods ("U.S. Government").
const DEFINITION_RE = /^(?:(?:For (?:the )?purposes of|As used in) this (?:part|section|subpart|chapter)[,:—–-]?\s+)?(?:The terms?\s+)?[“"]?([A-Z0-9](?:[^“”".;:]|\.(?=\S)){0,100}?)[”"]?,?\s+(?:means|mean|has the (?:same )?meaning|is defined as|refers to|includes)\b/;
// "Term. (1) When applied to …", or "Term." alone with its paragraphs below —
// the CFR's other style, used e.g. in § 21.3.
const DEFINITION_PERIOD_RE = /^([A-Z][^“”".;:]{0,80}?)\.(?:\s+(?=[(A-Z])|$)/;
// "Biological marker, as used in subparts M and P of this part, means …"
const TERM_QUALIFIER_RE = /,\s*(?:as used in|for (?:the )?purposes of)\b.*$/i;
const NOT_A_TERM_RE = /\b(?:shall|must|may|will|should|would|can|could)\b/i;
const DEF_TERMS_RE  = /\bdefinitions?\s+(?:of|for)\s+(?:the\s+terms?\s+)?/gi;
// An unquoted term (italics are lost in plain text): "the definition for Sealed
// Source and Device Registry to read as follows", "the definition for Adjudication,".
const DEF_TERM_BARE_RE = /^([A-Za-z][^,.;:“”"]{0,80}?)(?=\s+(?:to read|in alphabetical order|is|are|and add|and remove|remove|from)\b|[,.;:]|$)/;

function definitionTerm(line) {
  let m = line.match(DEFINITION_RE);
  let maxWords = 12;
  if (!m) { m = line.match(DEFINITION_PERIOD_RE); maxWords = 8; }
  if (!m) return null;
  const term = m[1].replace(TERM_QUALIFIER_RE, '').trim();
  if (!term || term.split(/\s+/).length > maxWords || NOT_A_TERM_RE.test(term)) return null;
  return term;
}

// Terms match regardless of case or quote style ("Focused Proceeding" is
// "Focused proceeding").
function termKey(term) {
  return normForCompare(term.replace(/[,.;:\s]+$/, ''));
}

// Terms an instruction names: 'revise the definition for “Facility”', 'add the
// definitions for “Expedited Proceeding,” and “Focused Proceeding,”'.
function instructionDefinitionTerms(text) {
  const terms = [];
  DEF_TERMS_RE.lastIndex = 0;
  let m;
  while ((m = DEF_TERMS_RE.exec(text)) !== null) {
    let pos = m.index + m[0].length;
    let quoted = 0;
    for (;;) {
      const q = /^(?:\s*(?:,|;|and)\s*)*\s*[“"]([^”"]+)[”"]/i.exec(text.slice(pos));
      if (!q) break;
      const term = q[1].replace(/[,.;:\s]+$/, '').trim();
      if (term && !terms.includes(term)) terms.push(term);
      pos += q[0].length;
      quoted++;
    }
    if (!quoted) {
      const b = DEF_TERM_BARE_RE.exec(text.slice(pos));
      const term = b ? b[1].trim() : '';
      if (term && term.split(/\s+/).length <= 8 && !terms.includes(term)) terms.push(term);
    }
  }
  return terms;
}

// ── comparison key ──────────────────────────────────────────────────────────
//
// Ignores formatting: case, spacing, punctuation, quote and dash styles,
// hyphenation ("non-power" ≡ "nonpower") and footnote markers. Two texts with
// the same key differ only in formatting, so neither is a change of the other.
function substantiveKey(s) {
  return s
    .replace(BRACKET_MARK_RE, ' ')
    .replace(FOOTNOTE_MARK_RE, '$1')
    .replace(/(?<=[\p{L}\p{N}])[-‐‑](?=[\p{L}\p{N}])/gu, '')
    .replace(/[^\p{L}\p{N}§]+/gu, ' ')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse a document into comparable units + its instructions
// ─────────────────────────────────────────────────────────────────────────────
//
// Document order matters, and it tells us which of two forms an amendment takes:
//
//   Instruction-only — the instruction precedes the section it names and no
//   heading or amendatory text follows. The instruction sentence *is* the whole
//   amendment, so it becomes the comparable unit (kind: 'instruction'), keyed by
//   the section and paragraph its own text names.
//
//   Detailed amendatory language — the instruction is followed by the section
//   heading, and the replacement text comes after that heading. The regulation
//   text is the comparable unit (kind: 'text'); the instruction is context only.
//
// `title10` is the eCFR section list (Map identifier → heading) used to vet
// headings that lack a "§" and to recognise definitions sections; null when
// unavailable.
//
// Returns { units, instructions }
//   units        Map "section|path" → { section, sectionTitle, path, pathLabel,
//                                       text, kind, hasElision, instrNums[] }
//                path is the matching key; pathLabel is how it reads, e.g.
//                path “focused proceeding”, pathLabel “Focused Proceeding”
//   instructions [{ num, text, refs[], producedUnits }]

function parseAmendmentDoc(paras, title10 = null) {
  const units = new Map();
  const instructions = [];
  const [begin, end] = regulationSpan(paras);

  let curInstr = null;
  let section = null;        // { number, title, defs }
  let stack = [];            // active designator nesting
  let unit = null;
  let def = null;            // open definition: { base, path, label }
  const marks = new Set();   // footnote numbers referenced in the current section

  function setSection(number, title) {
    const known = title || (title10 && title10.get(number)) || '';
    section = { number, title, defs: /definition/i.test(known) };
    stack = [];
    def = null;
    marks.clear();
  }

  function noteMarks(text) {
    for (const m of text.matchAll(FOOTNOTE_MARK_RE)) marks.add(m[2]);
    for (const m of text.matchAll(BRACKET_MARK_RE)) marks.add(m[1]);
  }

  function isFootnoteText(line) {
    if (FOOTNOTE_TEXT_RE.test(line)) return true;
    const m = line.match(BARE_FOOTNOTE_RE);
    return Boolean(m && marks.has(m[1]));
  }

  // A "Subpart X—Title" line is a structural heading only when a section
  // heading (or a table of contents) follows; otherwise it is regulation text,
  // e.g. an item in a list of subparts.
  function startsSectionBlock(i) {
    for (let j = i + 1; j < end; j++) {
      const l = paras[j].trim();
      if (!l) continue;
      return SECTION_HEAD_RE.test(l) || /^Secs?\.$/.test(l) || PART_HEAD_RE.test(l) || APPENDIX_HEAD_RE.test(l);
    }
    return false;
  }

  function store(u) {
    // A unit we cannot place in a section can't be scoped to one, and matching
    // it across documents by path alone would compare unrelated paragraphs.
    if (!u.section) return false;
    const key = `${u.section}|${u.path}`;
    const prev = units.get(key);
    // Detailed text always outranks a bare instruction for the same key, and
    // among equals the fullest occurrence wins (a TOC line loses to the real one).
    if (prev && !(u.kind === 'text' && prev.kind === 'instruction')
             && !(u.kind === prev.kind && u.text.length > prev.text.length)) return false;
    units.set(key, u);
    return true;
  }

  function flush() {
    if (!unit) return;
    const text = unit.lines.join('\n').trim();
    // A designator carrying only "* * *" is a path marker, not content.
    if (text && store({ ...unit, text }) && curInstr) curInstr.producedUnits = true;
    unit = null;
  }

  function openUnit(path, pathLabel = path) {
    flush();
    const number = section ? section.number : '';
    unit = {
      section: number,
      sectionTitle: section ? section.title : '',
      path,
      pathLabel,
      kind: 'text',
      lines: [],
      hasElision: false,
      // Only credit the instruction that actually names this section.
      instrNums: (curInstr && (!curInstr.refs.length || curInstr.refs.includes(number)))
        ? [curInstr.num] : [],
    };
  }

  // An instruction that produced no regulation text is itself the amendment.
  // One that did reprint text may still carry in-place edits for paragraphs it
  // doesn't reprint ("b. In paragraph (e)(1), remove …"); those count too.
  // Compared text omits the instruction number, which differs between rules.
  function closeInstruction() {
    flush();
    if (!curInstr) return;
    const { lead, clauses } = splitInstructionClauses(curInstr.body);
    const pieces = clauses.length
      ? clauses.filter(cl => !curInstr.producedUnits || !PRINTS_TEXT_RE.test(cl))
               .map(cl => ({ text: `${lead} ${cl}`.trim(), scope: cl }))
      : (curInstr.producedUnits ? [] : [{ text: curInstr.body, scope: curInstr.body }]);

    for (const piece of pieces) {
      const targets = instructionParaTargets(piece.scope);
      const subPaths = targets.length ? targets : [''];
      // "add paragraph (1)(iii) in the definition for “Construction”" targets a
      // paragraph *within* that definition.
      const terms = instructionDefinitionTerms(piece.scope);
      const paths = terms.length
        ? terms.flatMap(t => subPaths.map(p => ({ path: `“${termKey(t)}”${p}`, label: `“${t}”${p}` })))
        : subPaths.map(p => ({ path: p, label: p }));
      for (const ref of curInstr.refs) {
        for (const { path, label } of paths) {
          store({
            section: ref,
            sectionTitle: '',
            path,
            pathLabel: label,
            kind: 'instruction',
            text: piece.text,
            hasElision: false,
            instrNums: [curInstr.num],
          });
        }
      }
    }
  }

  // First designator token appearing after position i, used to disambiguate
  // (i)/(v)/(x). Stops at a section heading or instruction, which reset nesting.
  function peekNextDesignator(i) {
    for (let j = i + 1; j < end; j++) {
      const l = paras[j].trim();
      if (!l || ELISION_RE.test(l)) continue;
      if (INSTRUCTION_RE.test(l) || SECTION_HEAD_RE.test(l)) return null;
      const d = leadingDesignators(l);
      if (d) return d.tokens[0];
      return null;   // ordinary prose — the run of designators has ended
    }
    return null;
  }

  for (let idx = begin; idx < end; idx++) {
    const raw = paras[idx];
    const line = raw.trim();
    if (!line) continue;

    // ── elision marker ──
    if (ELISION_RE.test(line)) {
      if (unit) unit.hasElision = true;
      continue;
    }

    // ── structural headings: end the section; not regulation text ──
    if (PART_HEAD_RE.test(line) || APPENDIX_HEAD_RE.test(line)
        || (SUBPART_HEAD_RE.test(line) && startsSectionBlock(idx))) {
      flush();
      section = null;
      stack = [];
      def = null;
      continue;
    }

    // ── editorial lines and footnotes: skipped ──
    if (EDITORIAL_RE.test(line) || isFootnoteText(line)) continue;

    // ── amendment instruction ──
    const instr = readInstruction(line);
    if (instr) {
      closeInstruction();
      curInstr = {
        num: instr.num, text: line, body: instr.body,
        refs: instructionSectionRefs(line), producedUnits: false,
      };
      instructions.push(curInstr);
      // The instruction precedes the section it names; adopt it so amendatory
      // text still attaches correctly if the heading is missing or unparseable.
      if (curInstr.refs.length) setSection(curInstr.refs[0], '');
      else { stack = []; def = null; }
      continue;
    }

    // ── lettered sub-instruction ("a. Revise paragraph (b)…") ──
    if (curInstr && !unit && SUBINSTR_RE.test(line)) {
      curInstr.text += ' ' + line;
      curInstr.body += ' ' + line;
      for (const r of instructionSectionRefs(line)) {
        if (!curInstr.refs.includes(r)) curInstr.refs.push(r);
      }
      continue;
    }

    // ── section heading ──
    // "§ 2.309 …" is explicit; an unmarked "2.326 …" must be vouched for.
    let mSec = line.match(SECTION_HEAD_RE);
    if (!mSec) {
      const mBare = line.match(DOTTED_HEAD_RE);
      if (mBare && isBareSectionHeading(mBare[1].replace(/\.+$/, ''), mBare[2].trim(), curInstr, title10)) {
        mSec = mBare;
      }
    }
    if (mSec) {
      flush();
      // "§ 2.813 [Amended]" is a status marker, not a section title.
      const heading = (mSec[2] || '').trim();
      setSection(mSec[1].replace(/\.+$/, ''), /^\[[^\]]*\]$/.test(heading) ? '' : heading);
      openUnit('');           // section-level body, if any text follows
      continue;
    }

    // ── subsection designator ──
    const des = leadingDesignators(line);
    if (des) {
      const next = peekNextDesignator(idx);
      // Inside a definition, deeper designators are its sub-paragraphs; one at
      // or above the definition's own level is a sibling and ends it.
      if (def && designatorLevel(des.tokens[0], stack, des.tokens[1] || next) <= def.base) def = null;
      const full = resolvePath(des.tokens, stack, next);
      const sub = def ? stack.slice(def.base).join('') : '';
      if (def) openUnit(def.path + sub, def.label + sub);
      else openUnit(full);
      if (ELISION_RE.test(des.rest)) unit.hasElision = true;
      else if (des.rest) { unit.lines.push(des.rest); noteMarks(des.rest); }
      continue;
    }

    // ── a definition: "Term means …" in a definitions section ──
    const term = section && section.defs ? definitionTerm(line) : null;
    if (term) {
      // Definitions are top-level in their section, or sit inside the single
      // lettered paragraph that introduces them ("(a) As used in this section:").
      // Anything deeper on the stack is a previous definition's sub-paragraphs.
      const base = def ? def.base : (stack.length === 1 && /^\([a-z]+\)$/.test(stack[0]) ? 1 : 0);
      stack.length = base;
      const prefix = stack.join('');
      def = { base, path: `${prefix}“${termKey(term)}”`, label: `${prefix}“${term}”` };
      openUnit(def.path, def.label);
      unit.lines.push(line);
      noteMarks(line);
      continue;
    }

    // ── continuation of the open unit ──
    if (unit) {
      unit.lines.push(line);
      noteMarks(line);
      if (curInstr && !unit.instrNums.includes(curInstr.num)
          && (!curInstr.refs.length || curInstr.refs.includes(unit.section))) {
        unit.instrNums.push(curInstr.num);
      }
    }
    // Text before any section heading (cover page, preamble) is ignored.
  }
  closeInstruction();

  return { units, instructions };
}
