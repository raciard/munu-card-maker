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
   * Legge il modello e trova i testi che si possono sostituire.
   * Va fatto una sola volta; il risultato serve a tutte le tessere.
   *
   * Tutte le misure sono in punti, nello spazio della pagina (origine in basso a sinistra).
   * @returns {{ bytes, box: {x, y, width, height}, fields: Field[] }}
   *
   * Field: { run, text, fontSize, x, baselineY, width, stretch }
   *   width può essere null se non si riesce a calcolare dal font (es. font CID):
   *   in quel caso va misurata altrove (l'interfaccia la prende da pdf.js).
   */
  async function readTemplate(bytes) {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = doc.getPage(0);

    const fields = PdfText.findTextRuns(readPageContent(page))
      .filter((run) => run.fontKey)
      .map((run) => describeField(page, run))
      .filter(Boolean);

    if (fields.length === 0) {
      throw new Error('Nessun testo modificabile nel modello (è forse convertito in tracciati?)');
    }
    return { bytes, box: page.getCropBox(), fields };
  }

  // Posizione e dimensioni del testo sulla pagina. null se il testo è ruotato,
  // inclinato o capovolto: sono gli unici casi che non si sanno riposizionare.
  function describeField(page, run) {
    // Effetto combinato di matrice del testo e trasformazione della pagina
    // (alcuni programmi ribaltano la pagina e poi ribaltano di nuovo il testo).
    const [a, b, c, d, x, y] = PdfText.multiply(run.matrix, run.ctm);
    if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9 || a <= 0 || d <= 0) return null;

    const sizeX = run.fontSize * a; // corpo in orizzontale e in verticale, in punti:
    const sizeY = run.fontSize * d; // diversi solo se il testo è stato stirato
    const widthEm = measureOriginalText(page, run);

    return {
      run,
      text: run.text,
      fontSize: sizeY,
      stretch: sizeX / sizeY,
      x,
      baselineY: y,
      width: widthEm === null ? null : widthEm * sizeX,
    };
  }

  // Larghezza (in em) del testo originale, usando le larghezze del suo font.
  // null se il font non le indica in modo semplice (/Widths).
  function measureOriginalText(page, run) {
    const font = fontResources(page).lookup(PDFName.of(run.fontKey));
    const widthsArray = font && font.lookup(PDFName.of('Widths'));
    if (!(widthsArray instanceof PDFArray)) return null;
    const firstChar = font.lookup(PDFName.of('FirstChar')).asNumber();
    const widths = widthsArray.asArray().map((w) => w.asNumber());

    let total = 0;
    for (const piece of run.pieces) {
      if (piece.kerning !== undefined) total -= piece.kerning;
      else for (const code of piece.codes) total += widths[code - firstChar] || 0;
    }
    return total / 1000;
  }

  /**
   * Allineamento più probabile: centrato se il testo è a metà pagina,
   * altrimenti verso il bordo a cui è più vicino.
   */
  function suggestAlignment(template, field) {
    if (field.width === null) return 'left';
    const { x: pageLeft, width: pageWidth } = template.box;
    const fieldCenter = field.x + field.width / 2;
    if (Math.abs(fieldCenter - (pageLeft + pageWidth / 2)) < pageWidth * 0.03) return 'center';
    const toLeftEdge = field.x - pageLeft;
    const toRightEdge = pageLeft + pageWidth - (field.x + field.width);
    return toRightEdge < toLeftEdge ? 'right' : 'left';
  }

  // ── Impaginazione del nome ───────────────────────────────────────────────

  // Quale punto del vecchio testo resta fermo: inizio, metà o fine.
  const ANCHOR = { left: 0, center: 0.5, right: 1 };

  /**
   * Decide corpo e posizione del nuovo testo, in punti sulla pagina.
   *
   * @param template     risultato di readTemplate
   * @param field        il testo da sostituire (uno di template.fields)
   * @param align        'left' | 'center' | 'right'
   * @param widthEm      larghezza del nuovo testo con corpo 1
   * @param capHeightEm  altezza delle maiuscole con corpo 1
   */
  function fitName(template, field, align, widthEm, capHeightEm) {
    const anchorFactor = ANCHOR[align];
    const anchor = field.x + (field.width ?? 0) * anchorFactor;
    const minX = template.box.x + MARGIN;
    const maxX = template.box.x + template.box.width - MARGIN;

    // Spazio disponibile verso i bordi, a seconda dell'allineamento.
    const room = {
      left: maxX - anchor,
      center: 2 * Math.min(anchor - minX, maxX - anchor),
      right: anchor - minX,
    }[align];

    // Stesso corpo dell'originale, ridotto solo se il testo non entra.
    const lineWidth = widthEm * field.stretch;
    const size = Math.min(field.fontSize, Math.max(room, 1) / lineWidth);

    // Se il corpo cala, abbasso un po' la riga per tenerla centrata in verticale.
    const shrink = field.fontSize - size;
    return {
      size,
      x: anchor - lineWidth * size * anchorFactor,
      y: field.baselineY + (shrink * capHeightEm) / 2,
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
   * @param field             il testo da sostituire (uno di template.fields)
   * @param align             'left' | 'center' | 'right': quale punto del vecchio testo resta fermo
   * @param fontBytes         font TTF/OTF con cui scrivere il nome
   * @param name              nome da scrivere
   * @param removeHiddenData  toglie i dati di Illustrator, la miniatura e i metadati XMP,
   *                          che contengono ancora il testo originale ma non vengono stampati
   */
  async function createCard({ template, field, align = 'center', fontBytes, name, removeHiddenData = true }) {
    const doc = await PDFDocument.load(template.bytes, { updateMetadata: false });
    doc.registerFontkit(fontkit);
    const page = doc.getPage(0);
    const font = await doc.embedFont(fontBytes, { subset: true });

    const line = layOutName(font, name);
    const { size, x, y } = fitName(template, field, align, line.widthEm, line.capHeightEm);

    // Da punti sulla pagina allo spazio in cui è scritto il testo, togliendo
    // l'effetto della trasformazione della pagina (spostamenti, scale, ribaltamenti).
    const onPage = [size * field.stretch, 0, 0, size, x, y];
    const content = PdfText.replaceTextRun(readPageContent(page), field.run, {
      fontKey: addFont(page, font),
      matrix: PdfText.multiply(onPage, PdfText.invert(field.run.ctm)),
      showText: line.showText,
    });
    if (!content) throw new Error('Il testo da sostituire non è stato trovato nel modello');
    writePageContent(doc, page, content);

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
    suggestAlignment,
    createCard,
    mergeCards,
    missingCharacters,
    fileNameFor,
  };

  if (inNode) module.exports = Tessera;
  else global.Tessera = Tessera;
})(globalThis);
