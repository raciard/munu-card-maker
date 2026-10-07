/*
 * Anteprima della tessera: genera il PDF vero e lo disegna con pdf.js.
 *
 * Per restare fluida mentre si scrive:
 *  - disegna solo la richiesta più recente: se mentre lavora arrivano altre
 *    richieste, quelle intermedie vengono saltate;
 *  - prepara l'immagine su una tela nascosta e la copia su quella visibile
 *    solo quando è pronta, così l'anteprima non sfarfalla mai.
 */
(function (global) {
  'use strict';

  const pdfjs = global.pdfjsLib || global['pdfjs-dist/build/pdf'];
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // Un solo worker per tutte le anteprime. Di default pdf.js ne avvia uno nuovo per
  // ogni documento, e quell'avvio costa circa 90 ms: troppo per seguire la digitazione.
  let sharedWorker = null;
  function worker() {
    sharedWorker ??= new pdfjs.PDFWorker();
    return sharedWorker;
  }

  /**
   * @param canvas  la tela dove mostrare la tessera
   * @returns show(key, makePdf): chiede di mostrare un PDF.
   *          `key` identifica il contenuto: se è uguale all'ultimo disegnato non si rifà nulla.
   *          `makePdf` è una funzione che restituisce i byte del PDF (anche async).
   */
  function createPdfPreview(canvas) {
    const offscreen = document.createElement('canvas');
    let pending = null;  // ultima richiesta non ancora disegnata
    let shown = null;    // richiesta attualmente visibile
    let working = false;

    function show(key, makePdf) {
      pending = { key, makePdf }; // sostituisce un'eventuale richiesta precedente non ancora iniziata
      drawPending();
    }

    async function drawPending() {
      if (working) return; // ci penserà il ciclo già in corso
      working = true;
      while (pending) {
        const request = pending;
        pending = null;
        if (isShown(request)) continue;
        try {
          await draw(await request.makePdf());
          shown = { ...request, width: targetWidth() };
        } catch (error) {
          console.error('Anteprima non riuscita:', error);
        }
      }
      working = false;
    }

    async function draw(pdfBytes) {
      // pdf.js si prende i byte (li sposta nel worker): gli passo una copia.
      const pdf = await pdfjs.getDocument({ data: pdfBytes.slice(), worker: worker() }).promise;
      try {
        const page = await pdf.getPage(1);
        const scale = targetWidth() / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });

        offscreen.width = Math.round(viewport.width);
        offscreen.height = Math.round(viewport.height);
        await page.render({ canvasContext: offscreen.getContext('2d'), viewport }).promise;

        canvas.width = offscreen.width;
        canvas.height = offscreen.height;
        canvas.getContext('2d').drawImage(offscreen, 0, 0);
      } finally {
        pdf.destroy();
      }
    }

    function isShown(request) {
      return shown !== null && shown.key === request.key && shown.width === targetWidth();
    }

    // Larghezza in pixel reali dello schermo, per un'immagine nitida anche su schermi ad alta densità.
    function targetWidth() {
      return Math.round(canvas.clientWidth * (global.devicePixelRatio || 1));
    }

    // Se la tela cambia dimensione (finestra ridimensionata), ridisegna l'ultima tessera.
    new ResizeObserver(() => {
      // (se c'è già un disegno in corso, sarà quello a usare la nuova dimensione)
      if (shown && !working && !isShown(shown)) show(shown.key, shown.makePdf);
    }).observe(canvas);

    return show;
  }

  /**
   * Testi della prima pagina come li legge pdf.js: contenuto leggibile per ogni
   * tipo di font e misure precise, in punti sulla pagina (origine in basso a sinistra).
   * @returns [{ text, x, y, width }]  (y è la linea di base)
   */
  async function readPdfTexts(pdfBytes) {
    const pdf = await pdfjs.getDocument({ data: pdfBytes.slice(), worker: worker() }).promise;
    try {
      const page = await pdf.getPage(1);
      const { items } = await page.getTextContent();
      return items
        .filter((item) => item.str !== undefined)
        .map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width }));
    } finally {
      pdf.destroy();
    }
  }

  global.createPdfPreview = createPdfPreview;
  global.readPdfTexts = readPdfTexts;
})(globalThis);
