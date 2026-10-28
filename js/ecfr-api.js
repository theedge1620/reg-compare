// RuleCheck — eCFR versioner API: Title 10 section list, section XML, paragraph maps.

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — eCFR API: fetch section and parse into paragraph map
// ─────────────────────────────────────────────────────────────────────────────
//
// Endpoints (confirmed live):
//   GET /api/versioner/v1/titles.json          → up_to_date_as_of per title
//   GET /api/versioner/v1/full/{date}/title-10.xml?part={P}&section={P.S}
//                                              → processed section XML

let _title10Date = null;

async function getTitle10Date() {
  if (_title10Date) return _title10Date;
  try {
    const r = await fetch('https://www.ecfr.gov/api/versioner/v1/titles.json');
    if (!r.ok) throw new Error(r.status);
    const d = await r.json();
    const t = d.titles.find(t => t.number === 10);
    if (t?.up_to_date_as_of) { _title10Date = t.up_to_date_as_of; return _title10Date; }
  } catch(e) { console.warn('titles.json failed:', e); }
  _title10Date = '2026-04-14';
  return _title10Date;
}

// ── Title 10 section list ───────────────────────────────────────────────────
//
//   GET /api/versioner/v1/structure/{date}/title-10.json
//       → the full hierarchy; every node of type "section" carries its
//         identifier ("50.55a") and heading (label_description).
//
// Used to tell a real section heading that lost its "§" ("2.326 Motions to
// reopen.") from a number that merely starts a line ("0.001 rem …"). The list
// is cached in localStorage per eCFR date; if the eCFR can't be reached, the
// last cached list is used, and failing that, none.
// folder_compare.py's load_title10_sections() does the same — keep in step.

const T10_CACHE_KEY = 'regdiff.title10Sections.v1';
const SECTION_ID_RE = /^\d+[A-Za-z]?(?:\.\d+[A-Za-z]*)*$/;   // skips ranges like "1.40-1.41"
let _title10Sections = null;   // Promise<{ map: Map|null, date, source }>

function readTitle10Cache() {
  try { return JSON.parse(localStorage.getItem(T10_CACHE_KEY) || 'null'); } catch { return null; }
}

function writeTitle10Cache(value) {
  try { localStorage.setItem(T10_CACHE_KEY, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

function title10SectionsFromStructure(root) {
  const sections = {};
  (function walk(node) {
    if (node.type === 'section' && SECTION_ID_RE.test(node.identifier || '')) {
      sections[node.identifier] = node.label_description || '';
    }
    for (const child of node.children || []) walk(child);
  })(root);
  return sections;
}

function getTitle10Sections() {
  if (_title10Sections) return _title10Sections;
  _title10Sections = (async () => {
    const cached = readTitle10Cache();
    try {
      const date = await getTitle10Date();
      if (cached && cached.date === date && cached.sections) {
        return { map: new Map(Object.entries(cached.sections)), date, source: 'cache' };
      }
      const r = await fetch(`https://www.ecfr.gov/api/versioner/v1/structure/${date}/title-10.json`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const sections = title10SectionsFromStructure(await r.json());
      writeTitle10Cache({ date, sections });
      return { map: new Map(Object.entries(sections)), date, source: 'eCFR' };
    } catch (e) {
      console.warn('eCFR Title 10 section list unavailable:', e);
      if (cached && cached.sections) {
        return { map: new Map(Object.entries(cached.sections)), date: cached.date, source: 'stale cache' };
      }
      return { map: null, date: null, source: null };
    }
  })();
  return _title10Sections;
}

// One-line description of which section list was used, for status bars.
function title10Note(info) {
  if (!info) return '';
  if (!info.map) {
    return ' · eCFR section list unavailable, so an unmarked number counts as a section only when an instruction names it';
  }
  return ` · section numbers checked against eCFR Title 10 as of ${info.date}${info.source === 'stale cache' ? ' (cached; eCFR unreachable)' : ''}`;
}

// Returns a paragraph map: label → text, plus a special '_full_' key with raw text.
// Labels match paragraph designators like "(a)", "(b)(2)", etc.
async function fetchEcfrSectionXml(part, section) {
  const date = await getTitle10Date();
  const r = await fetch(`https://www.ecfr.gov/api/versioner/v1/full/${date}/title-10.xml?part=${part}&section=${section}`);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.text();
}

// An appendix is fetched by its eCFR name: ?part=52&appendix=Appendix D to Part 52
async function fetchEcfrAppendixXml(part, appendixId) {
  const date = await getTitle10Date();
  const r = await fetch(`https://www.ecfr.gov/api/versioner/v1/full/${date}/title-10.xml?part=${part}&appendix=${encodeURIComponent(appendixId)}`);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.text();
}

async function fetchEcfrParagraphMap(part, section) {
  try {
    const xml = await fetchEcfrSectionXml(part, section);
    return parseXmlIntoParagraphMap(xml, section);
  } catch(e) {
    console.warn(`eCFR fetch failed §${section}:`, e.message);
    return null;
  }
}

// Parse eCFR versioner XML into { label → text } map.
// Also stores '_full_' with the full section text for reference.
function parseXmlIntoParagraphMap(xmlText, sectionNum) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) return null;

  // Find the root section element
  let root = null;
  const sectno = doc.querySelector('SECTNO');
  if (sectno) {
    root = doc.documentElement;
  } else {
    const divs = doc.querySelectorAll('DIV8, DIV9, SECTION');
    for (const div of divs) {
      const n = (div.getAttribute('N') || '').replace(/[§\s]/g, '');
      if (n === sectionNum || n.endsWith(sectionNum)) { root = div; break; }
    }
    if (!root) root = doc.documentElement;
  }

  // Walk the children and collect paragraph elements tagged P, FP, FP-1, FP-2
  // Each P element may start with a paragraph designator like "(a)" in its text.
  const map = {};
  const allText = xmlToText(root).trim();
  map['_full_'] = allText;

  // Build label→text by scanning P/FP children for leading designators
  const pNodes = root.querySelectorAll('P, FP, FP-1, FP-2, FPTEXT');
  for (const p of pNodes) {
    const text = p.textContent.trim();
    const labelMatch = text.match(/^\(([a-z0-9]+)\)/i);
    if (labelMatch) {
      // Collect full designator
      const label = extractLeadingDesignator(text);
      if (label) map[label] = text;
    }
  }

  return map;
}

function extractLeadingDesignator(text) {
  let pos = 0;
  let label = '';
  const t = text.trim();
  while (pos < t.length && t[pos] === '(') {
    const close = t.indexOf(')', pos);
    if (close === -1) break;
    label += t.slice(pos, close + 1);
    pos = close + 1;
    if (pos >= t.length || t[pos] !== '(') break;
  }
  return label || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// eCFR XML → plain text (for full section display)
// ─────────────────────────────────────────────────────────────────────────────

function xmlToText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
  const tag = (node.tagName || '').toUpperCase();
  const ch = Array.from(node.childNodes).map(xmlToText).join('');
  const blocks = {
    'SECTNO':  t => `§ ${t.trim()}\n`,
    'SUBJECT': t => `${t.trim()}\n`,
    'HEAD':    t => `${t.trim()}\n`,
    'HD':      t => `\n${t.trim()}\n`,
    'P':       t => `\n${t.trim()}\n`,
    'FP':      t => `\n${t.trim()}\n`,
    'FP-1':    t => `\n    ${t.trim()}\n`,
    'FP-2':    t => `\n        ${t.trim()}\n`,
    'FPTEXT':  t => `\n${t.trim()}\n`,
    'NOTE':    t => `\n[Note: ${t.trim()}]\n`,
    'CITA':    t => `\n[${t.trim()}]\n`,
    'AUTH':    t => `\nAuthority: ${t.trim()}\n`,
    'SOURCE':  t => `\nSource: ${t.trim()}\n`,
    'STARS':   _  => '\n* * * * *\n',
    'E': t => t, 'SU': t => t, 'I': t => t,
  };
  return blocks[tag] ? blocks[tag](ch) : ch;
}
