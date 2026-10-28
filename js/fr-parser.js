// RuleCheck — FRN vs. eCFR tab — Federal Register (.txt/.html) and working-draft (.docx/.pdf) amendment parsing.

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Parse Federal Register document into amendment objects
// ─────────────────────────────────────────────────────────────────────────────
//
// Each amendment object:
//   { num, instruction, sections[], part, proposedChunks[], substitutions[] }
//
// proposedChunks — ordered array used when the FR supplies full replacement text:
//   { type: 'omit' }                  — "* * * * *" unchanged-text marker
//   { type: 'para', label, text }     — paragraph with its designator
//   { type: 'header', text }          — section/subpart heading line
//
// substitutions — used when the instruction *is* the amendment (no body text):
//   { para, ops: [{ remove, add }] }
//   e.g. para="(e)", ops=[{ remove:"part 52", add:"part 52 or part 53" }]

function parseAmendments(htmlText) {
  const tmp = document.createElement('div');
  tmp.innerHTML = htmlText;
  const pre = tmp.querySelector('pre');
  const rawText = pre ? pre.innerText : tmp.innerText;
  const lines = rawText.split('\n');

  const amendments = [];

  let current = null;
  let bodyLines = [];
  let inBody = false;

  // ── helpers ──────────────────────────────────────────────────────────────

  // Returns true when a line is a continuation of an instruction header.
  // Also handles the case where a [[Page NNN]] marker interrupts the sentence.
  function isInstructionContinuation(line) {
    const ls = line.trimEnd();
    const trimmed = ls.trim();
    if (!trimmed) return false;                           // blank — see lookahead below
    if (trimmed === '0') return false;                    // FR paragraph separator
    if (/^PART \d+/i.test(trimmed)) return false;         // part header
    if (/^Sec\.\s+\d+\.\d+/.test(trimmed)) return false;  // section heading
    if (/^Sec\.\s+\d+\.\d+.*\[Amended\]/i.test(trimmed)) return false;
    if (ls.startsWith('    ')) return false;              // 4-space body indent
    if (/^\[\[Page \d+\]\]/.test(trimmed)) return false;  // page marker itself — skip via lookahead
    return true;
  }

  // Lookahead: from position j, skip blank lines and [[Page]] markers and
  // return the index of the first substantive line (or lines.length if none).
  function skipPageBreak(j) {
    while (j < lines.length) {
      const t = lines[j].trim();
      if (!t || /^\[\[Page \d+\]\]/.test(t)) { j++; continue; }
      return j;
    }
    return j;
  }

  function finalizeAmend() {
    if (!current) return;
    const amend = finishAmendment(current, bodyLines.join('\n'));
    if (amend) amendments.push(amend);
    current = null;
    bodyLines = [];
    inBody = false;
  }

  // ── main pass ─────────────────────────────────────────────────────────────

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    if (trimmed === '0') { i++; continue; }

    const match = trimmed.match(/^(\d+)\.\s+(.+)/);
    const isAmendStart = match &&
      /(?:Revise|Amend|Add|Remove|Redesignate|In Sec\.|In §)/i.test(trimmed);

    if (isAmendStart) {
      finalizeAmend();

      // ── Collect the full (possibly wrapped) instruction text ──────────────
      // Lines continue as long as they pass isInstructionContinuation.
      // Special case: a blank + [[Page NNN]] + blank may interrupt a sentence
      // mid-word — we look ahead past it and continue if the resuming line
      // is still a non-body, non-separator continuation.
      const instrLines = [trimmed];
      let j = i + 1;
      while (j < lines.length) {
        const cur = lines[j];
        const curTrimmed = cur.trim();

        if (isInstructionContinuation(cur)) {
          instrLines.push(curTrimmed);
          j++;
          continue;
        }

        // Hit a blank or page-break — peek ahead to see if the instruction resumes
        if (!curTrimmed || /^\[\[Page \d+\]\]/.test(curTrimmed)) {
          const resume = skipPageBreak(j);
          if (resume < lines.length) {
            const resumeLine = lines[resume];
            // Resume only if the next substantive line is still an instruction
            // continuation (not a section heading, not a body indent, not '0')
            if (isInstructionContinuation(resumeLine) &&
                !resumeLine.trim().startsWith('a.') &&
                !resumeLine.trim().startsWith('b.')) {
              instrLines.push(resumeLine.trim());
              j = resume + 1;
              continue;
            }
          }
        }
        break;
      }
      // Join with a single space (the FR wraps at ~72 chars with no hyphenation)
      const fullInstruction = instrLines.join(' ').replace(/\s+/g, ' ').trim();

      current = { num: match[1], instruction: fullInstruction };
      inBody = false;
      i = j; // resume after the instruction lines
      continue;

    } else if (current) {
      const secHeaderRe = /^Sec\.\s+\d+\.\d+|^§\s*\d+\.\d+/;
      if (secHeaderRe.test(trimmed) && !inBody) inBody = true;
      if (inBody || bodyLines.length > 0) bodyLines.push(line);
    }

    i++;
  }
  finalizeAmend();
  return amendments;
}

// Section references in an instruction: "Sec. 2.1", "§ 50.55a"
const AMEND_SECTION_REF_RE = /(?:Sec\.|§)\s*(\d+\.\d+[\w.]*)/g;
// "Sec. 55.41  Written examination: Operators." / "§ 52.21 Administrative …"
const TITLED_SECTION_HEAD_RE = /^(?:Sec\.|§)\s*(\d+\.\d+[\w.]*)\s+[A-Z]/;

function instructionSections(instruction) {
  return [...instruction.matchAll(AMEND_SECTION_REF_RE)].map(m => m[1].replace(/\.+$/, ''));
}

// Complete an amendment { num, instruction } with its section references, part
// and the proposed text that followed it. Returns null when there is nothing
// to compare.
function finishAmendment(amend, bodyText) {
  const proposedChunks = parseProposedChunks(bodyText);
  // An instruction that names no section ("The authority citation for part 52
  // continues…") may still be followed by section text in an excerpted draft.
  // Only a titled heading counts: an "[Amended]" marker belongs to the *next*
  // instruction, and "Sec. 21.21(c) in order to…" is a wrapped reference.
  let sections = instructionSections(amend.instruction);
  if (!sections.length) {
    sections = proposedChunks
      .map(c => c.type === 'header' && c.text.match(TITLED_SECTION_HEAD_RE))
      .filter(Boolean).map(m => m[1].replace(/\.+$/, ''));
  }
  const partMatch = amend.instruction.match(/part\s+(\d+)/i);
  const part = sections.length ? sections[0].split('.')[0] : (partMatch ? partMatch[1] : null);
  const substitutions = proposedChunks.length ? [] : parseSubstitutionInstruction(amend.instruction);
  if (!proposedChunks.length && !substitutions.length && !sections.length) return null;
  return { ...amend, sections, part, proposedChunks, substitutions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Working drafts (.docx, .pdf) — same amendments, read paragraph by paragraph
// ─────────────────────────────────────────────────────────────────────────────
//
// A working draft carries the same instructions and amendatory text as the
// Federal Register version, but each paragraph arrives whole rather than wrapped
// at 72 characters, and the drafting conventions differ: "XX." placeholders or
// Word list numbering instead of instruction numbers, "§" instead of "Sec.".
// Instructions are recognised with the Document Comparison tab's rules
// (readInstruction); the text after the section heading becomes the proposed
// chunks exactly as for the .txt/.html path.

function parseAmendmentParagraphs(paras) {
  const amendments = [];
  const [begin, end] = regulationSpan(paras);
  let current = null;
  let bodyLines = [];
  let inBody = false;

  function finalizeAmend() {
    if (!current) return;
    const amend = finishAmendment(current, bodyLines.join('\n'));
    if (amend) amendments.push(amend);
    current = null;
    bodyLines = [];
    inBody = false;
  }

  for (let i = begin; i < end; i++) {
    const line = paras[i].trim();
    if (!line) continue;

    const instr = readInstruction(line);
    if (instr) {
      finalizeAmend();
      current = { num: instr.num, instruction: line };
      continue;
    }
    if (!current) continue;   // cover page, preamble

    // Part and appendix headings, citations and footnotes are not proposed text.
    if (PART_HEAD_RE.test(line) || APPENDIX_HEAD_RE.test(line)) { inBody = false; continue; }
    if (EDITORIAL_RE.test(line) || FOOTNOTE_TEXT_RE.test(line)) continue;

    // "a. Revise paragraph (b)…" on its own line still belongs to the instruction.
    if (!bodyLines.length && SUBINSTR_RE.test(line)) {
      current.instruction += ' ' + line;
      continue;
    }

    // Section heading: "§ 50.55a …", or an unmarked "50.55a …" that the
    // instruction names. Normalised to "§" so it becomes a header chunk.
    let heading = SECTION_HEAD_RE.test(line) || /^Sec\.\s+\d+\.\d+/.test(line) ? line : null;
    if (!heading) {
      const m = line.match(DOTTED_HEAD_RE);
      const number = m && m[1].replace(/\.+$/, '');
      if (m && isBareSectionHeading(number, m[2].trim(), { refs: instructionSections(current.instruction) }, null)) {
        heading = `§ ${number} ${m[2].trim()}`;
      }
    }
    if (heading) {
      inBody = true;
      bodyLines.push(heading);
      continue;
    }
    if (inBody) bodyLines.push(line);
  }
  finalizeAmend();
  return amendments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse substitution operations from an instruction-only amendment.
//
// Real patterns found in this document:
//
//  A. Direct inline:
//     "In Sec. 2.1, in paragraph (e) remove the phrase ``X'' and add in its
//      place the phrase ``Y''."
//
//  B. Multiple paragraphs, single instruction:
//     "In Sec. 20.1406, in paragraphs (a) and (b), wherever it appears,
//      remove the phrase ``X'' and add in its place the phrase ``Y''."
//
//  C. Compound with semicolon:
//     "In Sec. 2.1502, in paragraph (a), remove ``X'' and add ``Y'';
//      and in paragraph (b)(1), wherever it appears, remove ``A'' and add ``B''."
//
//  D. "Amend Sec. X by: / a. ... / b. ..." sub-clause pattern
//     (sub-clauses stored in amend.subClauses[] and processed separately)
//
//  E. Add-only (no removal):
//     "In Sec. 19.20, add the number ``53,'' in sequential order."
//
//  F. Add after / before anchor:
//     "add ``Y'' after ``X''"  /  "add ``Y'' before ``X''"
//
// Returns: [ { para, paras[], wherever, ops: [{ remove, add }] }, ... ]
//   para   — single paragraph designator e.g. "(e)" or null
//   paras  — array when multiple paragraphs named e.g. ["(a)","(b)"]
//   wherever — boolean: true if "wherever it appears" (replace all occurrences)
// ─────────────────────────────────────────────────────────────────────────────
function parseSubstitutionInstruction(instruction) {
  // Normalise FR typographic quotes to straight double quotes
  const text = normalizeQuotes(instruction);
  const results = [];

  // ── Compound semicolon-separated clauses ─────────────────────────────────
  // Split on "; and" or "; " at clause boundaries (not inside quotes)
  const clauses = splitClauses(text);

  let inheritedParas = null; // carry paragraph context across clauses

  for (const clause of clauses) {
    // Extract paragraph target(s) from this clause
    // Handles: "in paragraph (e)", "in paragraphs (a) and (b)",
    //          "in paragraph (b)(1)", "in paragraphs (a)(4) and (5)"
    const { para, paras } = extractParaTarget(clause) ||
      (inheritedParas ? { para: inheritedParas[0] || null, paras: inheritedParas } : { para: null, paras: [] });

    if (paras && paras.length) inheritedParas = paras;

    const wherever = /wherever it appears/i.test(clause);
    const ops = extractOps(clause);

    if (ops.length) {
      const effectiveParas = (paras && paras.length) ? paras : (para ? [para] : [null]);
      for (const p of effectiveParas) {
        const existing = results.find(r => r.para === p && !r.ops.length);
        if (existing) { existing.ops.push(...ops); existing.wherever = existing.wherever || wherever; }
        else results.push({ para: p, paras: effectiveParas, wherever, ops });
      }
    }
  }

  return results;
}

function normalizeQuotes(s) {
  return s
    .replace(/``/g, '"').replace(/''/g, '"')
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

// Split instruction text into clauses on "; and" / "; " outside of quoted strings
function splitClauses(text) {
  const parts = [];
  let depth = 0, start = 0, inQuote = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') inQuote = !inQuote;
    if (!inQuote && text[i] === ';') {
      parts.push(text.slice(start, i).trim());
      // skip optional " and "
      let j = i + 1;
      while (j < text.length && /[\s]/.test(text[j])) j++;
      if (text.slice(j, j + 4).toLowerCase() === 'and ') j += 4;
      start = j;
      i = j - 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

// Extract paragraph target(s) from a clause string.
// Returns { para, paras } or null.
function extractParaTarget(clause) {
  // "in paragraph (X)" or "in paragraphs (X) and (Y)" or "in paragraph (X)(Y)"
  const m = clause.match(
    /in\s+paragraphs?\s+((?:\([^)]+\))+(?:\s+(?:and|or)\s+(?:\([^)]+\))+)*)/i
  );
  if (!m) return null;

  const raw = m[1];
  // Extract all (...) groups
  const all = [];
  let pos = 0;
  while (pos < raw.length) {
    if (raw[pos] === '(') {
      const close = raw.indexOf(')', pos);
      if (close === -1) break;
      // Collect consecutive (...) groups as one designator
      let label = '';
      let p2 = pos;
      while (p2 < raw.length && raw[p2] === '(') {
        const c2 = raw.indexOf(')', p2);
        if (c2 === -1) break;
        label += raw.slice(p2, c2 + 1);
        p2 = c2 + 1;
      }
      all.push(label);
      pos = p2;
    } else {
      pos++;
    }
  }

  if (!all.length) return null;
  return { para: all[0], paras: all };
}

// Extract { remove, add } operation pairs from a single clause string.
function extractOps(clause) {
  const ops = [];

  // Pattern 1: remove "X" and add "Y" (most common)
  // Handles: "remove the phrase "X" and add in its place the phrase "Y""
  //          "removing "X" and adding, in its place, "Y""
  const removeAddRe = /remov(?:e|ing)\s+(?:the\s+)?(?:phrase\s+|cross[- ]reference\s+|definition\s+of\s+)?("([^"]+)")\s+and\s+add(?:ing)?(?:[^"]*?)?("([^"]+)")/gi;
  let m;
  while ((m = removeAddRe.exec(clause)) !== null) {
    ops.push({ remove: m[2], add: m[4] });
  }
  if (ops.length) return ops;

  // Pattern 2: add "Y" after "X"
  const addAfterRe = /add(?:ing)?\s+(?:the\s+)?(?:words?\s+|phrase\s+|number\s+)?("([^"]+)")\s+after\s+(?:the\s+)?(?:words?\s+|phrase\s+)?("([^"]+)")/i;
  const addAfterM = clause.match(addAfterRe);
  if (addAfterM) {
    ops.push({ remove: addAfterM[4], add: addAfterM[4] + ' ' + addAfterM[2] });
    return ops;
  }

  // Pattern 3: add "Y" before "X"
  const addBeforeRe = /add(?:ing)?\s+(?:the\s+)?(?:words?\s+|phrase\s+)?("([^"]+)")\s+before\s+(?:the\s+)?(?:words?\s+|phrase\s+)?("([^"]+)")/i;
  const addBeforeM = clause.match(addBeforeRe);
  if (addBeforeM) {
    ops.push({ remove: addBeforeM[4], add: addBeforeM[2] + ' ' + addBeforeM[4] });
    return ops;
  }

  // Pattern 4: remove "X" only (no replacement)
  const removeOnlyRe = /remov(?:e|ing)\s+(?:the\s+)?(?:phrase\s+|cross[- ]reference\s+|definition\s+of\s+)?("([^"]+)")/i;
  const removeOnlyM = clause.match(removeOnlyRe);
  if (removeOnlyM) {
    ops.push({ remove: removeOnlyM[2], add: '' });
    return ops;
  }

  // Pattern 5: add "X" in sequential order / at the end / add number "X"
  const addOnlyRe = /add(?:ing)?\s+(?:a\s+sentence[^"]*reading\s+)?(?:the\s+)?(?:words?\s+|phrase\s+|number\s+)?("([^"]+)")/i;
  const addOnlyM = clause.match(addOnlyRe);
  if (addOnlyM) {
    ops.push({ remove: null, add: addOnlyM[2] });
    return ops;
  }

  return ops;
}

// Apply substitution ops to source text.
// op.wherever = true → replace all occurrences; false → first only.
function applySubstitutions(sourceText, ops, wherever) {
  let result = sourceText;
  for (const op of ops) {
    if (op.remove) {
      const flags = wherever ? 'gi' : 'i';
      const re = new RegExp(escapeRegex(op.remove), flags);
      if (re.test(result)) {
        result = result.replace(re, op.add);
      } else {
        // Not found verbatim — note it visibly
        if (op.add) result = result.trimEnd() + ' ' + op.add;
      }
    } else {
      // Add-only: append to end
      result = result.trimEnd() + ' ' + op.add;
    }
  }
  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ─────────────────────────────────────────────────────────────────────────────
//
// Federal Register paragraph designators look like:
//   (a)  (b)(1)  (a)(2)(iii)  (a)(1)(i)(A)  * * * * *
//
// We split the text on paragraph boundaries and classify each piece.

// Matches a paragraph designator at the start of a line (possibly indented)
const PARA_DESIGNATOR_RE = /^(\s*)\(([a-z0-9]+)\)/i;
// Matches a "* * * * *" omission marker line
const STARS_RE = /^\s*\*\s*\*\s*\*\s*\*\s*\*/;
// Matches a section/subpart heading (Sec. X.Y  or  Subpart X)
const HEADING_RE = /^\s*(Sec\.\s+\d+\.\d+|Subpart\s+\w+|§\s*\d+\.\d+)/i;

function parseProposedChunks(rawText) {
  const lines = rawText.split('\n');
  const chunks = [];
  let currentLabel = null;
  let currentLines = [];

  function flush() {
    if (currentLabel === null && currentLines.length === 0) return;
    const text = currentLines.join('\n').trim();
    if (!text) { currentLabel = null; currentLines = []; return; }
    chunks.push({ type: 'para', label: currentLabel || '', text });
    currentLabel = null;
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      // blank line — keep within current paragraph
      if (currentLines.length) currentLines.push('');
      continue;
    }

    if (STARS_RE.test(trimmed)) {
      flush();
      chunks.push({ type: 'omit' });
      continue;
    }

    if (HEADING_RE.test(trimmed) && currentLabel === null && currentLines.length === 0) {
      // Could be a heading or the very first line of a section (§ X.Y  Title.)
      // Treat as a header chunk
      flush();
      chunks.push({ type: 'header', text: trimmed });
      continue;
    }

    const designatorMatch = line.match(PARA_DESIGNATOR_RE);
    if (designatorMatch) {
      // Build the full designator by walking back through nested parents isn't
      // feasible here, so we just use the raw opening designator text.
      const label = buildDesignator(line);
      flush();
      currentLabel = label;
      currentLines = [line];
    } else {
      // Continuation of current paragraph
      currentLines.push(line);
    }
  }
  flush();

  // If we only got one chunk with no label it might be a simple full-replacement
  // (no STARS, no paragraph markers) — keep it as a single para with no label.
  return chunks;
}

// Extract the outermost paragraph designator string from a line, e.g. "(a)(2)(iii)"
function buildDesignator(line) {
  const trimmed = line.trim();
  let pos = 0;
  let label = '';
  // Walk consecutive (...) groups
  while (pos < trimmed.length && trimmed[pos] === '(') {
    const close = trimmed.indexOf(')', pos);
    if (close === -1) break;
    label += trimmed.slice(pos, close + 1);
    pos = close + 1;
  }
  return label || trimmed.slice(0, 10);
}
