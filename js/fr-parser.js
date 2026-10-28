// RuleCheck — FRN vs. eCFR tab — Federal Register (.txt/.html) and working-draft (.docx/.pdf) amendment parsing.

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Parse Federal Register document into amendment objects
// ─────────────────────────────────────────────────────────────────────────────
//
// Each amendment object:
//   { num, instruction, sections[], part, proposedChunks[], bodyParas[], edits }
// or, for an appendix (appendix.js):
//   { num, instruction, part, appendix: { letter, part, id }, appendixChunks[], edits }
//
// bodyParas — the amendatory text one paragraph per entry, which ecfr-view.js
//   parses with parseAmendmentDoc to compare with the eCFR section.
// proposedChunks — the same text in coarse chunks, shown when the eCFR can't be reached:
//   { type: 'omit' }                  — "* * * * *" unchanged-text marker
//   { type: 'para', label, text }     — paragraph with its designator
//   { type: 'header', text }          — section/subpart heading line
// edits — what the instruction does beyond reprinting text (frn-redline.js):
//   paragraphs it revises or removes, in-place "remove … and add …" edits.

function parseAmendments(htmlText) {
  const tmp = document.createElement('div');
  tmp.innerHTML = htmlText;
  // regulations.gov pages hide e-mail addresses behind Cloudflare's
  // obfuscation; restore them so they match the eCFR text.
  for (const el of tmp.querySelectorAll('[data-cfemail]')) el.textContent = decodeCfEmail(el.dataset.cfemail);
  const pre = tmp.querySelector('pre');
  const rawText = pre ? pre.innerText : tmp.innerText;
  const lines = rawText.split('\n');

  const amendments = [];

  let current = null;
  let bodyLines = [];
  let inBody = false;
  let inSubInstr = false;   // inside a wrapped "a. Revise …" sub-instruction
  let partHint = null;      // the part whose "PART 50--…" heading was last seen

  // ── helpers ──────────────────────────────────────────────────────────────

  // Returns true when a line is a continuation of an instruction header.
  // Also handles the case where a [[Page NNN]] marker interrupts the sentence.
  function isInstructionContinuation(line) {
    const ls = line.trimEnd();
    const trimmed = ls.trim();
    if (!trimmed) return false;                           // blank — see lookahead below
    if (trimmed === '0') return false;                    // FR paragraph separator
    if (/^PART \d+/i.test(trimmed)) return false;         // part header
    // A section heading has a title ("Sec. 50.220  Use of …"); a wrapped
    // instruction may also start a line with "Sec. 50.221 to read as follows:".
    if (/^Sec\.\s+\d+\.\d+[\w.]*\s+(?:[A-Z[]|$)/.test(trimmed)) return false;
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
  //
  // Amendments follow the words of issuance ("For the reasons set out in the
  // preamble …"); numbered paragraphs in the preamble are not instructions.

  const issuance = lines.findIndex(l => ISSUANCE_RE.test(l.trim()));
  let i = issuance === -1 ? 0 : issuance + 1;
  while (i < lines.length) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    if (trimmed === '0') { inSubInstr = false; i++; continue; }
    if (/^Dated:/.test(trimmed) || /^\[FR Doc\./.test(trimmed)) break;   // signature block
    const partHead = !/^\s/.test(line) && trimmed.match(/^PART\s+(\d+[A-Za-z]?)\b/);
    if (partHead) partHint = partHead[1];

    // Instructions start at the margin; body paragraphs are indented.
    const match = !/^\s/.test(line) && trimmed.match(/^(\d+)\.\s+(.+)/);
    const isAmendStart = match && FR_INSTRUCTION_LEAD_RE.test(match[2]);

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
            // Resume only mid-sentence, and only if the next substantive line is
            // still an instruction continuation (not a heading, body indent or '0')
            if (!/[.:;]$/.test(instrLines[instrLines.length - 1]) &&
                isInstructionContinuation(resumeLine) &&
                !APPENDIX_HEAD_RE.test(resumeLine.trim()) && !ELISION_RE.test(resumeLine.trim()) &&
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

      current = { num: match[1], instruction: fullInstruction, partHint, prev: amendments[amendments.length - 1] };
      inBody = false;
      i = j; // resume after the instruction lines
      continue;

    } else if (current) {
      const secHeaderRe = /^Sec\.\s+\d+\.\d+|^§\s*\d+\.\d+/;
      const appendixHead = APPENDIX_HEAD_RE.test(trimmed) && appendixRef(current.instruction, current.partHint);
      // Lettered sub-instructions ("a. Revise Section III.A;", each after its
      // own "0" separator, wrapping onto unindented lines) and the closing
      // "… read as follows:" belong to the instruction, not the amendatory text.
      if (!inBody && !bodyLines.length && /^\[\[Page \d+\]\]$/.test(trimmed)) { i++; continue; }
      if (!inBody && !bodyLines.length && trimmed && !secHeaderRe.test(trimmed) && !appendixHead) {
        const readsAsFollows = /\bread(?:s)? as follows:?$/i.test(trimmed);
        if (/^[a-z]\.\s+\S/.test(trimmed) || (inSubInstr && !line.startsWith('    ')) || readsAsFollows) {
          current.instruction += ' ' + trimmed;
          inSubInstr = !readsAsFollows;
          i++;
          continue;
        }
      }
      inSubInstr = false;
      if ((secHeaderRe.test(trimmed) || appendixHead) && !inBody) inBody = true;
      if (inBody || bodyLines.length > 0) bodyLines.push(line);
    }

    i++;
  }
  finalizeAmend();
  return amendments;
}

// How an FR instruction opens, after its number: "In Sec. 50.2, …", "In 51.4,
// …", "In appendix D to part 52:", "Revise …", "Sec. 50.120:", "The authority
// citation …" (which ends the instruction before it). "The DG-1434,
// ``Addressing …''" in a numbered preamble list is not one.
const FR_INSTRUCTION_LEAD_RE = /^(?:In\s+(?:Sec\.|§|\d+\.\d+|appendix\b|part\b|subpart\b)|(?:Revise|Amend|Add|Remove|Redesignate|Republish|Reserve|Designate|Transfer|Suspend|Correct)\b|(?:Sec\.|§)\s*\d|The authority citation\b)/i;

// Section references in an instruction: "Sec. 2.1", "§ 50.55a"
const AMEND_SECTION_REF_RE = /(?:Sec\.|§)\s*(\d+\.\d+[\w.]*)/g;
// "Sec. 55.41  Written examination: Operators." / "§ 52.21 Administrative …"
const TITLED_SECTION_HEAD_RE = /^(?:Sec\.|§)\s*(\d+\.\d+[\w.]*)\s+[A-Z]/;

// Sections an instruction amends. Quoted text is wording being removed or
// added ("remove the reference ``Sec. 50.46b''"), not a section it amends.
function instructionSections(instruction) {
  const out = [];
  const bare = instruction.match(/^\s*(?:\S+\.\s+)?In\s+(\d+\.\d+[A-Za-z]*)\b/);   // "In 53.040:"
  if (bare) out.push(bare[1]);
  for (const m of unquoted(instruction).matchAll(AMEND_SECTION_REF_RE)) {
    const s = m[1].replace(/\.+$/, '');
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// Complete an amendment { num, instruction } with its section references, part
// and the proposed text that followed it. Returns null when there is nothing
// to compare.
function finishAmendment(amend, bodyText, paraMode = false) {
  // "In appendix D to part 52: …" — appendix paragraphs are keyed differently.
  const { partHint, prev, ...rest } = amend;
  amend = rest;
  const apx = !instructionSections(amend.instruction).length && appendixRef(amend.instruction, partHint);
  if (apx) return finishAppendixAmendment(amend, apx, bodyText, paraMode);
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
  // "Remove and reserve paragraph (c)(2)." on its own continues the section
  // the instruction before it amended.
  if (!sections.length && prev && prev.sections && prev.sections.length
      && /^\S+\.\s+(?:Remove|Revise|Add|Redesignate)\b[^§]*\bparagraphs?\s*\(/i.test(amend.instruction)) {
    sections = prev.sections.slice(0, 1);
  }
  const partMatch = amend.instruction.match(/part\s+(\d+)/i);
  const part = sections.length ? sections[0].split('.')[0] : (partMatch ? partMatch[1] : null);
  if (!sections.length) return null;   // an authority citation, or nothing to compare
  // The amendatory text paragraph by paragraph, for parseAmendmentDoc.
  const bodyParas = paraMode ? bodyText.split('\n').filter(l => l.trim())
    : frBlocks(bodyText.split('\n')).map(b => b.kind === 'stars' ? '* * * * *' : frSectionText(b.text));
  const edits = instructionEdits(amend.instruction, 'section', sections[0] || '');
  return { ...amend, sections, part, proposedChunks, bodyParas, edits };
}

// ─────────────────────────────────────────────────────────────────────────────
// Federal Register plain text → paragraphs
// ─────────────────────────────────────────────────────────────────────────────
//
// The FR wraps text at about 72 characters. A paragraph starts on an indented
// line and runs on through the unindented lines below it, across page breaks;
// headings ("Sec. 50.10 …", "III. Scope and Contents", "Appendix D to …")
// stand at the margin after a blank line and may wrap onto a second line.

const FR_PAGE_RE = /^\[\[Page \d+\]\]$/;
const FR_SKIP_RE = /^(?:BILLING CODE\b|\[GRAPHIC\]|\[TIFF OMITTED\])/;

// Blocks [{ kind: 'heading' | 'para' | 'stars', text }]
function frBlocks(lines) {
  const blocks = [];
  let cur = null, afterBlank = true;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || FR_PAGE_RE.test(t) || FR_SKIP_RE.test(t)) { afterBlank = true; continue; }
    if (/^Dated:/.test(t) || /^\[FR Doc\./.test(t)) break;
    if (!/^\s/.test(raw) && PART_HEAD_RE.test(t)) break;   // the next part's amendments
    if (ELISION_RE.test(t) || /^\*(?:\s*\*){4}\s*$/.test(t)) {
      blocks.push({ kind: 'stars' });
      cur = null; afterBlank = false;
      continue;
    }
    if (/^\s{2,}\S/.test(raw)) {
      blocks.push(cur = { kind: 'para', text: t });
    } else if (cur && (!afterBlank || (cur.kind === 'para' && !/[.:;]$/.test(cur.text)))) {
      // Wrapped line, or a paragraph resuming after a page break. The FR keeps
      // a hyphen at a line break ("short-" + "term").
      cur.text += (cur.text.endsWith('-') ? '' : ' ') + t;
    } else {
      blocks.push(cur = { kind: 'heading', text: t });
    }
    afterBlank = false;
  }
  return blocks;
}

// FR conventions → the eCFR's: "Sec." for "§", "\[1]\" footnote marks, "--" dashes.
function frSectionText(text) {
  return text
    .replace(/\bSecs?\.\s+Secs?\.\s+(?=\d)/g, '§§ ')
    .replace(/\bSecs\.\s+(?=\d)/g, '§§ ')
    .replace(/\bSec\.\s+(?=\d)/g, '§ ')
    .replace(/^\\\[?(\d{1,3})\]?\\\s*/, '[$1] ')   // footnote text: "\[5]\Alphanumeric …"
    .replace(/\\\[?(\d{1,3})\]?\\/g, '[$1]')
    .replace(/--/g, '—');
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
  let partHint = null;

  function finalizeAmend() {
    if (!current) return;
    const amend = finishAmendment(current, bodyLines.join('\n'), true);
    if (amend) amendments.push(amend);
    current = null;
    bodyLines = [];
    inBody = false;
  }

  for (let i = begin; i < end; i++) {
    const line = paras[i].trim();
    if (!line) continue;

    const partHead = line.match(/^PART\s+(\d+[A-Za-z]?)\b/);
    if (partHead) partHint = partHead[1];

    const instr = readInstruction(line);
    if (instr) {
      finalizeAmend();
      current = { num: instr.num, instruction: line, partHint, prev: amendments[amendments.length - 1] };
      continue;
    }
    if (!current) continue;   // cover page, preamble

    // The heading of an appendix the instruction amends opens its text, kept
    // paragraph by paragraph for finishAppendixAmendment.
    if (APPENDIX_HEAD_RE.test(line) && !instructionSections(current.instruction).length
        && appendixRef(current.instruction, current.partHint)) {
      inBody = true;
      current.appendixBody = true;
      continue;
    }
    if (current.appendixBody) { bodyLines.push(line); continue; }

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

  // Pattern 0: a whole sentence — "remove the last sentence", "the last
  // sentence is removed", "remove the first sentence of paragraph (a) and add
  // in its place "Y"" → { sentence: 'first' | 'last', add }
  const sentenceM = clause.match(/remov(?:e|ing)\s+the\s+(first|last)\s+sentence\b(?:[^"]*?\band\s+add(?:ing)?[^"]*?"([^"]+)")?/i)
    || clause.match(/\bthe\s+(first|last)\s+sentence\s+(?:is|are)\s+removed\b/i);
  if (sentenceM) {
    ops.push({ sentence: sentenceM[1].toLowerCase(), remove: null, add: sentenceM[2] || '' });
    return ops;
  }

  // Pattern 1: remove "X" and add "Y" (most common)
  // Handles: "remove the phrase "X" and add in its place the phrase "Y""
  //          "removing "X" and adding, in its place, "Y""
  //          "remove from paragraph (c) the text "X" and add, in its place, "Y""
  //          "remove the phrase "X" and replace it with "Y""
  const removeAddRe = /remov(?:e|ing)\s+(?:(?!reserv|and\b)[^"]){0,60}?("([^"]+)")\s+and\s+(?:add(?:ing)?|replac(?:e|ing))(?:[^"]*?)?("([^"]+)")/gi;
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
  const removeOnlyRe = /remov(?:e|ing)\s+(?:(?!reserv|and\b|definition)[^"]){0,60}?("([^"]+)")/i;
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
    if (op.sentence) {
      const sentences = splitSentences(result);
      if (sentences.length < 2 && !op.add) continue;   // never remove a paragraph's only sentence
      const k = op.sentence === 'first' ? 0 : sentences.length - 1;
      sentences[k] = op.add;
      result = sentences.filter(Boolean).join(' ');
      continue;
    }
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

// Cloudflare's data-cfemail: a hex key byte, then the address XORed with it.
function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

// Sentences of a paragraph. A period after a designator, an abbreviation
// ("U.S.", "No.", "Sec.") or a section number does not end one.
function splitSentences(text) {
  const out = [];
  let start = 0;
  const re = /[.?!][”"']?\s+(?=[A-Z(“"])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(start, m.index + 1);
    if (/(?:\b[A-Z]|\bU\.S|\bNo|\bNos|\bSec|\bSecs|\bpar|\be\.g|\bi\.e|\bet al|\bv|\bvs|\bInc|\bCo|\bDr|\bMr|\bMs|\b\d+)\.$/.test(before)) continue;
    out.push(text.slice(start, m.index + m[0].length).trim());
    start = m.index + m[0].length;
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
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
