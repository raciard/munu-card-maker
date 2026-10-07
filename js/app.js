/*
 * Interfaccia del generatore: modello scelto dall'utente, font del nome da CDN,
 * lista dei nomi, anteprima e download.
 * La creazione dei PDF è in tessera.js, il disegno dell'anteprima in preview.js.
 */
(() => {
  'use strict';

  // Font del nome: DejaVu Sans Bold, con licenza libera.
  const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf';
  const FONT_INTEGRITY = 'sha384-NaVuSXCZeye4QyXzNedGU5Jz3B9xbAydt90g8TJAfHeosmQCXUNytQnYH5ZzJgKv';
  const PREVIEW_EXAMPLE = 'Nome Cognome'; // mostrato quando la lista è vuota

  const ui = {
    names: byId('names'),
    namesFile: byId('names-file'),
    clearNames: byId('clear-names'),
    nameCount: byId('name-count'),
    issues: byId('issues'),
    issuesList: byId('issues-list'),

    templateFile: byId('template-file'),
    dropzone: byId('dropzone'),
    templateInfo: byId('template-info'),
    templateName: byId('template-name'),
    templateDetails: byId('template-details'),
    fieldPicker: byId('field-picker'),
    fieldText: byId('field-text'),
    pickField: byId('pick-field'),
    alignInputs: document.querySelectorAll('input[name="align"]'),
    filesStatus: byId('files-status'),

    removeHiddenData: byId('remove-hidden-data'),
    downloadZip: byId('download-zip'),
    downloadMerged: byId('download-merged'),
    downloadCurrent: byId('download-current'),
    downloadHint: byId('download-hint'),
    progress: byId('progress'),
    progressFill: byId('progress-fill'),
    generateStatus: byId('generate-status'),

    previewEmpty: byId('preview-empty'),
    previewLabel: byId('preview-label'),
    previewCaption: document.querySelector('.preview-caption'),
    fieldOverlay: byId('field-overlay'),
    previousName: byId('previous-name'),
    nextName: byId('next-name'),
  };

  const state = {
    template: null,     // risultato di Tessera.readTemplate
    fontBytes: null,
    fontFailed: false,
    templateVersion: 0, // cresce a ogni modello scelto: l'anteprima va rifatta
    fieldIndex: null,   // quale testo del modello sostituire (indice in template.fields)
    align: 'center',    // 'left' | 'center' | 'right'
    choosingField: false, // true mentre si sceglie il testo cliccando sull'anteprima
    previewIndex: 0,    // quale nome mostra l'anteprima
    busy: false,        // true mentre si generano i PDF
  };

  const showPdf = createPdfPreview(byId('card-preview'));

  // ── Modello e font ───────────────────────────────────────────────────────

  async function useTemplate(file) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const template = await Tessera.readTemplate(bytes);
      completeFieldsWithPdfJs(template, await readPdfTexts(bytes));
      if (template.fields.length === 0) throw new Error('nessun testo modificabile trovato');

      state.template = template;
      state.templateVersion++;
      showStatus(ui.filesStatus, '', '');

      const { box, fields } = template;
      ui.templateName.textContent = file.name;
      ui.templateDetails.textContent = `${toMillimeters(box.width)} × ${toMillimeters(box.height)} mm · `
        + (fields.length === 1 ? '1 testo modificabile' : `${fields.length} testi modificabili`);

      // Con un solo testo non c'è niente da scegliere.
      if (fields.length === 1) {
        chooseField(0);
      } else {
        state.fieldIndex = null;
        state.choosingField = true;
      }
    } catch (error) {
      state.template = null;
      showStatus(ui.filesStatus, 'err', html`${file.name}: ${error.message}`);
    }
    ui.dropzone.hidden = Boolean(state.template);
    ui.templateInfo.hidden = !state.template;
    refresh();
  }

  // pdf.js legge il testo e la sua larghezza con qualsiasi tipo di font, il parser
  // di tessera.js solo con i font semplici: abbino i testi per posizione e uso
  // quelli di pdf.js. pdf.js può spezzare una riga in più pezzi, che qui riunisco.
  function completeFieldsWithPdfJs(template, pdfTexts) {
    for (const field of template.fields) {
      const tolerance = Math.max(0.5, field.fontSize * 0.05);
      const near = (a, b) => Math.abs(a - b) < tolerance;
      const otherStarts = template.fields
        .filter((other) => other !== field && near(other.baselineY, field.baselineY))
        .map((other) => other.x);
      const sameLine = pdfTexts
        .filter((item) => near(item.y, field.baselineY))
        .sort((a, b) => a.x - b.x);

      const pieces = [];
      let end = null;
      for (const item of sameLine) {
        const startsHere = end === null && near(item.x, field.x);
        const continuesLine = end !== null
          && item.x > end - tolerance
          && item.x < end + field.fontSize
          && !otherStarts.some((x) => near(x, item.x));
        if (startsHere || continuesLine) {
          pieces.push(item.text);
          end = item.x + item.width;
        } else if (end !== null) {
          break;
        }
      }
      if (pieces.length > 0) {
        field.text = pieces.join('');
        field.width = end - field.x;
      }
    }
    template.fields = template.fields.filter((field) => field.text.trim());
  }

  function chooseField(index) {
    const field = state.template.fields[index];
    state.fieldIndex = index;
    state.align = Tessera.suggestAlignment(state.template, field);
    state.choosingField = false;
    refresh();
  }

  function selectedField() {
    return state.template && state.fieldIndex !== null ? state.template.fields[state.fieldIndex] : null;
  }

  async function loadFont() {
    try {
      const response = await fetch(FONT_URL, { integrity: FONT_INTEGRITY });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.fontBytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      state.fontFailed = true;
      showStatus(ui.filesStatus, 'err', html`Font non caricato (${error.message}): controlla la connessione e ricarica la pagina.`);
    }
    refresh();
  }

  // ── Nomi ─────────────────────────────────────────────────────────────────

  function readNames() {
    return ui.names.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // Posizione, nella lista dei nomi, della riga dove si trova il cursore.
  // null se il cursore è su una riga vuota.
  function nameIndexAtCursor() {
    const lines = ui.names.value.split(/\r?\n/);
    const cursorLine = ui.names.value.slice(0, ui.names.selectionStart).split(/\r?\n/).length - 1;
    if (!lines[cursorLine]?.trim()) return null;
    return lines.slice(0, cursorLine).filter((line) => line.trim()).length;
  }

  // TXT o CSV: prende la prima colonna di ogni riga.
  function namesFromFile(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.split(/[;,\t]/)[0].replace(/^"|"$/g, '').trim())
      .filter(Boolean);
  }

  async function importNames(file) {
    ui.names.value = namesFromFile(await file.text()).join('\n');
    state.previewIndex = 0;
    refresh();
  }

  function findIssues(names) {
    if (!state.fontBytes) return [];
    const issues = [];

    for (const name of names) {
      const missing = Tessera.missingCharacters(state.fontBytes, name);
      if (missing.length > 0) {
        issues.push(`"${name}": caratteri non presenti nel font → ${missing.join(' ')}`);
      }
    }

    const nameByFile = new Map();
    for (const name of names) {
      const file = Tessera.fileNameFor(name);
      const other = nameByFile.get(file);
      if (other && other !== name) issues.push(`"${name}" e "${other}" producono lo stesso nome file`);
      nameByFile.set(file, name);
    }

    return issues;
  }

  // ── Aggiornamento della pagina ───────────────────────────────────────────

  function refresh() {
    const names = readNames();

    ui.nameCount.innerHTML = names.length === 0 ? ''
      : `<b>${names.length}</b> ${names.length === 1 ? 'nome' : 'nomi'}`;

    const issues = findIssues(names);
    ui.issuesList.replaceChildren(...issues.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
    ui.issues.hidden = issues.length === 0;

    const missing = whatIsMissing(names);
    const canGenerate = !missing && !state.busy;
    ui.downloadZip.disabled = !canGenerate;
    ui.downloadMerged.disabled = !canGenerate;
    ui.downloadCurrent.disabled = !canGenerate;
    ui.downloadHint.textContent = missing
      || `${names.length} ${names.length === 1 ? 'tessera pronta' : 'tessere pronte'}.`;

    renderFieldPicker();
    renderPreview();
  }

  function renderFieldPicker() {
    const field = selectedField();
    ui.fieldPicker.hidden = !state.template;
    ui.fieldText.textContent = field ? `«${field.text}»` : 'Da scegliere nell\'anteprima';
    ui.fieldText.title = field ? field.text : '';
    ui.pickField.textContent = state.choosingField && field ? 'Annulla' : 'Cambia';
    ui.pickField.hidden = state.choosingField && !field;
    for (const input of ui.alignInputs) {
      input.checked = input.value === state.align;
      input.disabled = !field;
    }
  }

  // Cosa serve ancora prima di poter scaricare (null se c'è tutto).
  function whatIsMissing(names) {
    if (!state.template) return 'Per iniziare scegli un modello (passaggio 1).';
    if (!selectedField()) return "Clicca nell'anteprima sul testo da sostituire (passaggio 1).";
    if (state.fontFailed) return 'Il font non è disponibile.';
    if (!state.fontBytes) return 'Caricamento del font…';
    if (names.length === 0) return 'Aggiungi almeno un nome (passaggio 2).';
    return null;
  }

  function renderPreview() {
    const names = readNames();
    state.previewIndex = clamp(state.previewIndex, 0, names.length - 1);
    const name = names[state.previewIndex] || PREVIEW_EXAMPLE;
    const { template, fontBytes, templateVersion, fieldIndex, align, choosingField } = state;
    const field = selectedField();

    ui.previewCaption.classList.toggle('selecting', choosingField);
    if (choosingField) {
      ui.previewLabel.textContent = 'Clicca sul testo da sostituire';
    } else if (names.length === 0) {
      ui.previewLabel.innerHTML = html`Esempio · <span class="current-name">${name}</span>`;
    } else {
      ui.previewLabel.innerHTML = html`<strong>${state.previewIndex + 1}</strong> / ${names.length} · <span class="current-name">${name}</span>`;
    }
    ui.previousName.disabled = choosingField || state.previewIndex <= 0;
    ui.nextName.disabled = choosingField || state.previewIndex >= names.length - 1;

    renderFieldOverlay();
    ui.previewEmpty.hidden = Boolean(template);
    if (!template) return;

    // L'anteprima è il PDF vero, lo stesso che verrebbe scaricato.
    // Mentre si sceglie il testo (o manca il font) si vede il modello originale.
    if (choosingField || !field || !fontBytes) {
      showPdf(`${templateVersion}:originale`, () => template.bytes);
    } else {
      showPdf(`${templateVersion}:${fieldIndex}:${align}:${name}`,
        () => Tessera.createCard({ template, field, align, fontBytes, name }));
    }
  }

  // Un riquadro cliccabile sopra ogni testo del modello, posizionato in percentuale
  // così segue l'anteprima a qualsiasi dimensione.
  function renderFieldOverlay() {
    const { template, choosingField, fieldIndex } = state;
    ui.fieldOverlay.hidden = !(template && choosingField);
    if (ui.fieldOverlay.hidden) return;

    const { box } = template;
    const percent = (value, total) => `${(100 * value) / total}%`;
    ui.fieldOverlay.replaceChildren(...template.fields.map((field, index) => {
      const top = field.baselineY + field.fontSize * 0.9;    // circa la cima delle maiuscole e degli accenti
      const bottom = field.baselineY - field.fontSize * 0.25; // circa il fondo di g, p, q
      const width = field.width ?? field.fontSize * 0.6 * field.text.length;

      const button = document.createElement('button');
      button.className = index === fieldIndex ? 'field-box selected' : 'field-box';
      button.title = field.text;
      button.setAttribute('aria-label', `Sostituisci «${field.text}»`);
      Object.assign(button.style, {
        left: percent(field.x - box.x, box.width),
        width: percent(width, box.width),
        top: percent(box.y + box.height - top, box.height),
        height: percent(top - bottom, box.height),
      });
      button.addEventListener('click', () => chooseField(index));
      return button;
    }));
  }

  function showStatus(element, tone, message) {
    element.innerHTML = message;
    element.className = `status ${tone}`;
  }

  function showProgress(done, total) {
    ui.progress.hidden = false;
    ui.progressFill.style.width = `${(100 * done) / total}%`;
  }

  // ── Generazione e download ───────────────────────────────────────────────

  function createCard(name) {
    return Tessera.createCard({
      template: state.template,
      field: selectedField(),
      align: state.align,
      fontBytes: state.fontBytes,
      name,
      removeHiddenData: ui.removeHiddenData.checked,
    });
  }

  async function createAllCards(names) {
    const cards = [];
    showProgress(0, names.length);
    for (const name of names) {
      showStatus(ui.generateStatus, '', html`${cards.length + 1} / ${names.length} · ${name}`);
      cards.push({ name, pdf: await createCard(name) });
      showProgress(cards.length, names.length);
      await nextFrame(); // lascia aggiornare la barra di avanzamento
    }
    return cards;
  }

  async function downloadZip() {
    const cards = await createAllCards(readNames());
    const zip = new JSZip();
    const usedNames = new Set();
    for (const card of cards) {
      const fileName = uniqueFileName(Tessera.fileNameFor(card.name), usedNames);
      zip.file(fileName, card.pdf);
    }
    saveFile(await zip.generateAsync({ type: 'blob' }), 'tessere.zip');
    showStatus(ui.generateStatus, 'ok', `✓ ${cards.length} tessere`);
  }

  async function downloadMerged() {
    const cards = await createAllCards(readNames());
    const merged = await Tessera.mergeCards(cards.map((card) => card.pdf));
    saveFile(pdfBlob(merged), 'tessere.pdf');
    showStatus(ui.generateStatus, 'ok', `✓ ${cards.length} tessere`);
  }

  async function downloadCurrent() {
    const name = readNames()[state.previewIndex];
    saveFile(pdfBlob(await createCard(name)), Tessera.fileNameFor(name));
    showStatus(ui.generateStatus, 'ok', html`✓ ${name}`);
  }

  // Esegue un download bloccando i pulsanti e mostrando eventuali errori.
  async function runDownload(download) {
    state.busy = true;
    refresh();
    try {
      await download();
    } catch (error) {
      console.error(error);
      showStatus(ui.generateStatus, 'err', html`${error.message}`);
    } finally {
      state.busy = false;
      setTimeout(() => (ui.progress.hidden = true), 600);
      refresh();
    }
  }

  // "tessera_Mario_Rossi.pdf" → "tessera_Mario_Rossi_2.pdf" se è già stato usato.
  function uniqueFileName(fileName, usedNames) {
    let candidate = fileName;
    for (let n = 2; usedNames.has(candidate); n++) {
      candidate = fileName.replace(/\.pdf$/, `_${n}.pdf`);
    }
    usedNames.add(candidate);
    return candidate;
  }

  function saveFile(blob, fileName) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }

  // ── Eventi ───────────────────────────────────────────────────────────────

  function followCursor() {
    const index = nameIndexAtCursor();
    if (index !== null && index !== state.previewIndex) {
      state.previewIndex = index;
      renderPreview();
    }
  }

  ui.names.addEventListener('input', () => {
    refresh();
    followCursor();
  });
  ui.names.addEventListener('click', followCursor);
  ui.names.addEventListener('keyup', followCursor);

  ui.clearNames.addEventListener('click', () => {
    ui.names.value = '';
    state.previewIndex = 0;
    refresh();
    ui.names.focus();
  });

  ui.pickField.addEventListener('click', () => {
    state.choosingField = !state.choosingField;
    refresh();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.choosingField && selectedField()) {
      state.choosingField = false;
      refresh();
    }
  });
  for (const input of ui.alignInputs) {
    input.addEventListener('change', () => {
      state.align = input.value;
      refresh();
    });
  }

  ui.previousName.addEventListener('click', () => {
    state.previewIndex--;
    renderPreview();
  });
  ui.nextName.addEventListener('click', () => {
    state.previewIndex++;
    renderPreview();
  });

  onFileChosen(ui.templateFile, useTemplate);
  onFileChosen(ui.namesFile, importNames);

  // Si può trascinare un file in qualsiasi punto della pagina:
  // un modello (.ai, .pdf) oppure una lista di nomi (.txt, .csv).
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (++dragDepth === 1) ui.dropzone.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth === 0) ui.dropzone.classList.remove('dragging');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    ui.dropzone.classList.remove('dragging');
    const [file] = event.dataTransfer.files;
    if (!file) return;
    if (/\.(txt|csv)$/i.test(file.name)) importNames(file);
    else useTemplate(file);
  });

  ui.downloadZip.addEventListener('click', () => runDownload(downloadZip));
  ui.downloadMerged.addEventListener('click', () => runDownload(downloadMerged));
  ui.downloadCurrent.addEventListener('click', () => runDownload(downloadCurrent));

  // ── Avvio ────────────────────────────────────────────────────────────────

  refresh();
  loadFont();

  // ── Piccole utilità ──────────────────────────────────────────────────────

  function byId(id) {
    return document.getElementById(id);
  }

  // Template string per HTML: i valori inseriti con ${…} vengono sempre resi sicuri.
  function html(strings, ...values) {
    return strings.reduce((result, part, i) => result + escapeHtml(values[i - 1]) + part);
  }

  function escapeHtml(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    return String(value).replace(/[&<>"]/g, (char) => entities[char]);
  }

  function onFileChosen(input, handler) {
    input.addEventListener('change', () => {
      const [file] = input.files;
      input.value = ''; // permette di riscegliere lo stesso file
      if (file) handler(file);
    });
  }

  function pdfBlob(bytes) {
    return new Blob([bytes], { type: 'application/pdf' });
  }

  function toMillimeters(points) {
    return Math.round((points / 72) * 25.4);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function nextFrame() {
    return new Promise((resolve) => setTimeout(resolve));
  }
})();
