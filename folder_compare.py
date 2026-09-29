#!/usr/bin/env python3
"""
folder_compare.py — RegDiff folder comparison.

Analyzes every .docx amendment document in a folder using the same logic as the
"Document Comparison" tab of index.html, and writes a dataset of every
conflicting subsection with its redline:

    regdiff-folder.json   load into the "Folder Comparison" tab of index.html
    regdiff-folder.csv    one row per redline, [-deleted-] {+inserted+} markup
    regdiff-folder.xlsx   same rows, with real red strikethrough / green underline
                          (written when openpyxl is installed)

Usage:
    python folder_compare.py FOLDER [-o OUTDIR] [--recursive] [--no-csv] [--no-xlsx]

The core needs only the Python standard library. openpyxl (bundled with
Anaconda) is used for the .xlsx output if it is available.

Parity note: the parsing, conflict detection and redline algorithms below are a
line-for-line port of the JavaScript in index.html. Regular expressions are
written to reproduce JavaScript semantics (ASCII \\d, \\w and \\b; Unicode \\s),
so the same document yields the same units in both. If you change one, change
the other.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

SCHEMA = "regdiff-folder/1"

# ─────────────────────────────────────────────────────────────────────────────
# JavaScript-compatible regex building blocks
# ─────────────────────────────────────────────────────────────────────────────
#
# JS \s is Unicode whitespace; JS \d, \w and \b are ASCII-only. Python's
# defaults differ on each, so the classes are spelled out explicitly.

_JS_WS_CHARS = (
    "\t\n\v\f\r   "
    + "".join(chr(c) for c in range(0x2000, 0x200B))
    + "    　﻿"
)
_WS_CLASS = "\t\n\v\f\r    -     　﻿"
S = f"[{_WS_CLASS}]"          # JS \s
NS = f"[^{_WS_CLASS}]"        # JS \S
_W = "A-Za-z0-9_"
B = f"(?:(?<=[{_W}])(?![{_W}])|(?<![{_W}])(?=[{_W}]))"   # JS \b

SECNUM = r"([0-9]+[A-Za-z]?(?:\.[0-9]+[A-Za-z]*)*)"

# Numbered instruction. Working drafts use an "XX." placeholder before the
# amendments are numbered, so those count as instructions too.
INSTRUCTION_RE = re.compile(r"^([0-9]{1,3}|X{1,3}|x{2,3})\." + S + r"+(.+)$")
SUBINSTR_RE = re.compile(r"^([a-z])\." + S + r"+(.+)$")
SECTION_HEAD_RE = re.compile(r"^§{1,2}" + S + "*" + SECNUM + S + "*[.:—–-]?" + S + r"*(.*)$")
DOTTED_HEAD_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)+[A-Za-z]?)\.?" + S + r"+(.+)$")
# "* * *" (or longer) alone on a line — the Federal Register elision marker.
ELISION_RE = re.compile(r"^\*(?:" + S + r"*\*){2,}" + S + "*$")
SECTION_REF_RE = re.compile(
    r"(?:§{1,2}|" + B + "Sections?" + B + "|" + B + r"Secs?\.)" + S + "*" + SECNUM, re.I)
PARA_KW_RE = re.compile(B + "paragraphs?" + B, re.I)
PARA_SEP_RE = re.compile(r"^(?:" + S + "*(?:,|and|or)?" + S + "*)", re.I)
DESIGNATOR_TOKEN_RE = re.compile(r"^[A-Za-z0-9]{1,4}$")
BRACKET_ONLY_RE = re.compile(r"^\[[^\]]*\]$")
ROMAN_RE = re.compile(r"^[ivxlcdm]+$")
WS_RUN_RE = re.compile(S + "+")
DIFF_TOKEN_RE = re.compile("(" + NS + "+|" + S + "+)")
SIM_TOKEN_RE = re.compile(r"[A-Za-z0-9_'-]+")

ROMAN_SUCCESSOR = {"i": "ii", "v": "vi", "x": "xi"}


def js_trim(s: str) -> str:
    return s.strip(_JS_WS_CHARS)


def js_len(s: str) -> int:
    """String length as JavaScript counts it (UTF-16 code units)."""
    return len(s.encode("utf-16-le")) // 2


# ─────────────────────────────────────────────────────────────────────────────
# DOCX → ordered plain-text paragraphs
# ─────────────────────────────────────────────────────────────────────────────
#
# Only <w:t> runs contribute text, so tracked deletions (<w:delText>) are
# excluded and tracked insertions included — the document as it reads with all
# changes accepted.

_WORD_NS = (
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://purl.oclc.org/ooxml/wordprocessingml/main",          # Strict OOXML
)
_P_TAGS = {f"{{{ns}}}p" for ns in _WORD_NS}


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _paragraph_text(p: ET.Element) -> str:
    out: list[str] = []

    def walk(node: ET.Element) -> None:
        for child in node:
            name = _local(child.tag) if isinstance(child.tag, str) else ""
            if name == "t":
                out.append("".join(child.itertext()))
            elif name == "delText":
                continue                       # tracked deletion — omit
            elif name in ("tab", "br", "cr"):
                out.append(" ")
            else:
                walk(child)

    walk(p)
    text = "".join(out).replace(" ", " ")
    return js_trim(WS_RUN_RE.sub(" ", text))


def read_docx_paragraphs(path: Path) -> list[str]:
    try:
        with zipfile.ZipFile(path) as z:
            xml_bytes = z.read("word/document.xml")
    except zipfile.BadZipFile:
        raise ValueError("Not a valid .docx file (no ZIP directory found).")
    except KeyError:
        raise ValueError("Malformed .docx — word/document.xml not found in the archive.")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        raise ValueError("Could not parse the Word document body (document.xml is malformed).")

    paras = []
    for el in root.iter():
        if el.tag in _P_TAGS:
            t = _paragraph_text(el)
            if t:
                paras.append(t)
    return paras


# ─────────────────────────────────────────────────────────────────────────────
# Amendment document structure — port of parseAmendmentDoc() and helpers
# ─────────────────────────────────────────────────────────────────────────────

def plausible_section_number(number: str, cited: bool = False) -> bool:
    """`cited` = carried a § / Section prefix; CFR subparts run to four digits,
    so only bare dotted numbering is capped (to reject "2.5 million")."""
    for seg in number.split("."):
        digits = re.sub(r"[A-Za-z]", "", seg)
        n = int(digits) if digits else 0       # JS Number('') === 0
        if not cited and n > 999:
            return False
    return True


def instruction_section_refs(text: str) -> list[str]:
    refs: list[str] = []
    for m in SECTION_REF_RE.finditer(text):
        number = m.group(1).rstrip(".")
        if plausible_section_number(number, True) and number not in refs:
            refs.append(number)
    return refs


def designator_level(token: str, stack: list[str], next_token: str | None) -> int:
    """(a) letter → (1) digit → (i) roman → (A) capital. A lone i/v/x is
    resolved from the next designator: a letter's children are digits, a
    roman numeral's children are capitals."""
    if re.fullmatch(r"[0-9]+", token):
        return 2
    if re.fullmatch(r"[A-Z]+", token):
        return 4
    if re.fullmatch(r"[a-z]", token):
        if token not in "ivx":
            return 1
        if next_token:
            if re.fullmatch(r"[0-9]+", next_token):
                return 1
            if re.fullmatch(r"[A-Z]+", next_token):
                return 3
            if next_token == ROMAN_SUCCESSOR[token]:
                return 3
            if next_token == chr(ord(token) + 1):
                return 1
        prev = stack[0] if stack else ""
        if prev and re.fullmatch(r"\([a-z]\)", prev):
            if token == chr(ord(prev[1]) + 1):
                return 1
        return 3 if (len(stack) > 1 and stack[1]) else 1
    if ROMAN_RE.match(token):
        return 3
    if re.fullmatch(r"[a-z]{2,}", token):
        return 1
    return 1


def leading_designators(line: str):
    """Leading "(x)" groups → (tokens, rest), or None."""
    tokens: list[str] = []
    pos = 0
    while pos < len(line) and line[pos] == "(":
        close = line.find(")", pos)
        if close == -1:
            break
        token = line[pos + 1:close]
        if not DESIGNATOR_TOKEN_RE.match(token):
            break
        tokens.append(token)
        pos = close + 1
    if not tokens:
        return None
    return tokens, js_trim(line[pos:])


def resolve_path(tokens: list[str], stack: list[str], next_token: str | None) -> str:
    """A compound designator hangs off the level of its first token, so
    "(5)(i)" under "(c)(2)(ii)" resolves to "(c)(5)(i)"."""
    level = designator_level(tokens[0], stack, tokens[1] if len(tokens) > 1 else next_token)
    keep = max(0, level - 1)
    if len(stack) > keep:
        del stack[keep:]
    else:
        stack.extend([""] * (keep - len(stack)))   # JS array holes join as ""
    stack.extend(f"({t})" for t in tokens)
    return "".join(stack)


def instruction_para_targets(text: str) -> list[str]:
    targets: list[str] = []
    for m in PARA_KW_RE.finditer(text):
        pos = m.end()
        while True:
            sep = PARA_SEP_RE.match(text[pos:])
            start = pos + (len(sep.group(0)) if sep else 0)
            des = leading_designators(text[start:])
            if not des:
                break
            path = "".join(f"({t})" for t in des[0])
            if path not in targets:
                targets.append(path)
            pos = start + len(path)
    return targets


def parse_amendment_doc(paras: list[str]):
    """Returns (units, instructions).

    units:        dict "section|path" → {section, sectionTitle, path, kind,
                  text, hasElision, instrNums}
    instructions: [{num, text, refs, producedUnits}]
    """
    units: dict[str, dict] = {}
    instructions: list[dict] = []
    st = {"instr": None, "section": None, "stack": [], "unit": None}

    def store(u: dict) -> bool:
        if not u["section"]:
            return False
        key = f"{u['section']}|{u['path']}"
        prev = units.get(key)
        if prev is not None \
                and not (u["kind"] == "text" and prev["kind"] == "instruction") \
                and not (u["kind"] == prev["kind"] and js_len(u["text"]) > js_len(prev["text"])):
            return False
        units[key] = u
        return True

    def flush() -> None:
        unit = st["unit"]
        if not unit:
            return
        text = js_trim("\n".join(unit.pop("lines")))
        if text:
            unit["text"] = text
            if store(unit) and st["instr"]:
                st["instr"]["producedUnits"] = True
        st["unit"] = None

    def open_unit(path: str) -> None:
        flush()
        sec = st["section"]
        number = sec["number"] if sec else ""
        ins = st["instr"]
        st["unit"] = {
            "section": number,
            "sectionTitle": sec["title"] if sec else "",
            "path": path,
            "kind": "text",
            "lines": [],
            "hasElision": False,
            "instrNums": [ins["num"]] if ins and (not ins["refs"] or number in ins["refs"]) else [],
        }

    def close_instruction() -> None:
        flush()
        ins = st["instr"]
        if not ins or ins["producedUnits"]:
            return
        targets = instruction_para_targets(ins["text"])
        for ref in ins["refs"]:
            for path in (targets or [""]):
                store({
                    "section": ref, "sectionTitle": "", "path": path,
                    "kind": "instruction", "text": ins["text"],
                    "hasElision": False, "instrNums": [ins["num"]],
                })

    def peek_next_designator(i: int):
        for j in range(i + 1, len(paras)):
            l = js_trim(paras[j])
            if not l or ELISION_RE.match(l):
                continue
            if INSTRUCTION_RE.match(l) or SECTION_HEAD_RE.match(l):
                return None
            d = leading_designators(l)
            return d[0][0] if d else None
        return None

    for idx, raw in enumerate(paras):
        line = js_trim(raw)
        if not line:
            continue

        # ── elision marker ──
        if ELISION_RE.match(line):
            if st["unit"]:
                st["unit"]["hasElision"] = True
            continue

        # ── numbered instruction ──
        m_instr = INSTRUCTION_RE.match(line)
        if m_instr and not DOTTED_HEAD_RE.match(line):
            close_instruction()
            ins = {"num": m_instr.group(1), "text": line,
                   "refs": instruction_section_refs(line), "producedUnits": False}
            st["instr"] = ins
            instructions.append(ins)
            if ins["refs"]:
                st["section"] = {"number": ins["refs"][0], "title": ""}
            st["stack"] = []
            continue

        # ── lettered sub-instruction ──
        if st["instr"] and not st["unit"] and SUBINSTR_RE.match(line):
            ins = st["instr"]
            ins["text"] += " " + line
            for r in instruction_section_refs(line):
                if r not in ins["refs"]:
                    ins["refs"].append(r)
            continue

        # ── section heading ──
        m_cited = SECTION_HEAD_RE.match(line)
        m_sec = m_cited or DOTTED_HEAD_RE.match(line)
        if m_sec and plausible_section_number(m_sec.group(1).rstrip("."), bool(m_cited)):
            flush()
            heading = js_trim(m_sec.group(2) or "")
            st["section"] = {
                "number": m_sec.group(1).rstrip("."),
                # "§ 2.813 [Amended]" is a status marker, not a title.
                "title": "" if BRACKET_ONLY_RE.match(heading) else heading,
            }
            st["stack"] = []
            open_unit("")
            continue

        # ── subsection designator ──
        des = leading_designators(line)
        if des:
            tokens, rest = des
            path = resolve_path(tokens, st["stack"], peek_next_designator(idx))
            open_unit(path)
            if ELISION_RE.match(rest):
                st["unit"]["hasElision"] = True
            elif rest:
                st["unit"]["lines"].append(rest)
            continue

        # ── continuation ──
        unit = st["unit"]
        if unit:
            unit["lines"].append(line)
            ins = st["instr"]
            if ins and ins["num"] not in unit["instrNums"] \
                    and (not ins["refs"] or unit["section"] in ins["refs"]):
                unit["instrNums"].append(ins["num"])

    close_instruction()
    return units, instructions


# ─────────────────────────────────────────────────────────────────────────────
# Comparison helpers — port of normForCompare(), similarity()
# ─────────────────────────────────────────────────────────────────────────────

_SQUOTE_RE = re.compile("[‘’ʼ]")
_DQUOTE_RE = re.compile("[“”„]")
_DASH_RE = re.compile("[‐-―]")


def norm_for_compare(s: str) -> str:
    s = _SQUOTE_RE.sub("'", s)
    s = _DQUOTE_RE.sub('"', s)
    s = _DASH_RE.sub("-", s)
    s = s.replace(" ", " ")
    s = WS_RUN_RE.sub(" ", s)
    return js_trim(s).lower()


def similarity(a: str, b: str) -> float:
    ta = SIM_TOKEN_RE.findall(norm_for_compare(a))
    tb = SIM_TOKEN_RE.findall(norm_for_compare(b))
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    counts: dict[str, int] = {}
    for t in ta:
        counts[t] = counts.get(t, 0) + 1
    common = 0
    for t in tb:
        c = counts.get(t, 0)
        if c:
            common += 1
            counts[t] = c - 1
    return (2 * common) / (len(ta) + len(tb))


def _section_sort_key(number: str):
    key = []
    for seg in number.split("."):
        m = re.match(r"([0-9]*)(.*)", seg)
        key.append((int(m.group(1)) if m.group(1) else -1, m.group(2)))
    return key


# ─────────────────────────────────────────────────────────────────────────────
# Redline — port of computeDiff(), lcsOps(), mergeReplacements(),
# diffParagraphBlocks(); emits structured ops instead of HTML
# ─────────────────────────────────────────────────────────────────────────────
#
# A row is either {"t": "omit", "n": count} for a run of unchanged paragraphs,
# or {"t": "diff", "ops": [[op, text], ...]} where op is "=", "-" or "+".
# The old side of a row is its "=" and "-" runs; the new side its "=" and "+".

MAX_WORD_TOKENS = 2000      # same guard as computeDiff()
MAX_PARAGRAPHS = 400        # same guard as diffParagraphBlocks()


def _lcs_walk(a: list, b: list):
    """Yield ("=", i, j) / ("+", None, j) / ("-", i, None) exactly as the JS
    walks its LCS table. A shared prefix is peeled off first: the JS walk
    matches equal heads greedily, so this changes nothing but the cost."""
    p = 0
    while p < len(a) and p < len(b) and a[p] == b[p]:
        yield ("=", p, p)
        p += 1
    a2, b2 = a[p:], b[p:]
    m, n = len(a2), len(b2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m - 1, -1, -1):
        ai, row, nxt = a2[i], dp[i], dp[i + 1]
        for j in range(n - 1, -1, -1):
            if ai == b2[j]:
                row[j] = nxt[j + 1] + 1
            else:
                x, y = nxt[j], row[j + 1]
                row[j] = x if x > y else y
    i = j = 0
    while i < m or j < n:
        if i < m and j < n and a2[i] == b2[j]:
            yield ("=", p + i, p + j)
            i += 1
            j += 1
        elif j < n and (i >= m or dp[i][j + 1] >= dp[i + 1][j]):
            yield ("+", None, p + j)
            j += 1
        else:
            yield ("-", p + i, None)
            i += 1


def _compress(ops):
    """Merge adjacent same-op tokens, and within each changed block put the
    deletions before the insertions so an inline redline reads "[-old-]{+new+}".
    Reordering inside a block leaves both sides of the two-column view intact:
    each side keeps its own tokens in their original order."""
    ordered: list[tuple[str, str]] = []
    block: list[tuple[str, str]] = []
    for op, text in ops:
        if op == "=":
            ordered += [x for x in block if x[0] == "-"] + [x for x in block if x[0] == "+"]
            block = []
            ordered.append((op, text))
        else:
            block.append((op, text))
    ordered += [x for x in block if x[0] == "-"] + [x for x in block if x[0] == "+"]

    out: list[list[str]] = []
    for op, text in ordered:
        if out and out[-1][0] == op:
            out[-1][1] += text
        else:
            out.append([op, text])
    return out


def word_diff(old: str, new: str):
    """Returns (ops, coarse). coarse=True when the text is too long for a
    word-level diff and the whole passage is marked deleted/inserted."""
    a = DIFF_TOKEN_RE.findall(old)
    b = DIFF_TOKEN_RE.findall(new)
    if len(a) > MAX_WORD_TOKENS or len(b) > MAX_WORD_TOKENS:
        return [["-", old], ["+", new]], True
    ops = []
    for op, i, j in _lcs_walk(a, b):
        ops.append((op, a[i] if op != "+" else b[j]))
    return _compress(ops), False


def diff_paragraph_blocks(a_text: str, b_text: str) -> list[dict]:
    a = [s for s in (js_trim(x) for x in a_text.split("\n")) if s]
    b = [s for s in (js_trim(x) for x in b_text.split("\n")) if s]

    if len(a) > MAX_PARAGRAPHS or len(b) > MAX_PARAGRAPHS:
        ops, coarse = word_diff(a_text, b_text)
        row = {"t": "diff", "ops": ops}
        if coarse:
            row["coarse"] = True
        return [row]

    ka = [norm_for_compare(x) for x in a]
    kb = [norm_for_compare(x) for x in b]
    raw = [(op, a[i] if i is not None else None, b[j] if j is not None else None)
           for op, i, j in _lcs_walk(ka, kb)]

    # mergeReplacements(): pair each contiguous changed block into rows.
    merged = []
    k = 0
    while k < len(raw):
        if raw[k][0] == "=":
            merged.append(("eq", None, None))
            k += 1
            continue
        dels, inss = [], []
        while k < len(raw) and raw[k][0] != "=":
            if raw[k][0] == "-":
                dels.append(raw[k][1])
            else:
                inss.append(raw[k][2])
            k += 1
        paired = min(len(dels), len(inss))
        merged += [("rep", dels[x], inss[x]) for x in range(paired)]
        merged += [("del", d, None) for d in dels[paired:]]
        merged += [("ins", None, s) for s in inss[paired:]]

    rows: list[dict] = []
    eq_run = 0
    for kind, old, new in merged:
        if kind == "eq":
            eq_run += 1
            continue
        if eq_run:
            rows.append({"t": "omit", "n": eq_run})
            eq_run = 0
        if kind == "rep":
            ops, coarse = word_diff(old, new)
            row = {"t": "diff", "ops": ops}
            if coarse:
                row["coarse"] = True
            rows.append(row)
        elif kind == "del":
            rows.append({"t": "diff", "ops": [["-", old]]})
        else:
            rows.append({"t": "diff", "ops": [["+", new]]})
    if eq_run:
        rows.append({"t": "omit", "n": eq_run})
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# Folder analysis — port of analyzeDocuments(), extended to N documents
# ─────────────────────────────────────────────────────────────────────────────

def doc_tag(i: int) -> str:
    """A, B, …, Z, AA, AB, … (spreadsheet-style)."""
    tag = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        tag = chr(65 + r) + tag
    return tag


def find_docx(folder: Path, recursive: bool) -> list[Path]:
    pattern = "**/*.docx" if recursive else "*.docx"
    files = [p for p in folder.glob(pattern)
             if p.is_file() and not p.name.startswith("~$")]      # skip Word lock files
    return sorted(files, key=lambda p: str(p.relative_to(folder)).lower())


def analyze_folder(folder: Path, recursive: bool = False, log=print) -> dict:
    started = time.time()
    documents: list[dict] = []
    parsed: list[tuple[dict, dict, list]] = []    # (doc, units, instructions)

    files = find_docx(folder, recursive)
    for i, path in enumerate(files):
        rel = str(path.relative_to(folder))
        doc = {"id": i, "tag": doc_tag(i), "name": path.name, "relPath": rel,
               "bytes": path.stat().st_size, "error": None}
        try:
            paras = read_docx_paragraphs(path)
            units, instructions = parse_amendment_doc(paras)
            doc.update({
                "paragraphs": len(paras),
                "sections": len({u["section"] for u in units.values()}),
                "units": len(units),
                "instructions": len(instructions),
                "instructionOnly": sum(1 for x in instructions if not x["producedUnits"]),
            })
            parsed.append((doc, units, instructions))
            log(f"  [{doc['tag']}] {rel}: {len(units)} subsections, {len(instructions)} instructions")
        except Exception as e:                      # one bad file must not stop the run
            doc["error"] = str(e)
            log(f"  [{doc['tag']}] {rel}: ERROR {e}")
        documents.append(doc)

    # ── cross-document index, in document then document-order ──
    index: dict[str, list[tuple[dict, dict, list]]] = {}
    for doc, units, instructions in parsed:
        for key, unit in units.items():
            index.setdefault(key, []).append((doc, unit, instructions))

    conflicts: list[dict] = []
    unique_to_one = agreeing = 0

    for key, entries in index.items():
        if len(entries) < 2:
            unique_to_one += 1
            continue

        # Distinct variants, in order of first appearance.
        variant_of: dict[str, int] = {}
        variants: list[dict] = []
        entry_variant: list[int] = []
        for doc, unit, _ in entries:
            n = norm_for_compare(unit["text"])
            if n not in variant_of:
                variant_of[n] = len(variants)
                variants.append({"id": len(variants), "kind": unit["kind"], "text": unit["text"],
                                 "docs": [], "hasElision": False, "_norm": n})
            v = variants[variant_of[n]]
            v["docs"].append(doc["id"])
            v["hasElision"] = v["hasElision"] or unit["hasElision"]
            entry_variant.append(v["id"])

        forms_differ = len({u["kind"] for _, u, _ in entries}) > 1
        if len(variants) < 2:
            agreeing += 1
            continue

        # Most divergent same-kind pair, scanned over entries exactly as the JS does.
        worst = None
        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                ui, uj = entries[i][1], entries[j][1]
                if ui["kind"] != uj["kind"]:
                    continue
                if entry_variant[i] == entry_variant[j]:
                    continue
                sim = similarity(ui["text"], uj["text"])
                if worst is None or sim < worst[2]:
                    worst = (i, j, sim)

        form_only = worst is None
        if form_only:
            ti = next((k for k, e in enumerate(entries) if e[1]["kind"] == "text"), 0)
            ii = next((k for k, e in enumerate(entries) if e[1]["kind"] == "instruction"), 1)
            default_pair = [entry_variant[ti], entry_variant[ii]]
            min_sim = None
        else:
            default_pair = [entry_variant[worst[0]], entry_variant[worst[1]]]
            min_sim = worst[2]

        # Redline every same-kind variant pair (variants, not documents, so a
        # text shared by ten documents is diffed once).
        pairs = []
        for i in range(len(variants)):
            for j in range(i + 1, len(variants)):
                va, vb = variants[i], variants[j]
                if va["kind"] != vb["kind"]:
                    continue
                pairs.append({
                    "a": i, "b": j,
                    "similarity": round(similarity(va["text"], vb["text"]), 4),
                    "rows": diff_paragraph_blocks(va["text"], vb["text"]),
                })

        section = entries[0][1]["section"]
        instr = []
        for doc, _, instructions in entries:
            for ins in instructions:
                if section in ins["refs"]:
                    instr.append({"doc": doc["id"], "num": ins["num"], "text": ins["text"]})

        for v in variants:
            del v["_norm"]

        conflicts.append({
            "key": key,
            "section": section,
            "path": entries[0][1]["path"],
            "title": next((u["sectionTitle"] for _, u, _ in entries if u["sectionTitle"]), ""),
            "docs": [d["id"] for d, _, _ in entries],
            "variantCount": len(variants),
            "formsDiffer": forms_differ,
            "formOnly": form_only,
            "hasElision": any(u["hasElision"] for _, u, _ in entries),
            "minSimilarity": None if min_sim is None else round(min_sim, 4),
            "defaultPair": default_pair,
            "variants": variants,
            "pairs": pairs,
            "instructions": instr,
        })

    conflicts.sort(key=lambda c: (_section_sort_key(c["section"]), c["path"]))
    for i, c in enumerate(conflicts):
        c["id"] = i

    conflict_count: dict[int, int] = {}
    for c in conflicts:
        for d in set(c["docs"]):
            conflict_count[d] = conflict_count.get(d, 0) + 1
    for d in documents:
        d["conflicts"] = conflict_count.get(d["id"], 0)

    return {
        "schema": SCHEMA,
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "tool": "folder_compare.py",
        "folder": str(folder.resolve()),
        "recursive": recursive,
        "elapsedSeconds": round(time.time() - started, 2),
        "documents": documents,
        "stats": {
            "documents": len(documents),
            "readable": len(parsed),
            "failed": len(documents) - len(parsed),
            "shared": len(index) - unique_to_one,
            "conflicts": len(conflicts),
            "sectionsAffected": len({c["section"] for c in conflicts}),
            "agreeing": agreeing,
            "uniqueToOne": unique_to_one,
            "formOnly": sum(1 for c in conflicts if c["formOnly"]),
        },
        "conflicts": conflicts,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Tabular export — one row per redline
# ─────────────────────────────────────────────────────────────────────────────

def _tags(dataset: dict, ids: list[int]) -> str:
    by_id = {d["id"]: d for d in dataset["documents"]}
    return ", ".join(f"{by_id[i]['tag']} ({by_id[i]['name']})" for i in ids)


def redline_rows(dataset: dict):
    """Yield one flat record per redline: every same-kind variant pair, plus
    one record per text-vs-instruction pairing (shown side by side, not diffed)."""
    for c in dataset["conflicts"]:
        instr = " | ".join(f"{doc_tag(x['doc'])}: {x['text']}" for x in c["instructions"])
        base = {
            "conflict_id": c["id"], "section": c["section"], "subsection": c["path"] or "(section body)",
            "section_title": c["title"], "variant_count": c["variantCount"],
            "elision": "yes" if c["hasElision"] else "", "instructions": instr,
        }
        vs = c["variants"]
        for p in c["pairs"]:
            va, vb = vs[p["a"]], vs[p["b"]]
            yield {**base, "comparison": va["kind"],
                   "variant_a": p["a"] + 1, "docs_a": _tags(dataset, va["docs"]),
                   "variant_b": p["b"] + 1, "docs_b": _tags(dataset, vb["docs"]),
                   "similarity": p["similarity"], "rows": p["rows"],
                   "text_a": va["text"], "text_b": vb["text"]}
        for i, va in enumerate(vs):
            for j, vb in enumerate(vs):
                if i < j and va["kind"] != vb["kind"]:
                    yield {**base, "comparison": "form differs",
                           "variant_a": i + 1, "docs_a": _tags(dataset, va["docs"]),
                           "variant_b": j + 1, "docs_b": _tags(dataset, vb["docs"]),
                           "similarity": None, "rows": None,
                           "text_a": va["text"], "text_b": vb["text"]}


def rows_to_markup(rows) -> str:
    if rows is None:
        return "(different forms — amendatory text vs. instruction; not redlined)"
    parts = []
    for r in rows:
        if r["t"] == "omit":
            parts.append(f"[… {r['n']} unchanged paragraph{'s' if r['n'] != 1 else ''} …]")
        else:
            parts.append("".join(t if op == "=" else f"[-{t}-]" if op == "-" else f"{{+{t}+}}"
                                 for op, t in r["ops"]))
    return "\n".join(parts)


CSV_COLUMNS = ["conflict_id", "section", "subsection", "section_title", "comparison",
               "variant_a", "docs_a", "variant_b", "docs_b", "similarity", "variant_count",
               "elision", "redline", "text_a", "text_b", "instructions"]


def write_csv(dataset: dict, path: Path) -> int:
    n = 0
    with open(path, "w", newline="", encoding="utf-8-sig") as f:      # BOM so Excel reads UTF-8
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        for r in redline_rows(dataset):
            w.writerow({**{k: r.get(k, "") for k in CSV_COLUMNS},
                        "similarity": "" if r["similarity"] is None else f"{r['similarity']:.2f}",
                        "redline": rows_to_markup(r["rows"])})
            n += 1
    return n


def write_xlsx(dataset: dict, path: Path) -> int:
    from openpyxl import Workbook
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
    from openpyxl.cell.rich_text import CellRichText, TextBlock
    from openpyxl.cell.text import InlineFont
    from openpyxl.styles import Alignment, Font, PatternFill

    LIMIT = 32000                           # Excel caps a cell at 32,767 chars
    clean = lambda s: ILLEGAL_CHARACTERS_RE.sub("", s or "")
    f_del = InlineFont(strike=True, color="FFA01A1A")
    f_ins = InlineFont(u="single", color="FF1A7A3A")
    f_omit = InlineFont(i=True, color="FF888888")

    def rich(rows):
        if rows is None:
            return rows_to_markup(None)
        blocks, used = [], 0

        def add(text, font=None):
            nonlocal used
            text = clean(text)
            if used >= LIMIT or not text:
                return
            text = text[:LIMIT - used]
            used += len(text)
            blocks.append(TextBlock(font, text) if font else text)

        for k, r in enumerate(rows):
            if k:
                add("\n")
            if r["t"] == "omit":
                add(f"[… {r['n']} unchanged paragraph{'s' if r['n'] != 1 else ''} …]", f_omit)
            else:
                for op, t in r["ops"]:
                    add(t, None if op == "=" else f_del if op == "-" else f_ins)
        if used >= LIMIT:
            blocks.append(TextBlock(f_omit, " … [truncated — full redline in the .json]"))
        return CellRichText(blocks)

    wb = Workbook()
    ws = wb.active
    ws.title = "Conflicts"
    header = ["ID", "Section", "Subsection", "Section title", "Comparison",
              "Variant A", "Documents A", "Variant B", "Documents B", "Similarity",
              "Variants", "Elision", "Redline (A → B)", "Text A", "Text B", "Instructions"]
    ws.append(header)
    n = 0
    for r in redline_rows(dataset):
        ws.append([r["conflict_id"], r["section"], r["subsection"], clean(r["section_title"]),
                   r["comparison"], r["variant_a"], clean(r["docs_a"]), r["variant_b"],
                   clean(r["docs_b"]), r["similarity"], r["variant_count"], r["elision"],
                   None, clean(r["text_a"])[:LIMIT], clean(r["text_b"])[:LIMIT],
                   clean(r["instructions"])[:LIMIT]])
        ws.cell(row=ws.max_row, column=13).value = rich(r["rows"])
        n += 1

    widths = [6, 10, 14, 30, 13, 9, 28, 9, 28, 10, 8, 8, 90, 50, 50, 50]
    for i, wdt in enumerate(widths, start=1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = wdt
    head_fill = PatternFill("solid", fgColor="FF1A1A2E")
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFFFF")
        c.fill = head_fill
    wrap = Alignment(wrap_text=True, vertical="top")
    for row in ws.iter_rows(min_row=2):
        for c in row:
            c.alignment = wrap
        row[9].number_format = "0%"
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = ws.dimensions

    ds = wb.create_sheet("Documents")
    ds.append(["Tag", "File", "Subsections", "Sections", "Instructions",
               "Instruction-only", "Conflicts", "Error"])
    for d in dataset["documents"]:
        ds.append([d["tag"], d["relPath"], d.get("units"), d.get("sections"), d.get("instructions"),
                   d.get("instructionOnly"), d.get("conflicts"), d["error"] or ""])
    for i, wdt in enumerate([6, 50, 12, 10, 12, 16, 10, 50], start=1):
        ds.column_dimensions[ds.cell(row=1, column=i).column_letter].width = wdt
    for c in ds[1]:
        c.font = Font(bold=True, color="FFFFFFFF")
        c.fill = head_fill

    ss = wb.create_sheet("Summary")
    for k, v in [("Folder", dataset["folder"]), ("Generated", dataset["generatedAt"]),
                 *[(k, v) for k, v in dataset["stats"].items()]]:
        ss.append([k, v])
    ss.column_dimensions["A"].width = 20
    ss.column_dimensions["B"].width = 80

    wb.save(path)
    return n


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Compare every .docx amendment document in a folder and write a "
                    "dataset of conflicting subsections with redlines.")
    ap.add_argument("folder", type=Path, help="folder containing .docx files")
    ap.add_argument("-o", "--out-dir", type=Path, help="where to write outputs (default: the folder)")
    ap.add_argument("--name", default="regdiff-folder", help="output file base name")
    ap.add_argument("-r", "--recursive", action="store_true", help="include subfolders")
    ap.add_argument("--no-csv", action="store_true", help="skip the .csv output")
    ap.add_argument("--no-xlsx", action="store_true", help="skip the .xlsx output")
    ap.add_argument("-q", "--quiet", action="store_true", help="only print output paths")
    args = ap.parse_args(argv)

    folder = args.folder
    if not folder.is_dir():
        print(f"error: {folder} is not a folder", file=sys.stderr)
        return 2
    log = (lambda *_: None) if args.quiet else print

    log(f"Scanning {folder.resolve()}{' (recursive)' if args.recursive else ''}")
    dataset = analyze_folder(folder, args.recursive, log)
    s = dataset["stats"]
    if s["documents"] == 0:
        print("error: no .docx files found", file=sys.stderr)
        return 1
    log(f"\n{s['readable']} readable document(s), {s['failed']} failed · "
        f"{s['shared']} shared subsection(s) · {s['conflicts']} conflict(s) in "
        f"{s['sectionsAffected']} section(s) · {s['agreeing']} in agreement · "
        f"{dataset['elapsedSeconds']}s")
    if s["readable"] < 2:
        log("note: fewer than two readable documents — nothing to compare")

    out = args.out_dir or folder
    out.mkdir(parents=True, exist_ok=True)

    json_path = out / f"{args.name}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(dataset, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {json_path}")

    if not args.no_csv:
        p = out / f"{args.name}.csv"
        n = write_csv(dataset, p)
        print(f"wrote {p} ({n} rows)")

    if not args.no_xlsx:
        try:
            import openpyxl  # noqa: F401
        except ImportError:
            log("skipped .xlsx (openpyxl not installed: pip install openpyxl)")
        else:
            p = out / f"{args.name}.xlsx"
            try:
                n = write_xlsx(dataset, p)
                print(f"wrote {p} ({n} rows)")
            except PermissionError:
                print(f"error: could not write {p} — is it open in Excel?", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
