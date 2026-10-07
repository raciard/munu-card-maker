/*
 * Lettura e scrittura del testo dentro un content stream PDF.
 *
 * Un content stream è una sequenza di operatori, ciascuno preceduto dai suoi
 * argomenti. Per il testo si presenta più o meno così:
 *
 *   BT                                    ← inizio blocco di testo
 *   /F1 1 Tf                              ← font e corpo
 *   18 0 0 18 73.57 46.85 Tm              ← matrice: scala 18 pt, posizione (x, y)
 *   [(Nome Co) 20 (gnome)] TJ             ← testo, con piccole correzioni di spaziatura
 *   0 -22 Td (Seconda riga) Tj            ← spostamento relativo e altro testo
 *   ET                                    ← fine blocco
 *
 * Qui il content stream viene letto operatore per operatore, seguendo:
 *  - fuori dal testo: q / Q (salva / ripristina lo stato) e cm (sposta, scala,
 *    ribalta tutto ciò che segue), per sapere dove finisce davvero ogni testo;
 *  - nel testo: font (Tf), posizione (Tm, Td, TD, T*, TL) e i comandi che
 *    mostrano il testo (Tj, TJ, ', ").
 * Ogni comando che mostra testo in una nuova posizione diventa una "riga" che si
 * può sostituire; i comandi che proseguono sulla stessa riga (alcuni programmi
 * la spezzano, per esempio per cambiare stile) ne fanno parte.
 */
(function (global) {
  'use strict';

  const IDENTITY = [1, 0, 0, 1, 0, 0];

  // Un elemento del content stream: spazi e commenti, stringhe ( … ) anche con
  // parentesi annidate, stringhe esadecimali < … >, dizionari << >>, array [ ],
  // nomi /…, numeri, operatori.
  const TOKEN = /\s+|%[^\r\n]*|\((?:[^()\\]|\\[\s\S]|\((?:[^()\\]|\\[\s\S])*\))*\)|<<|>>|<[0-9A-Fa-f\s]*>|[[\]{}]|\/[^\s/[\]()<>{}%]*|[-+]?(?:\d+\.?\d*|\.\d+)|[^\s/[\]()<>{}%]+/g;

  // I content stream sono byte: li tratto come stringhe Latin-1 (un carattere = un byte).
  function bytesToString(bytes) {
    const CHUNK = 0x8000; // evita "Maximum call stack size" su stream grandi
    let text = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return text;
  }

  function stringToBytes(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return bytes;
  }

  // ── Lettura ──────────────────────────────────────────────────────────────

  /**
   * Tutti i comandi che mostrano testo, in ordine. Per ognuno:
   *   text, pieces       testo (codici dei caratteri) e correzioni di spaziatura
   *   fontKey, fontSize  font e corpo impostati con Tf (fontSizeSource: com'era scritto)
   *   matrix             matrice del testo (Tm) al momento del comando
   *   lineMatrix         inizio della riga corrente, che Td e T* usano come riferimento
   *   ctm                trasformazione della pagina attiva (cm)
   *   start, end, source dove si trova il comando nel content stream
   *   continuations      comandi successivi che proseguono la stessa riga
   *                      ({ start, end, source }); il loro testo è già in `text`
   */
  function findTextRuns(content) {
    const runs = [];
    let graphics = { ctm: IDENTITY, fontKey: null, fontSize: 0, fontSizeSource: '0', leading: 0 };
    const saved = [];
    let textMatrix = IDENTITY;
    let lineMatrix = IDENTITY;
    let movedSinceLastRun = true;
    let lastRun = null; // ultima riga del blocco di testo corrente

    let operands = [];
    const arrays = []; // array in costruzione (possono essere annidati)

    TOKEN.lastIndex = 0;
    let match;
    while ((match = TOKEN.exec(content))) {
      const token = match[0];
      const start = match.index;
      const first = token[0];

      if (/\s/.test(first) || first === '%') continue;

      if (token === '[') {
        arrays.push({ items: [], start });
        continue;
      }
      if (token === ']') {
        const array = arrays.pop();
        if (!array) continue;
        const value = { type: 'array', items: array.items, start: array.start, raw: content.slice(array.start, start + 1) };
        (arrays.length ? arrays[arrays.length - 1].items : operands).push(value);
        continue;
      }

      const operand = toOperand(token, start);
      if (operand) {
        (arrays.length ? arrays[arrays.length - 1].items : operands).push(operand);
        continue;
      }

      // È un operatore: lo eseguo con gli argomenti raccolti.
      const numbers = operands.map((o) => o.value);
      switch (token) {
        case 'q':
          saved.push(graphics);
          graphics = { ...graphics };
          break;
        case 'Q':
          graphics = saved.pop() || graphics;
          break;
        case 'cm':
          graphics.ctm = multiply(numbers.slice(-6), graphics.ctm);
          break;
        case 'BT':
          textMatrix = lineMatrix = IDENTITY;
          movedSinceLastRun = true;
          lastRun = null;
          break;
        case 'Tf':
          graphics.fontKey = operands[0]?.name ?? graphics.fontKey;
          graphics.fontSize = numbers[1] ?? graphics.fontSize;
          graphics.fontSizeSource = operands[1]?.raw ?? graphics.fontSizeSource;
          break;
        case 'TL':
          graphics.leading = numbers[0];
          break;
        case 'Tm':
          textMatrix = lineMatrix = numbers.slice(-6);
          movedSinceLastRun = true;
          break;
        case 'TD':
          graphics.leading = -numbers[1];
          // continua come Td
        case 'Td':
          textMatrix = lineMatrix = multiply([1, 0, 0, 1, numbers[0], numbers[1]], lineMatrix);
          movedSinceLastRun = true;
          break;
        case 'T*':
        case "'":
        case '"':
          textMatrix = lineMatrix = multiply([1, 0, 0, 1, 0, -graphics.leading], lineMatrix);
          movedSinceLastRun = true;
          if (token === 'T*') break;
          // continua: ' e " vanno a capo e poi mostrano il testo
        case 'Tj':
        case 'TJ': {
          const textOperand = operands[operands.length - 1];
          const pieces = textOperand ? piecesOf(textOperand) : [];
          const text = pieces.filter((p) => p.codes).map((p) => String.fromCharCode(...p.codes)).join('');
          const runStart = operands.length ? operands[0].start : start;
          const location = { start: runStart, end: start + token.length, source: content.slice(runStart, start + token.length) };

          // Senza spostamenti dal testo precedente, è la sua continuazione.
          if (!movedSinceLastRun && lastRun) {
            lastRun.text += text;
            lastRun.pieces.push(...pieces);
            lastRun.continuations.push(location);
            break;
          }

          lastRun = {
            text,
            pieces,
            operator: token,
            spacing: token === '"' ? operands.slice(0, 2).map((o) => o.raw) : null,
            fontKey: graphics.fontKey,
            fontSize: graphics.fontSize,
            fontSizeSource: graphics.fontSizeSource,
            matrix: textMatrix,
            lineMatrix,
            ctm: graphics.ctm,
            ...location,
            continuations: [],
          };
          runs.push(lastRun);
          movedSinceLastRun = false;
          break;
        }
        case 'ID': {
          // Immagine incorporata: i suoi byte vanno saltati fino a EI.
          const imageEnd = content.slice(TOKEN.lastIndex).search(/\sEI(?=\s|$)/);
          if (imageEnd >= 0) TOKEN.lastIndex += imageEnd + 3;
          break;
        }
      }
      operands = [];
    }
    return runs;
  }

  // Numeri, nomi, stringhe e dizionari sono argomenti; tutto il resto è un operatore.
  function toOperand(token, start) {
    const first = token[0];
    if (/[-+.\d]/.test(first)) return { type: 'number', value: parseFloat(token), raw: token, start };
    if (first === '/') return { type: 'name', name: token.slice(1), raw: token, start };
    if (first === '(') return { type: 'string', codes: decodeLiteralString(token.slice(1, -1)), raw: token, start };
    if (token === '<<' || token === '>>' || token === '{' || token === '}') return { type: 'other', raw: token, start };
    if (first === '<') return { type: 'string', codes: decodeHexString(token.slice(1, -1)), raw: token, start };
    if (token === 'true' || token === 'false' || token === 'null') return { type: 'other', raw: token, start };
    return null;
  }

  /**
   * Pezzi del testo di un comando:
   *   { codes: [...] }  testo
   *   { kerning: n }    spostamento in millesimi di em (positivo = verso sinistra)
   */
  function piecesOf(operand) {
    if (operand.type === 'string') return [{ codes: operand.codes }];
    if (operand.type !== 'array') return [];
    return operand.items
      .filter((item) => item.type === 'string' || item.type === 'number')
      .map((item) => (item.type === 'string' ? { codes: item.codes } : { kerning: item.value }));
  }

  const ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };

  // Contenuto di "( … )" → codici dei caratteri, gestendo gli escape del formato PDF.
  function decodeLiteralString(literal) {
    const codes = [];
    for (let i = 0; i < literal.length; i++) {
      if (literal[i] !== '\\') {
        codes.push(literal.charCodeAt(i));
        continue;
      }
      const next = literal[++i];
      if (next in ESCAPES) {
        codes.push(ESCAPES[next]);
      } else if (/[0-7]/.test(next)) {
        let octal = next;
        while (octal.length < 3 && /[0-7]/.test(literal[i + 1])) octal += literal[++i];
        codes.push(parseInt(octal, 8) & 0xff);
      } else if (next === '\r' || next === '\n') {
        // backslash a fine riga: la stringa continua sulla riga dopo
        if (next === '\r' && literal[i + 1] === '\n') i++;
      } else if (next !== undefined) {
        codes.push(literal.charCodeAt(i));
      }
    }
    return codes;
  }

  // Contenuto di "< … >" → codici dei caratteri.
  function decodeHexString(hex) {
    const digits = hex.replace(/\s/g, '');
    const codes = [];
    for (let i = 0; i < digits.length; i += 2) {
      codes.push(parseInt(digits.substr(i, 2).padEnd(2, '0'), 16));
    }
    return codes;
  }

  // ── Scrittura ────────────────────────────────────────────────────────────

  /**
   * Sostituisce il testo di un comando trovato da findTextRuns.
   *
   * Prima del nuovo testo imposta il suo font e la sua posizione; dopo rimette
   * font e inizio riga di prima, così gli eventuali testi successivi dello
   * stesso blocco restano dove erano. Colore e resto del blocco non cambiano.
   * Le eventuali continuazioni della riga vengono tolte: il nuovo testo la sostituisce tutta.
   * Restituisce null se il content stream non è quello da cui viene `run`.
   */
  function replaceTextRun(content, run, { fontKey, matrix, showText }) {
    const parts = [run, ...run.continuations];
    if (parts.some((part) => content.slice(part.start, part.end) !== part.source)) return null;

    // Dalla fine all'inizio, così le posizioni ancora da usare non cambiano.
    for (const part of run.continuations.slice().reverse()) {
      content = content.slice(0, part.start) + content.slice(part.end);
    }

    const restore = [
      run.spacing ? `${run.spacing[0]} Tw ${run.spacing[1]} Tc` : '', // " imposta anche queste spaziature
      `/${run.fontKey} ${run.fontSizeSource} Tf`,
      `${run.lineMatrix.map(formatNumber).join(' ')} Tm`,
    ].filter(Boolean).join(' ');

    const replacement = `/${fontKey} 1 Tf ${matrix.map(formatNumber).join(' ')} Tm [${showText}]TJ ${restore}`;
    return content.slice(0, run.start) + replacement + content.slice(run.end);
  }

  // ── Matrici ──────────────────────────────────────────────────────────────

  // Composizione di due trasformazioni PDF [a, b, c, d, e, f]: prima m1, poi m2.
  function multiply([a1, b1, c1, d1, e1, f1], [a2, b2, c2, d2, e2, f2]) {
    return [
      a1 * a2 + b1 * c2,
      a1 * b2 + b1 * d2,
      c1 * a2 + d1 * c2,
      c1 * b2 + d1 * d2,
      e1 * a2 + f1 * c2 + e2,
      e1 * b2 + f1 * d2 + f2,
    ];
  }

  function invert([a, b, c, d, e, f]) {
    const det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  }

  // Al massimo 4 decimali: più che sufficienti per posizioni in punti tipografici.
  function formatNumber(n) {
    return String(Math.round(n * 10000) / 10000);
  }

  const PdfText = {
    bytesToString,
    stringToBytes,
    findTextRuns,
    replaceTextRun,
    multiply,
    invert,
    formatNumber,
  };

  if (typeof module === 'object' && module.exports) module.exports = PdfText;
  else global.PdfText = PdfText;
})(globalThis);
