// RuleCheck — eCFR versioner API: Title 10 section list, section and appendix XML.

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — eCFR API: Title 10 section list, section and appendix XML
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

// One section's XML; ecfr-redline.js parses it into paragraph units.
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
