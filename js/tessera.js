/*
 * Generazione delle tessere.
 *
 * La tessera non viene ridisegnata: si apre il PDF originale e si sostituisce
 * soltanto il blocco di testo con il nome. Sfondo, logo, profilo colore,
 * livelli e formato restano esattamente quelli del file di Illustrator.
 *
 * Funziona nel browser (window.Tessera) e in Node (require, dopo
 * `npm install pdf-lib @pdf-lib/fontkit`), dove è comodo per i test.
 */
(function (global) {
  'use strict';

  const inNode = typeof module === 'object' && module.exports;
  const PDFLib = inNode ? require('pdf-lib') : global.PDFLib;
  const fontkit = inNode ? require('@pdf-lib/fontkit') : global.fontkit;
  const PdfText = inNode ? require('./pdf-text.js') : global.PdfText;

  const { PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } = PDFLib;

  /** Distanza minima (in pt) tra un nome molto lungo e i bordi della tessera. */
  const MARGIN = 12;

  // ── Modello ──────────────────────────────────────────────────────────────

  /**
   * Legge il modello e trova il nome da sostituire: è il testo della tessera
   * (se i blocchi di testo sono più di uno, il primo).
   * Va fatto una sola volta; il risultato serve a tutte le tessere.
   */
  async function readTemplate(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPage(0);

    const blocks = PdfText.findTextBlocks(readPageContent(page));
    if (blocks.length === 0) {
      throw new Error('Nessun testo trovato nel modello (il nome è forse convertito in tracciati?)');
    }
    const [nameBlock] = blocks;

    const [scale, , , , x, baselineY] = nameBlock.matrix;
    const fontSize = nameBlock.fontSize * scale;
    const width = measureOriginalText(page, nameBlock) * fontSize;

    return {
      bytes,
      originalText: nameBlock.text,
      fontKey: nameBlock.fontKey,
      fontSize,
      baselineY,
      centerX: x + width / 2, // il nuovo nome sarà centrato qui
      pageWidth: page.getWidth(),
      pageHeight: page.getHeight(),
    };
  }

  // Larghezza (in em) del testo originale, usando le larghezze del suo font.
  function measureOriginalText(page, block) {
    const font = fontResources(page).lookup(PDFName.of(block.fontKey));
    const firstChar = font.lookup(PDFName.of('FirstChar')).asNumber();
    const widths = font.lookup(PDFName.of('Widths')).asArray().map((w) => w.asNumber());

    let total = 0;
    for (const piece of block.pieces) {
      if (piece.kerning !== undefined) total -= piece.kerning;
      else for (const code of piece.codes) total += widths[code - firstChar] || 0;
    }
    return total / 1000;
  }

  // ── Impaginazione del nome ───────────────────────────────────────────────

  /**
   * Decide corpo e posizione del nome.
   *
   * @param template       risultato di readTemplate
   * @param widthEm        larghezza del nome con corpo 1
   * @param capHeightEm    altezza delle maiuscole con corpo 1
   */
  function fitName(template, widthEm, capHeightEm) {
    const { fontSize, centerX, pageWidth, baselineY } = template;

    // Stesso corpo dell'originale, ridotto solo se il nome non entra.
    const room = 2 * (Math.min(centerX, pageWidth - centerX) - MARGIN);
    const size = Math.min(fontSize, room / widthEm);

    // Se il corpo cala, abbasso un po' la riga per tenerla centrata in verticale.
    const shrink = fontSize - size;
    return {
      size,
      x: centerX - (widthEm * size) / 2,
      y: baselineY + (shrink * capHeightEm) / 2,
    };
  }

  /**
   * Compone il nome con il font incorporato, applicando la crenatura del font
   * (come fa Illustrator con l'impostazione "Metrica").
   */
  function layOutName(font, name) {
    const fontData = font.embedder.font; // l'oggetto fontkit usato da pdf-lib
    const unitsPerEm = fontData.unitsPerEm;
    const layout = fontData.layout(name);

    let width = 0;
    const pieces = [];
    layout.glyphs.forEach((glyph, i) => {
      const advance = layout.positions[i].xAdvance;
      const character = String.fromCodePoint(...glyph.codePoints);
      pieces.push({
        hex: font.encodeText(character).toString(), // aggiunge anche il glifo al font incorporato
        kerning: ((glyph.advanceWidth - advance) * 1000) / unitsPerEm,
      });
      width += advance;
    });

    // Operando di TJ: <glifo> correzione <glifo> … (le correzioni nulle si omettono)
    const showText = pieces
      .map(({ hex, kerning }, i) => {
        const isLast = i === pieces.length - 1;
        return isLast || Math.abs(kerning) < 1e-6 ? hex : `${hex} ${PdfText.formatNumber(kerning)} `;
      })
      .join('');

    return {
      showText,
      widthEm: width / unitsPerEm,
      capHeightEm: capHeightOf(fontData),
    };
  }

  function capHeightOf(fontData) {
    return (fontData.capHeight || fontData.ascent * 0.72) / fontData.unitsPerEm;
  }

  // ── Creazione della tessera ──────────────────────────────────────────────

  /**
   * Crea il PDF di una tessera.
   *
   * @param template          risultato di readTemplate
   * @param fontBytes         font TTF/OTF con cui scrivere il nome
   * @param name              nome da scrivere
   * @param removeHiddenData  toglie i dati di Illustrator, la miniatura e i metadati XMP,
   *                          che contengono ancora il vecchio nome ma non vengono stampati
   */
  async function createCard({ template, fontBytes, name, removeHiddenData = true }) {
    const doc = await PDFDocument.load(template.bytes, { updateMetadata: false });
    doc.registerFontkit(fontkit);
    const page = doc.getPage(0);
    const font = await doc.embedFont(fontBytes, { subset: true });

    const line = layOutName(font, name);
    const { size, x, y } = fitName(template, line.widthEm, line.capHeightEm);

    const content = PdfText.replaceTextBlock(readPageContent(page), template.originalText, {
      fontKey: addFont(page, font),
      matrix: [size, 0, 0, size, x, y],
      showText: line.showText,
    });
    if (!content) throw new Error('Il testo del nome non è stato trovato nel modello');
    writePageContent(doc, page, content);

    const oldFontStillUsed = new RegExp(`/${template.fontKey}\\b`).test(content);
    if (!oldFontStillUsed) fontResources(page).delete(PDFName.of(template.fontKey));

    if (removeHiddenData) removeIllustratorData(doc, page);
    removeUnreachableObjects(doc);

    return doc.save({ updateFieldAppearances: false });
  }

  /** Unisce più tessere in un unico PDF, una per pagina (comodo per la stampa). */
  async function mergeCards(pdfs) {
    const merged = await PDFDocument.create();
    for (const bytes of pdfs) {
      const card = await PDFDocument.load(bytes);
      const [page] = await merged.copyPages(card, [0]);
      merged.addPage(page);
    }
    return merged.save();
  }

  // ── Utilità per l'interfaccia ────────────────────────────────────────────

  /** Caratteri del nome che il font non contiene (verrebbero stampati come quadratini). */
  function missingCharacters(fontBytes, name) {
    const fontData = fontkit.create(fontBytes);
    const missing = [...name].filter((ch) => ch.trim() && !fontData.hasGlyphForCodePoint(ch.codePointAt(0)));
    return [...new Set(missing)];
  }

  /** "Niccolò Dell'Àquila" → "tessera_Niccolo_DellAquila.pdf" */
  function fileNameFor(name) {
    const base = name
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // toglie gli accenti
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '_');
    return `tessera_${base || 'senza_nome'}.pdf`;
  }

  // ── Accesso alla pagina PDF ──────────────────────────────────────────────

  function fontResources(page) {
    return page.node.Resources().lookup(PDFName.of('Font'));
  }

  // Aggiunge il font alle risorse della pagina e restituisce il nome con cui usarlo.
  // (Non uso page.node.newFontDictionary: riorganizzerebbe il contenuto della pagina
  // in più stream, e il blocco del nome non si troverebbe più.)
  function addFont(page, font) {
    const fonts = fontResources(page);
    let key = 'Nome';
    while (fonts.has(PDFName.of(key))) key += '_';
    fonts.set(PDFName.of(key), font.ref);
    return key;
  }

  function readPageContent(page) {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((ref) => page.doc.context.lookup(ref))
      : [contents];

    return streams
      .map((stream) => {
        if (!(stream instanceof PDFRawStream)) throw new Error('Content stream non supportato');
        return PdfText.bytesToString(decodePDFRawStream(stream).decode());
      })
      .join('\n');
  }

  function writePageContent(doc, page, content) {
    const stream = doc.context.flateStream(PdfText.stringToBytes(content));
    page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  }

  function removeIllustratorData(doc, page) {
    page.node.delete(PDFName.of('PieceInfo')); // file nativo di Illustrator
    page.node.delete(PDFName.of('Thumb'));     // miniatura
    doc.catalog.delete(PDFName.of('Metadata')); // XMP, con un'altra miniatura
    doc.catalog.delete(PDFName.of('PieceInfo'));
  }

  // pdf-lib salva tutti gli oggetti del file, anche quelli che nessuno usa più.
  // Qui elimino quelli non raggiungibili dalla radice del documento.
  function removeUnreachableObjects(doc) {
    const context = doc.context;
    const reachable = new Set();
    const toVisit = [context.trailerInfo.Root, context.trailerInfo.Info].filter(Boolean);

    while (toVisit.length > 0) {
      let object = toVisit.pop();
      if (object instanceof PDFRef) {
        if (reachable.has(object.toString())) continue;
        reachable.add(object.toString());
        object = context.lookup(object);
      }
      if (object instanceof PDFStream) object = object.dict;

      if (object instanceof PDFDict) toVisit.push(...object.values());
      else if (object instanceof PDFArray) toVisit.push(...object.asArray());
    }

    for (const [ref] of context.enumerateIndirectObjects()) {
      if (!reachable.has(ref.toString())) context.delete(ref);
    }
  }

  const Tessera = {
    readTemplate,
    createCard,
    mergeCards,
    missingCharacters,
    fileNameFor,
  };

  if (inNode) module.exports = Tessera;
  else global.Tessera = Tessera;
})(globalThis);
