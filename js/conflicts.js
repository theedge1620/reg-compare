// RuleCheck — Cross-document conflict detection (ported in folder_compare.py).

// ─────────────────────────────────────────────────────────────────────────────
// Cross-document conflict detection
// ─────────────────────────────────────────────────────────────────────────────

// Comparison key: ignores case, whitespace and smart-quote/dash styling so that
// pure formatting differences are not reported as conflicts.
function normForCompare(s) {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Word-overlap similarity, 0 → nothing in common, 1 → identical bag of words.
function similarity(a, b) {
  const ta = normForCompare(a).match(/[\w'-]+/g) || [];
  const tb = normForCompare(b).match(/[\w'-]+/g) || [];
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  const counts = new Map();
  for (const t of ta) counts.set(t, (counts.get(t) || 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(t);
    if (c) { common++; counts.set(t, c - 1); }
  }
  return (2 * common) / (ta.length + tb.length);
}

// Natural ordering for section numbers: 2.9 sorts before 2.10.
function compareSectionNumbers(a, b) {
  const pa = a.split('.'), pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? '', sb = pb[i] ?? '';
    const na = parseInt(sa, 10), nb = parseInt(sb, 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      if (sa !== sb) return sa < sb ? -1 : 1;
    } else if (na !== nb) {
      return na - nb;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1; // "55" vs "55a"
    }
  }
  return 0;
}

// Order units by section, then by subsection path.
function compareUnits(a, b) {
  return compareSectionNumbers(a.section, b.section) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// Returns { conflicts[], stats{} } for the currently loaded documents.
//
// Units are keyed "section|path", so a subsection is only ever matched against
// the same subsection of the same section — never across sections.
function analyzeDocuments(docs) {
  const index = new Map(); // "section|path" → [{ doc, unit }]
  for (const doc of docs) {
    for (const [key, unit] of doc.units) {
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ doc, unit });
    }
  }

  const conflicts = [];
  let uniqueToOne = 0, agreeing = 0;

  for (const [key, entries] of index) {
    if (entries.length < 2) { uniqueToOne++; continue; }

    // Distinct text variants across the documents holding this subsection.
    // Texts differing only in formatting count as the same variant.
    const variants = new Map(); // substantive key → [entry, …]
    for (const e of entries) {
      const n = substantiveKey(e.unit.text);
      if (!variants.has(n)) variants.set(n, []);
      variants.get(n).push(e);
    }

    // One document may spell the subsection out while another gives only the
    // instruction. That is a real difference between the drafts, but the two
    // are different kinds of prose, so they are never diffed against each other.
    const kinds = new Set(entries.map(e => e.unit.kind));
    const formsDiffer = kinds.size > 1;

    if (variants.size < 2) { agreeing++; continue; }

    // Most divergent pair — used for ranking and as the default redline pair.
    // Restricted to same-kind pairs so a text-vs-instruction mismatch cannot
    // masquerade as a total rewrite.
    let worst = null;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[i].unit.kind !== entries[j].unit.kind) continue;
        if (substantiveKey(entries[i].unit.text) === substantiveKey(entries[j].unit.text)) continue;
        const sim = similarity(entries[i].unit.text, entries[j].unit.text);
        if (!worst || sim < worst.sim) worst = { a: i, b: j, sim };
      }
    }

    // No same-kind pair disagrees — the only difference is how the drafts
    // express this subsection. Rank it as similar so it does not crowd the top
    // of the "most divergent" list; the badge explains what it is.
    const formOnly = !worst;
    if (formOnly) {
      const a = entries.findIndex(e => e.unit.kind === 'text');
      const b = entries.findIndex(e => e.unit.kind === 'instruction');
      worst = { a: a === -1 ? 0 : a, b: b === -1 ? 1 : b, sim: 1 };
    }

    const section = entries[0].unit.section;

    conflicts.push({
      key,
      section,
      path: entries[0].unit.path,
      pathLabel: entries[0].unit.pathLabel || entries[0].unit.path,
      title: entries.find(e => e.unit.sectionTitle)?.unit.sectionTitle || '',
      entries,
      variantCount: variants.size,
      formsDiffer,
      formOnly,
      hasElision: entries.some(e => e.unit.hasElision),
      // Instructions are regulation *metadata*, so they are surfaced only for
      // the section this conflict belongs to — per document.
      instructions: entries.map(e => ({
        doc: e.doc,
        list: (e.doc.instructions || []).filter(ins => ins.refs.includes(section)),
      })).filter(x => x.list.length),
      worst: worst || { a: 0, b: 1, sim: 0 },
    });
  }

  // One instruction aimed at several paragraphs ("in paragraphs (a) and (c),
  // remove …") yields the identical comparison at each of them; list it once,
  // labelled with every paragraph. Decided in section order so the result does
  // not depend on document order.
  const merged = [];
  const bySignature = new Map();
  for (const c of [...conflicts].sort(compareUnits)) {
    if (c.entries.every(e => e.unit.kind === 'instruction')) {
      const sig = c.section + '\u0000'
        + c.entries.map(e => `${e.doc.id}:${substantiveKey(e.unit.text)}`).join('\u0000');
      const first = bySignature.get(sig);
      if (first) {
        first.pathLabel = `${first.pathLabel || 'section body'}, ${c.pathLabel || 'section body'}`;
        continue;
      }
      bySignature.set(sig, c);
    }
    merged.push(c);
  }
  conflicts.length = 0;
  conflicts.push(...merged);

  const sectionsTouched = new Set(conflicts.map(c => c.section));

  return {
    conflicts,
    stats: {
      docs: docs.length,
      common: index.size - uniqueToOne,
      conflicts: conflicts.length,
      sections: sectionsTouched.size,
      agreeing,
      uniqueToOne,
    },
  };
}
