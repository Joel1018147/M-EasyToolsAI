'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   BYTES → TEXT, DETERMINISTICALLY.                    lib/docintel/textLayer.js
   ───────────────────────────────────────────────────────────────────────────
   No model runs in this file. Every character it returns came out of the
   uploaded bytes, and that is the whole point: guards.js later requires every
   proposed value to be a SUBSTRING of what this file produced, so if this file
   invented text the evidence check would be verifying a fiction.

   ── WHY IT IS HAND-WRITTEN AND NOT A LIBRARY ──────────────────────────────
   `package.json` is not this lane's file to edit (GAUNTLET.md LANE SPLIT), so
   `mammoth`, `exceljs`, `pdf-parse`, `pdfjs` and every OCR engine are simply
   not installed and cannot be. Node's own `zlib` IS installed, and a PDF text
   layer is FlateDecode'd content streams — which is enough for the PDFs an
   office actually produces (Word, Google Docs, Chrome's print-to-PDF).

   The design is M-EasyDo's `lib/docintel/textLayer.js`, read as a reference
   and re-authored here. What was dropped is everything that needed a
   dependency this repo does not have: the .docx path, the .xlsx path, and the
   vision reader. Dropping them is not a gap that is hidden — each returns a
   named status with the reason, below, so a user is told what happened.

   ── WHAT IT CANNOT DO, SAID OUT LOUD RATHER THAN GUESSED AROUND ───────────
   1. NO OCR. An image, or a PDF that is a scan, has no text layer here. This
      returns status 'no_text_layer' WITH the reason, and propose() then
      refuses to run rather than offering values it cannot evidence. RULE 6:
      a capability a user believes in but which is absent does more damage
      than one that is visibly missing.
   2. NO .docx / .xlsx. Both are ZIP-of-XML and both need a parser this repo
      does not carry. They return 'unsupported' and name the reason and the
      workaround ("save as PDF or paste as .txt"), never a silent empty read.
   3. A PDF using a custom CID font encoding decodes to mojibake rather than
      to text. That failure is VISIBLE, not silent — the reviewer is shown the
      verbatim quote, sees the mojibake, and rejects. It is also partly caught
      by PRINTABLE_RATIO below, which downgrades a block that is mostly
      unprintable to 'no_text_layer'.
   4. `block` IS NOT ALWAYS `page`. A page's text can be split across several
      content streams and one stream can hold several pages. Blocks are the
      decoded content streams in file order. The API and the page both say
      "block", never "page", because reporting a block index as a page number
      would be a precise-looking number that is sometimes wrong.
   ═══════════════════════════════════════════════════════════════════════════ */

const zlib = require('zlib');

/** One upload's ceiling. 8 MB is roughly a 40-page scanned PDF and well under
 *  any Postgres limit on a BYTEA parameter. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Below this many non-space characters there is nothing to extract from. */
const MIN_TEXT_CHARS = 40;

/** A decoded block whose printable share is under this is treated as binary
 *  that happened to inflate, not as text. */
const PRINTABLE_RATIO = 0.7;

/** Stops one adversarial PDF from producing a hundred thousand blocks. */
const MAX_BLOCKS = 400;

const TEXT_MIMES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/x-markdown']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/tiff', 'image/heic']);
const PDF_MIMES = new Set(['application/pdf']);

/* RECOGNISED AND REFUSED, which is a different answer from "unknown". Both
   are ZIP-of-XML containers whose parsers (mammoth, exceljs) are dependencies
   this lane may not add. Naming them here means the refusal can say WHY and
   WHAT TO DO instead of "not a container this deployment reads". */
const OFFICE_MIMES = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-excel.sheet.macroEnabled.12', '.xlsm'],
]);

const OFFICE_REASON =
  'is an Office container, and reading one needs a parser (mammoth for Word, exceljs for spreadsheets) that is not '
  + 'installed on this deployment. Nothing here can read it, so nothing is offered rather than an empty extraction '
  + 'that would look like a document with no content in it. Export it as PDF, or save it as .txt or .csv, and both '
  + 'do work.';

/** Normalise a Content-Type down to its bare type. */
const mimeOf = (raw) => String(raw || '').split(';')[0].trim().toLowerCase();

/** Extension-only fallback, used ONLY to make a refusal more specific — never
 *  to accept a file whose bytes were not checked. */
function extOf(filename) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(filename || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

/**
 * Would `extract()` produce something readable for this container?
 *
 * Deliberately generous about text: browsers send `application/octet-stream`
 * for a .txt/.csv/.md dragged out of some file managers, and refusing a
 * correct file for a header the user did not choose is a bad refusal. The
 * bytes are still decoded as UTF-8 and still have to survive MIN_TEXT_CHARS
 * and PRINTABLE_RATIO, so an octet-stream that is really a JPEG lands on
 * 'no_text_layer' rather than being read as text.
 */
function isAccepted(mime, filename) {
  const m = mimeOf(mime);
  if (PDF_MIMES.has(m) || TEXT_MIMES.has(m) || IMAGE_MIMES.has(m)) return true;
  if (m === 'application/octet-stream' || m === '') {
    return ['.txt', '.csv', '.md', '.markdown', '.pdf'].includes(extOf(filename));
  }
  return false;
}

/** Share of characters that are ordinary printable text or whitespace. */
function printableRatio(s) {
  if (!s.length) return 0;
  let good = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || (c >= 160 && c <= 0x2fff)) good += 1;
  }
  return good / s.length;
}

/* ── PDF string literals ───────────────────────────────────────────────────
   `( … )` with nesting and the escapes the spec defines, and `< … >` hex.
   Both return a byte array, decoded afterwards, because a PDF string is bytes
   and its encoding is only knowable after the fact (a UTF-16BE BOM). */

function readLiteralString(src, start) {
  const bytes = [];
  let depth = 1;
  let i = start; // src[start-1] === '('
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      i += 2;
      if (n === 'n') { bytes.push(10); continue; }
      if (n === 'r') { bytes.push(13); continue; }
      if (n === 't') { bytes.push(9); continue; }
      if (n === 'b') { bytes.push(8); continue; }
      if (n === 'f') { bytes.push(12); continue; }
      if (n === '\n') continue;                        // line continuation
      if (n === '\r') { if (src[i] === '\n') i += 1; continue; }
      if (n >= '0' && n <= '7') {                      // \ddd octal
        let oct = n;
        while (oct.length < 3 && src[i] >= '0' && src[i] <= '7') { oct += src[i]; i += 1; }
        bytes.push(parseInt(oct, 8) & 0xff);
        continue;
      }
      if (n === undefined) break;
      bytes.push(n.charCodeAt(0) & 0xff);
      continue;
    }
    if (c === '(') { depth += 1; bytes.push(40); i += 1; continue; }
    if (c === ')') {
      depth -= 1;
      if (depth === 0) return { bytes, next: i + 1 };
      bytes.push(41); i += 1; continue;
    }
    bytes.push(c.charCodeAt(0) & 0xff);
    i += 1;
  }
  return { bytes, next: i };
}

function readHexString(src, start) {
  const bytes = [];
  let hex = '';
  let i = start; // src[start-1] === '<'
  while (i < src.length && src[i] !== '>') {
    const c = src[i];
    if (/[0-9a-fA-F]/.test(c)) hex += c;
    i += 1;
  }
  if (hex.length % 2) hex += '0';
  for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
  return { bytes, next: i + 1 };
}

/** Bytes → string. UTF-16BE when the BOM says so, latin1 otherwise, which is
 *  what PDFDocEncoding is across the ASCII range every western document uses. */
function decodePdfBytes(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).swap16().toString('utf16le');
  return buf.toString('latin1');
}

/* ── one content stream → text ─────────────────────────────────────────────
   TEXT-SHOWING OPERATORS ONLY: Tj, TJ, ' and ". Everything else is skipped.
   A TJ array's numbers are kerning in thousandths of an em; a big negative one
   is how PDF producers write a space, so anything at or beyond -140 emits one.
   Positioning operators (Td, TD, T*) and BT/ET end a line. */
function contentStreamToText(src) {
  let out = '';
  let pending = '';
  let lastNumber = null;
  let i = 0;

  const flush = () => { if (pending) { out += pending; pending = ''; } };

  while (i < src.length) {
    const c = src[i];

    if (c === '(') {
      const r = readLiteralString(src, i + 1);
      pending += decodePdfBytes(r.bytes);
      i = r.next; lastNumber = null; continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const r = readHexString(src, i + 1);
      pending += decodePdfBytes(r.bytes);
      i = r.next; lastNumber = null; continue;
    }
    if (c === '-' || c === '.' || (c >= '0' && c <= '9')) {
      let j = i;
      while (j < src.length && /[-.0-9]/.test(src[j])) j += 1;
      lastNumber = Number(src.slice(i, j));
      if (Number.isFinite(lastNumber) && lastNumber <= -140 && pending && !/\s$/.test(pending)) pending += ' ';
      i = j; continue;
    }
    if (/[A-Za-z'"*]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9*'"]/.test(src[j])) j += 1;
      const op = src.slice(i, j);
      i = j;
      if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
        if (op === "'" || op === '"') out += '\n';
        flush();
      } else if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'ET' || op === 'BT') {
        flush();
        if (!/\n$/.test(out)) out += '\n';
      } else {
        pending = '';                                  // operands of an operator we do not read
      }
      lastNumber = null;
      continue;
    }
    i += 1;
  }
  flush();
  return out;
}

/* ── the PDF's streams ─────────────────────────────────────────────────────
   Scanned STRUCTURALLY rather than by following the xref table: a linearised
   or incrementally-updated PDF has several xrefs and a damaged one has none,
   and the streams are all still there in the file either way. */
function pdfBlocks(buf) {
  const src = buf.toString('latin1');
  const blocks = [];
  let inflateFailures = 0;
  let nonTextStreams = 0;

  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(src)) !== null && blocks.length < MAX_BLOCKS) {
    const bodyStart = m.index + m[0].length;
    const end = src.indexOf('endstream', bodyStart);
    if (end === -1) break;

    // The stream's own dictionary is the `<< … >>` immediately before it.
    const dictStart = src.lastIndexOf('<<', m.index);
    const dict = dictStart === -1 ? '' : src.slice(dictStart, m.index);
    const raw = buf.slice(bodyStart, end);

    let decoded = null;
    if (/\/FlateDecode/.test(dict)) {
      /* Two spellings of the same compression, and a stream that is neither is
         COUNTED, not ignored — a PDF whose text sits in a filter this cannot
         read must not look like a PDF with no text in it. Neither branch here
         is a silent swallow: inflateFailures reaches the note, which reaches
         the operator. */
      try {
        decoded = zlib.inflateSync(raw).toString('latin1');
      } catch (errZlib) {
        try {
          decoded = zlib.inflateRawSync(raw).toString('latin1');
        } catch (errRaw) {
          inflateFailures += 1;
          re.lastIndex = end;
          continue;
        }
      }
    } else if (!/\/Filter/.test(dict)) {
      decoded = raw.toString('latin1');
    } else {
      nonTextStreams += 1;                             // DCTDecode image, embedded font, …
      re.lastIndex = end;
      continue;
    }

    re.lastIndex = end;

    if (!/\bBT\b|\bTj\b|\bTJ\b/.test(decoded)) { nonTextStreams += 1; continue; }
    const text = contentStreamToText(decoded);
    if (text.replace(/\s/g, '').length === 0) { nonTextStreams += 1; continue; }
    if (printableRatio(text) < PRINTABLE_RATIO) { nonTextStreams += 1; continue; }
    blocks.push(text);
  }

  return { blocks, inflateFailures, nonTextStreams };
}

/**
 * Extract a document's text layer.
 *
 * @param {Buffer} buf
 * @param {string} mimeType
 * @param {string} filename    used ONLY to make a refusal more specific
 * @returns {{status:'extracted'|'no_text_layer'|'unsupported',
 *            blocks:string[], text:string, note:string}}
 *
 * It NEVER throws on unreadable input and it never returns partial text
 * labelled 'extracted'. The three statuses mean three different things and
 * every caller branches on them:
 *   extracted      — there is text; proposals may be sought against it
 *   no_text_layer  — the bytes are fine, there is simply nothing to quote
 *   unsupported    — this deployment cannot read this container at all
 *
 * 'extracted_by_vision' — the fourth status the migration's comment reserves —
 * is NEVER produced here, because this deployment has no vision reader. The
 * column keeps the value so the two can never be confused later if one is
 * added; nothing in this lane writes it, and that is the honest position
 * rather than reusing 'extracted' for something a model read off a picture.
 */
function extract(buf, mimeType, filename) {
  const mime = mimeOf(mimeType);
  const ext = extOf(filename);

  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { status: 'no_text_layer', blocks: [], text: '', note: 'The upload carried no bytes.' };
  }

  if (IMAGE_MIMES.has(mime)) {
    return {
      status: 'no_text_layer',
      blocks: [],
      text: '',
      note: `${mime} is an image and this deployment has no OCR engine — reading text out of a picture needs a `
          + 'dependency this repository does not carry. The file is stored and a human can open it, but no value can '
          + 'be evidenced against it, so no proposals are offered rather than proposals being guessed.',
    };
  }

  if (OFFICE_MIMES.has(mime)) {
    return {
      status: 'unsupported',
      blocks: [],
      text: '',
      note: `${OFFICE_MIMES.get(mime)} ${OFFICE_REASON}`,
    };
  }

  const isText = TEXT_MIMES.has(mime)
    || ((mime === 'application/octet-stream' || mime === '') && ['.txt', '.csv', '.md', '.markdown'].includes(ext));
  if (isText) {
    const text = buf.toString('utf8');
    if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
      return { status: 'no_text_layer', blocks: [], text: '',
               note: `Fewer than ${MIN_TEXT_CHARS} non-space characters of text — there is nothing a proposal could quote.` };
    }
    if (printableRatio(text) < PRINTABLE_RATIO) {
      return { status: 'no_text_layer', blocks: [], text: '',
               note: 'These bytes were sent as text but do not decode as text — most of the characters are '
                   + 'unprintable, so this is a binary file with a text content type on it.' };
    }
    /* One block per line, so `evidence_block` locates a quote at a useful
       granularity and locateQuote() is not forced to match across a line
       break that only exists because a CSV had rows. */
    const blocks = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return { status: 'extracted', blocks, text: blocks.join('\n'),
             note: `Plain text, read as UTF-8: ${blocks.length} non-empty line(s).` };
  }

  const isPdf = PDF_MIMES.has(mime) || ((mime === 'application/octet-stream' || mime === '') && ext === '.pdf');
  if (isPdf) {
    const { blocks, inflateFailures, nonTextStreams } = pdfBlocks(buf);
    const text = blocks.join('\n');
    const parts = [`${blocks.length} text block(s)`, `${nonTextStreams} non-text stream(s)`];
    if (inflateFailures) parts.push(`${inflateFailures} stream(s) this deployment could not decompress`);
    const note = parts.join('; ') + ". Blocks are the PDF's decoded content streams in file order — usually, but not "
               + 'always, one per page.';
    if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
      return {
        status: 'no_text_layer',
        blocks: [],
        text: '',
        note: note + ` Fewer than ${MIN_TEXT_CHARS} characters of text were recovered, so this PDF is a scan, or its `
            + 'text is in a filter or font encoding this deployment cannot read. Either way there is nothing a '
            + 'proposal could quote, and no OCR engine is installed to fall back to.',
      };
    }
    return { status: 'extracted', blocks, text, note };
  }

  return {
    status: 'unsupported',
    blocks: [],
    text: '',
    note: `${mime || 'an unnamed content type'} is not a container this deployment reads. Accepted: application/pdf, `
        + 'text/plain, text/csv and text/markdown. PNG/JPEG/WebP/GIF/TIFF images are stored but have no text layer '
        + 'without an OCR engine, and Word/Excel containers need a parser this deployment does not carry.',
  };
}

module.exports = {
  extract, isAccepted, printableRatio, contentStreamToText, pdfBlocks,
  MAX_BYTES, MIN_TEXT_CHARS, PRINTABLE_RATIO, MAX_BLOCKS,
  TEXT_MIMES, IMAGE_MIMES, PDF_MIMES, OFFICE_MIMES,
};
