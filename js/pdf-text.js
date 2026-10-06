/*
 * Lettura e scrittura del testo dentro un content stream PDF.
 *
 * Un content stream è una sequenza di operatori come questa:
 *
 *   BT                                    ← inizio blocco di testo
 *   /TT0 1 Tf                             ← font e corpo
 *   18 0 0 18 73.57 46.85 Tm              ← matrice: scala 18 pt, posizione (x, y)
 *   [(Nom Cognom) 0.6 (li)] TJ             ← testo, con piccole correzioni di spaziatura
 *   ET                                    ← fine blocco
 *
 * Qui servono solo questi quattro operatori, quindi bastano poche espressioni
 * regolari invece di un parser PDF completo.
 */
(function (global) {
  'use strict';

  const NUMBER = '(-?\\d*\\.?\\d+)';

  const PATTERNS = {
    textBlock: /BT\b[\s\S]*?\bET\b/g,
    setFont: /\/([^\s/\[\]()<>]+)\s+(-?\d*\.?\d+)\s+Tf/,
    textMatrix: new RegExp(Array(6).fill(NUMBER).join('\\s+') + '\\s+Tm'),
    showText: /\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^)\\]|\\.)*)\)\s*Tj/,
  };

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

  const ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };

  // "(Ciao\051)" → codici dei caratteri, gestendo gli escape del formato PDF.
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
        codes.push(parseInt(octal, 8));
      } else if (next === '\r' || next === '\n') {
        // backslash a fine riga: la stringa continua sulla riga dopo
        if (next === '\r' && literal[i + 1] === '\n') i++;
      } else {
        codes.push(literal.charCodeAt(i));
      }
    }
    return codes;
  }

  // "<4C6963>" → codici dei caratteri.
  function decodeHexString(hex) {
    const digits = hex.replace(/\s/g, '');
    const codes = [];
    for (let i = 0; i < digits.length; i += 2) {
      codes.push(parseInt(digits.substr(i, 2).padEnd(2, '0'), 16));
    }
    return codes;
  }

  /**
   * Scompone l'operando di TJ/Tj in una lista di pezzi:
   *   { codes: [...] }  testo
   *   { kerning: n }    spostamento in millesimi di em (positivo = verso sinistra)
   */
  function parseShowText(match) {
    const [, arrayBody, singleString] = match;
    if (singleString !== undefined) return [{ codes: decodeLiteralString(singleString) }];

    const pieces = [];
    const token = /\(((?:[^)\\]|\\.)*)\)|<([0-9a-fA-F\s]*)>|(-?\d*\.?\d+)/g;
    for (const [, literal, hex, number] of arrayBody.matchAll(token)) {
      if (literal !== undefined) pieces.push({ codes: decodeLiteralString(literal) });
      else if (hex !== undefined) pieces.push({ codes: decodeHexString(hex) });
      else pieces.push({ kerning: parseFloat(number) });
    }
    return pieces;
  }

  /** Legge un blocco BT…ET. Restituisce null se il blocco non mostra testo. */
  function parseTextBlock(block) {
    const showText = block.match(PATTERNS.showText);
    if (!showText) return null;

    const pieces = parseShowText(showText);
    const text = pieces
      .filter((piece) => piece.codes)
      .map((piece) => String.fromCharCode(...piece.codes))
      .join('');

    const font = block.match(PATTERNS.setFont);
    const matrix = block.match(PATTERNS.textMatrix);
    return {
      text,
      pieces,
      fontKey: font && font[1],
      fontSize: font && parseFloat(font[2]),
      matrix: matrix && matrix.slice(1, 7).map(parseFloat), // [a, b, c, d, x, y]
    };
  }

  /** Tutti i blocchi di testo di un content stream, con il loro contenuto. */
  function findTextBlocks(content) {
    return (content.match(PATTERNS.textBlock) || [])
      .map((source) => ({ source, ...parseTextBlock(source) }))
      .filter((block) => block.text && block.text.trim());
  }

  /**
   * Riscrive il primo blocco che mostra `text`, sostituendo font, matrice e testo.
   * Tutto il resto del blocco (per esempio il colore) resta com'è.
   * Restituisce null se il blocco non viene trovato.
   */
  function replaceTextBlock(content, text, { fontKey, matrix, showText }) {
    let found = false;
    const updated = content.replace(PATTERNS.textBlock, (block) => {
      if (found || parseTextBlock(block)?.text !== text) return block;
      found = true;
      return block
        .replace(PATTERNS.setFont, `/${fontKey} 1 Tf`)
        .replace(PATTERNS.textMatrix, `${matrix.map(formatNumber).join(' ')} Tm`)
        .replace(PATTERNS.showText, `[${showText}]TJ`);
    });
    return found ? updated : null;
  }

  // Al massimo 4 decimali: più che sufficienti per posizioni in punti tipografici.
  function formatNumber(n) {
    return String(Math.round(n * 10000) / 10000);
  }

  const PdfText = {
    bytesToString,
    stringToBytes,
    findTextBlocks,
    replaceTextBlock,
    formatNumber,
  };

  if (typeof module === 'object' && module.exports) module.exports = PdfText;
  else global.PdfText = PdfText;
})(globalThis);
