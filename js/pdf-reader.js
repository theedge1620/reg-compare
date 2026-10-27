// RuleCheck — PDF text extraction (pdf.js, loaded on demand) and paragraph reconstruction.

// ─────────────────────────────────────────────────────────────────────────────
// PDF — text lines → paragraphs
// ─────────────────────────────────────────────────────────────────────────────
//
// pdf.js (loaded from cdnjs the first time a PDF is opened) supplies positioned
// text fragments. They are grouped into lines by baseline, running headers and
// page numbers are dropped, and lines are joined into paragraphs using the
// layout: a wider gap, a first-line indent, or a short previous line starts a
// new paragraph, as does a designator, "§" heading or "* * *" after a line that
// ends a sentence. A PDF prints the page as it looks, so a draft printed with
// tracked changes showing will include the deleted text.

const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsPromise = null;

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_BASE + 'pdf.min.js';
      s.onload = () => {
        const lib = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
        if (!lib) { reject(new Error('The PDF reader (pdf.js) did not load correctly.')); return; }
        lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
        resolve(lib);
      };
      s.onerror = () => reject(new Error('Could not load the PDF reader (pdf.js) from cdnjs.cloudflare.com — check the internet connection.'));
      document.head.appendChild(s);
    }).catch(e => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

// Text fragments of one page → lines, top to bottom:
//   { text, x, right, y, size }
function pdfPageLines(items) {
  const frags = items
    .filter(it => it.str && it.transform)
    .map(it => {
      const [a, b, , , x, y] = it.transform;
      return { str: it.str, x, y, w: it.width || 0, size: Math.hypot(a, b) || it.height || 10 };
    })
    .sort((p, q) => q.y - p.y || p.x - q.x);

  const lines = [];
  for (const f of frags) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - f.y) <= Math.max(line.size, f.size) * 0.4) line.frags.push(f);
    else lines.push({ y: f.y, size: f.size, frags: [f] });
  }

  return lines.map(line => {
    line.frags.sort((p, q) => p.x - q.x);
    let text = '';
    let prevEnd = null;
    for (const f of line.frags) {
      if (prevEnd !== null && f.x - prevEnd > line.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(f.str)) text += ' ';
      text += f.str;
      prevEnd = f.x + f.w;
    }
    return {
      text: text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim(),
      x: line.frags[0].x,
      right: Math.max(...line.frags.map(f => f.x + f.w)),
      y: line.y,
      size: Math.max(...line.frags.map(f => f.size)),
    };
  }).filter(l => l.text);
}

// Drop running headers/footers: lines in the top or bottom two of a page that
// repeat (ignoring numbers) on at least half the pages, and bare page numbers.
const PAGE_NUMBER_RE = /^(?:page\s*)?#(?:\s*of\s*#)?$|^[-–—]\s*#\s*[-–—]$/i;

function dropRunningHeads(pages) {
  const key = l => l.text.replace(/\d+/g, '#').toLowerCase();
  const edge = lines => new Set([...lines.slice(0, 2), ...lines.slice(-2)]);
  const counts = new Map();
  for (const lines of pages) {
    for (const k of new Set([...edge(lines)].map(key))) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const repeated = Math.max(2, Math.ceil(pages.length / 2));
  return pages.map(lines => {
    const ends = edge(lines);
    return lines.filter(l => !ends.has(l)
      || !(PAGE_NUMBER_RE.test(key(l)) || (pages.length > 2 && counts.get(key(l)) >= repeated)));
  });
}

// A line that opens a structural element when the previous line ended a sentence.
const PDF_BLOCK_START_RE = /^(?:\([a-zA-Z0-9]{1,5}\)|§|\*\s*\*\s*\*|(?:\d{1,3}|X{1,3}|x{2,3}|[a-z])\.\s|PART\s+\d|Subpart\s|Appendix\s)/;

function pdfLinesToParagraphs(pages) {
  const all = pages.flatMap((lines, page) => lines.map(l => ({ ...l, page })));
  if (!all.length) return [];

  // Typical line pitch, and the right edge a full line reaches.
  const gaps = [];
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i];
    const d = a.y - b.y;
    if (a.page === b.page && d > 0 && d < a.size * 3) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const spacing = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const rights = all.map(l => l.right).sort((a, b) => a - b);
  const rightMargin = rights[Math.floor(rights.length * 0.9)];
  // Left edge of continuation lines: the most common line start.
  const starts = new Map();
  for (const l of all) starts.set(Math.round(l.x), (starts.get(Math.round(l.x)) || 0) + 1);
  const bodyLeft = [...starts].sort((a, b) => b[1] - a[1])[0][0];

  const paras = [];
  let cur = null;
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    const prev = all[i - 1];
    let fresh = cur === null || (prev.page === l.page && spacing && prev.y - l.y > spacing * 1.35);
    if (!fresh) {
      // A paragraph can only end where a sentence or list item ends.
      const ended = /[.:;!?\]]["”’)]?$|\*$|[—–-]$|;\s+(?:and|or)$/.test(prev.text);
      // The previous line stopped well short: this line's first word would have
      // fitted with room to spare (non-breaking spaces make Word wrap early).
      const short = prev.right + (l.text.split(' ')[0].length + 4) * l.size * 0.5 < rightMargin;
      const indented = l.x > prev.x + l.size * 0.8 || l.x > bodyLeft + l.size * 0.8;
      const block = PDF_BLOCK_START_RE.test(l.text);
      // After a line that ends mid-sentence, a designator at the left margin is
      // usually a wrapped reference ("paragraphs / (a)(1) and (a)(2)"); only a
      // line that stops far short (an unpunctuated heading) ends there.
      fresh = ended
        ? (indented || short || block)
        : (short && (indented || (block && prev.right < rightMargin - l.size * 8)));
    }
    if (fresh) {
      if (cur !== null) paras.push(cur);
      cur = l.text;
    } else {
      cur += /-$/.test(cur) ? l.text : ' ' + l.text;
    }
  }
  if (cur !== null) paras.push(cur);
  return paras;
}

async function readPdfParagraphs(file) {
  const pdfjsLib = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    pages.push(pdfPageLines((await page.getTextContent()).items));
  }
  return pdfLinesToParagraphs(dropRunningHeads(pages));
}
