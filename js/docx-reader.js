// RuleCheck — .docx reading: minimal ZIP reader and document.xml → paragraphs.

// ─────────────────────────────────────────────────────────────────────────────
// DOCX — minimal ZIP reader (no dependencies)
// ─────────────────────────────────────────────────────────────────────────────
//
// A .docx is a ZIP archive; the body text lives in word/document.xml. We locate
// that entry via the central directory and inflate it with the platform's
// DecompressionStream — no third-party unzip library required.

const ZIP_EOCD   = 0x06054b50; // end of central directory
const ZIP_CD     = 0x02014b50; // central directory file header
const ZIP_LOCAL  = 0x04034b50; // local file header
const ZIP64_LOC  = 0x07064b50; // zip64 EOCD locator
const ZIP64_EOCD = 0x06064b50; // zip64 end of central directory

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress .docx files (DecompressionStream is unavailable).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Read the 64-bit values out of a zip64 extended-information extra field.
// Fields appear in fixed order and only when their 32-bit counterpart is 0xffffffff.
function readZip64Extra(dv, start, len, need) {
  let p = start;
  const end = start + len;
  while (p + 4 <= end) {
    const id = dv.getUint16(p, true);
    const size = dv.getUint16(p + 2, true);
    if (id === 0x0001) {
      let q = p + 4;
      const out = {};
      for (const field of need) {
        if (q + 8 > p + 4 + size) break;
        out[field] = Number(dv.getBigUint64(q, true));
        q += 8;
      }
      return out;
    }
    p += 4 + size;
  }
  return {};
}

// Extract a single entry from a ZIP archive as a UTF-8 string.
async function readZipEntryText(buf, entryName) {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder('utf-8');

  // The EOCD sits at the end, after a comment of up to 65535 bytes.
  let eocd = -1;
  const floor = Math.max(0, buf.byteLength - 65557);
  for (let i = buf.byteLength - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid .docx file (no ZIP directory found).');

  let cdCount  = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  if (cdOffset === 0xffffffff || cdCount === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && dv.getUint32(loc, true) === ZIP64_LOC) {
      const z64 = Number(dv.getBigUint64(loc + 8, true));
      if (dv.getUint32(z64, true) === ZIP64_EOCD) {
        cdCount  = Number(dv.getBigUint64(z64 + 32, true));
        cdOffset = Number(dv.getBigUint64(z64 + 48, true));
      }
    }
  }

  // Walk the central directory for the entry we want.
  let p = cdOffset;
  let found = null;
  for (let n = 0; n < cdCount && p + 46 <= buf.byteLength; n++) {
    if (dv.getUint32(p, true) !== ZIP_CD) break;
    const method    = dv.getUint16(p + 10, true);
    const nameLen   = dv.getUint16(p + 28, true);
    const extraLen  = dv.getUint16(p + 30, true);
    const commentLen= dv.getUint16(p + 32, true);
    let compSize    = dv.getUint32(p + 20, true);
    let localOff    = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (name === entryName) {
      if (compSize === 0xffffffff || localOff === 0xffffffff) {
        // zip64: uncompressed size comes first, then compressed size, then offset
        const need = ['uncompressed', 'compressed', 'offset'];
        const z = readZip64Extra(dv, p + 46 + nameLen, extraLen, need);
        if (z.compressed !== undefined) compSize = z.compressed;
        if (z.offset !== undefined) localOff = z.offset;
      }
      found = { method, compSize, localOff };
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (!found) throw new Error(`Malformed .docx — ${entryName} not found in the archive.`);
  if (dv.getUint32(found.localOff, true) !== ZIP_LOCAL) throw new Error('Malformed .docx — bad local file header.');

  // The local header repeats name/extra lengths, and they may differ from the
  // central directory's, so the data offset must be computed from the local one.
  const lNameLen  = dv.getUint16(found.localOff + 26, true);
  const lExtraLen = dv.getUint16(found.localOff + 28, true);
  const dataStart = found.localOff + 30 + lNameLen + lExtraLen;
  const raw = bytes.subarray(dataStart, dataStart + found.compSize);

  if (found.method === 0) return dec.decode(raw);              // stored
  if (found.method === 8) return dec.decode(await inflateRaw(raw)); // deflate
  throw new Error(`Unsupported .docx compression method (${found.method}).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX — document.xml → ordered plain-text paragraphs
// ─────────────────────────────────────────────────────────────────────────────
//
// Only <w:t> runs contribute text, so tracked *deletions* (<w:delText>) are
// naturally excluded while tracked insertions are included — i.e. we read the
// document as it would appear with all changes accepted.

function docxXmlToParagraphs(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('Could not parse the Word document body (document.xml is malformed).');
  }

  const paras = [];
  const pNodes = doc.getElementsByTagName('w:p').length
    ? doc.getElementsByTagName('w:p')
    : doc.getElementsByTagNameNS('*', 'p');

  for (const p of Array.from(pNodes)) {
    const text = paragraphText(p);
    if (text) paras.push(text);
  }
  return paras;
}

function paragraphText(p) {
  let out = '';
  (function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType !== 1) continue;
      switch (child.localName) {
        case 't':       out += child.textContent; break;
        case 'delText': break;                    // tracked deletion — omit
        case 'tab':     out += ' '; break;
        case 'br':
        case 'cr':      out += ' '; break;
        default:        walk(child);
      }
    }
  })(p);
  return out.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

async function readDocxParagraphs(file) {
  const xml = await readZipEntryText(await file.arrayBuffer(), 'word/document.xml');
  return docxXmlToParagraphs(xml);
}
