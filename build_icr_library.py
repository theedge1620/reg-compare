#!/usr/bin/env python3
"""
build_icr_library.py — RuleCheck information-collection library.

Compiles the list of 10 CFR sections that contain information collection
requirements from the regulation library (data/paragraphs.jsonl), and packages
those sections' current text for the "Info Collections" tab of index.html.

    python build_icr_library.py [--library data/paragraphs.jsonl] [-o data]

Writes:
    icr-sections.json   the compiled list: each section's part, title, OMB
                        control numbers and the OMB-approval paragraph listing it
    icr-sections.csv    the same list, one row per section, for spreadsheets
    icr-library.js      the list plus each section's text, loaded by the page
                        (a .js file because a page opened from disk cannot
                        fetch .json)

Source of truth: each part's "Information collection requirements: OMB
approval" section (§ 50.8, § 30.8, … § 51.17) lists the sections whose
information collections OMB has approved —
    "(b) The approved information collection requirements contained in this
     part appear in §§ 50.12, 50.30, … and appendices A, B, … to this part."
— with "X through Y" ranges, and supplementary items with their own control
numbers: "(1) In § 50.73, NRC Form 366 is approved under control number
3150-0104." Parts whose OMB section says they contain none are reported.

Section titles come from the eCFR Title 10 structure via folder_compare.py
(cached; use --no-ecfr to skip). They let the page recognise definitions
sections; everything else works without them.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA = "rulecheck-icr/1"

# "… information collection requirements contained in this part appear in §§ …"
LISTING_RE = re.compile(r"information collection requirements (?:contained )?in this part appear in\s+(.*)$", re.I)
NONE_RE = re.compile(r"contains no information collection requirements|clearance is not required", re.I)
CONTROL_RE = re.compile(r"\b\d{4}-\d{4}\b")
SECTION_NUM_RE = re.compile(r"\b(\d+\.\d+[a-z]*)")
# "(1) In § 50.73, NRC Form 366 is approved under control number 3150-0104."
SUPPLEMENT_RE = re.compile(r"^(?:\([a-z0-9]+\)\s*)*In\s+(?:§|appendix)", re.I)
APPROVED_RE = re.compile(r"\b(?:is|are)\s+approved\s+under\s+control\s+numbers?\b", re.I)
APPENDIX_LIST_RE = re.compile(r"\bappendi(?:x|ces)\s+((?:[A-Z]{1,2}(?:\s*,\s*|\s*,?\s*and\s+|\s*))+?)\s*to\s+this\s+part", re.I)

# The eCFR prints a headed paragraph and its first child as one paragraph —
# "(c) Filings after the deadline …—(1) Determination by presiding officer. …".
# Drafts put "(1)" on its own line, so split these (the library has lost the
# italics that mark the heading, so the split is on the dash or full stop
# that ends it, followed by a designator and a capital).
INLINE_CHILD_RE = re.compile(
    r"^((?:\([A-Za-z0-9]{1,5}\))+\s+[^()]{2,300}?)\s*(?:—|–|(?<=\.)\s)\s*"
    r"(\((?:[a-z]{1,4}|\d{1,3}|[A-Z])\)\s+[A-Z“\"].*)$")


def section_key(number: str):
    """Sort key for "50.34a": (50, 34, 'a')."""
    m = re.match(r"(\d+)\.(\d+)([a-z]*)", number)
    return (int(m.group(1)), int(m.group(2)), m.group(3)) if m else (10**9, 0, number)


def split_inline_children(text: str) -> list[str]:
    out = []
    while True:
        m = INLINE_CHILD_RE.match(text)
        if not m:
            out.append(text)
            return out
        out.append(m.group(1))
        text = m.group(2)


def load_library(path: Path):
    """unit_key → rows (sorted by seq) for sections; part → appendix letters."""
    sections, appendices, snapshot = defaultdict(list), defaultdict(set), None
    with path.open(encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            snapshot = snapshot or r.get("snapshot_date")
            if r["unit_type"] == "section":
                sections[r["unit_key"]].append(r)
            elif r["unit_type"] == "appendix":
                m = re.match(r"(\d+)-app([A-Z0-9]+)", r["unit_key"])
                if m:
                    appendices[m.group(1)].add(m.group(2))
    for rows in sections.values():
        rows.sort(key=lambda r: r["seq"])
    return sections, appendices, snapshot


def expand_listing(clause: str, part: str, known: list[str]):
    """Section numbers named in a listing clause, with "X through Y" ranges
    expanded to the library's sections between them."""
    found, last, pending_range = [], None, False
    for m in re.finditer(r"(\d+\.\d+[a-z]*)|\bthrough\b", clause):
        if m.group(1) is None:
            pending_range = last is not None
            continue
        num = m.group(1)
        if pending_range:
            lo, hi = section_key(last), section_key(num)
            found += [k for k in known if k.split(".")[0] == part and lo < section_key(k) <= hi]
            pending_range = False
        else:
            found.append(num)
        last = num
    return found


def appendix_letters(clause: str) -> list[str]:
    letters = []
    for m in APPENDIX_LIST_RE.finditer(clause):
        letters += re.findall(r"\b[A-Z]{1,2}\b", m.group(1))
    return letters


def compile_icr(sections, appendices):
    known = sorted(sections, key=section_key)
    parts, by_section, unlisted = {}, defaultdict(lambda: {"controls": [], "listedIn": []}), {}

    for omb, rows in sections.items():
        texts = [(r["path"], r["text"]) for r in rows]
        part = omb.split(".")[0]
        if not any(LISTING_RE.search(t) for _, t in texts):
            if any(NONE_RE.search(t) for _, t in texts) and re.search(r"information collection", texts[0][1], re.I):
                unlisted[part] = {"ombSection": omb, "statement": texts[0][1]}
            continue

        # Part-wide control numbers: the paragraph saying OMB approved them.
        part_controls = []
        for _, t in texts:
            if re.search(r"OMB has approved|approved .* under control number", t) and not SUPPLEMENT_RE.match(t):
                part_controls += [c for c in CONTROL_RE.findall(t) if c not in part_controls]

        listed, apps = [], []
        for path, t in texts:
            m = LISTING_RE.search(t)
            if m:
                listed += expand_listing(m.group(1), part, known)
                apps += appendix_letters(m.group(1))
                src = f"{omb}{path}"
        for num in dict.fromkeys(listed):
            entry = by_section[num]
            entry["listedIn"].append(src)
            for c in part_controls:
                entry["controls"].append({"number": c, "what": f"part {part} information collections", "source": f"{omb}(a)"})

        # Supplementary items with their own control numbers.
        for path, t in texts:
            if not (SUPPLEMENT_RE.match(t) and APPROVED_RE.search(t)):
                continue
            head, tail = t[:APPROVED_RE.search(t).start()], t[APPROVED_RE.search(t).start():]
            what = re.split(r"(?:\d+\.\d+[a-z]*(?:\([^)]*\))*|appendix [A-Z]+ to 10 CFR part \d+)\s*[,.]?\s*", head)[-1].strip(" ,.")
            for num in dict.fromkeys(SECTION_NUM_RE.findall(head)):
                for c in CONTROL_RE.findall(tail):
                    by_section[num]["controls"].append({"number": c, "what": what, "source": f"{omb}{path}"})
                if f"{omb}{path}" not in by_section[num]["listedIn"]:
                    by_section[num]["listedIn"].append(f"{omb}{path}")

        parts[part] = {
            "ombSection": omb,
            "controlNumbers": part_controls,
            "sections": sorted(dict.fromkeys(listed), key=section_key),
            "appendices": [a for a in dict.fromkeys(apps)],
            "appendicesInLibrary": [a for a in dict.fromkeys(apps) if a in appendices.get(part, set())],
        }
    return parts, by_section, unlisted


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Compile the 10 CFR information-collection section list for RuleCheck.")
    ap.add_argument("--library", default=str(HERE / "data" / "paragraphs.jsonl"), help="regulation library (.jsonl)")
    ap.add_argument("-o", "--out-dir", default=str(HERE / "data"), help="where to write the outputs")
    ap.add_argument("--no-ecfr", action="store_true", help="skip fetching section titles from the eCFR")
    args = ap.parse_args(argv)

    library = Path(args.library)
    if not library.is_file():
        print(f"error: library not found: {library}", file=sys.stderr)
        return 1
    sections, appendices, snapshot = load_library(library)
    parts, by_section, unlisted = compile_icr(sections, appendices)

    titles, title_info = {}, None
    if not args.no_ecfr:
        try:
            sys.path.insert(0, str(HERE))
            from folder_compare import load_title10_sections
            titles, title_info = load_title10_sections(log=lambda m: print(m, file=sys.stderr))
            titles = titles or {}
        except Exception as e:                       # titles are optional
            print(f"note: section titles unavailable ({e})", file=sys.stderr)

    out_sections, missing = {}, []
    for num in sorted(by_section, key=section_key):
        rows = sections.get(num)
        if not rows:
            missing.append(num)
            continue
        title = titles.get(num, "")
        paras = [f"§ {num} {title}".strip()]
        for r in rows:
            t = re.sub(r"\s+", " ", r["text"]).strip()
            if t:
                paras += split_inline_children(t)
        e = by_section[num]
        out_sections[num] = {
            "part": num.split(".")[0],
            "title": title,
            "listedIn": e["listedIn"],
            "controls": e["controls"],
            "paras": paras,
        }

    built = datetime.now(timezone.utc).isoformat(timespec="seconds")
    meta = {
        "schema": SCHEMA,
        "built": built,
        "library": library.name,
        "snapshot": snapshot,
        "titles": title_info,
        "parts": parts,
        "partsWithoutCollections": unlisted,
        "listedButNotInLibrary": missing,
    }
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    listing = {**meta, "sections": {k: {kk: vv for kk, vv in v.items() if kk != "paras"} for k, v in out_sections.items()}}
    (out / "icr-sections.json").write_text(json.dumps(listing, ensure_ascii=False, indent=1), encoding="utf-8")

    with (out / "icr-sections.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["section", "part", "title", "control numbers", "collections", "listed in"])
        for k, v in out_sections.items():
            w.writerow([k, v["part"], v["title"],
                        "; ".join(dict.fromkeys(c["number"] for c in v["controls"])),
                        "; ".join(f'{c["what"]} ({c["number"]})' for c in v["controls"] if not c["what"].startswith("part ")),
                        "; ".join(v["listedIn"])])

    payload = json.dumps({**meta, "sections": out_sections}, ensure_ascii=False, separators=(",", ":"))
    (out / "icr-library.js").write_text(
        "// Generated by build_icr_library.py — do not edit. Information-collection sections of 10 CFR\n"
        f"// and their text, from {library.name} (snapshot {snapshot}).\n"
        f"window.RULECHECK_ICR = {payload};\n", encoding="utf-8")

    print(f"{len(out_sections)} sections with information collection requirements across {len(parts)} parts "
          f"(library snapshot {snapshot})")
    if unlisted:
        print(f"parts stating they have none or are exempt: {', '.join(sorted(unlisted, key=int))}")
    if missing:
        print(f"listed but not in the library (removed or reserved?): {', '.join(missing)}")
    for name in ("icr-sections.json", "icr-sections.csv", "icr-library.js"):
        print(f"wrote {out / name}  ({(out / name).stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
