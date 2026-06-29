/**
 * FM Flood Mask Correction Tool
 * Mask convention: white (255) = flood/change, black (0) = no flood/no change
 */


// STATE
// ============================================================
const S = {
    // Loaded images (HTMLImageElement)
    onImage: null,
    beforeImage: null,

    // Offscreen canvases — native image resolution
    fmMaskCanvas:    null,   // immutable FM reference (thresholded)
    finalMaskCanvas: null,   // editable final mask

    // Overlay canvases — RGBA coloured display versions
    finalOverlayCanvas: null,
    fmOverlayCanvas:    null,
    diffOverlayCanvas:  null,

    // Contexts (set when canvases are created)
    fmMaskCtx:       null,
    finalMaskCtx:    null,
    finalOverlayCtx: null,
    fmOverlayCtx:    null,
    diffOverlayCtx:  null,

    // Display canvas (visible)
    displayCanvas: null,
    ctx: null,

    // Image size (set when ON image loads)
    imgW: 0,
    imgH: 0,

    // Load flags
    onLoaded:    false,
    beforeLoaded: false,
    fmLoaded:    false,
    maskReady:   false,   // finalMaskCanvas has been populated

    // Filenames
    onFileName:       '',
    beforeFileName:   '',
    fmFileName:       '',
    existingFileName: '',

    // Viewport
    dpr: window.devicePixelRatio || 1,
    renderScale: 2,
    maxEffDpr: 6,
    vpW: 0, vpH: 0,
    scale: 1,
    panX: 0, panY: 0,

    // Interaction
    activeTool: 'add',   // 'add' | 'remove' | 'pan'
    isDrawing: false,
    isDragging: false,
    lastPos: null,
    dragStartX: 0, dragStartY: 0,
    cursorX: 0, cursorY: 0,
    cursorIn: false,
    spaceHeld: false,
    toolBeforeSpace: null,

    // Brush
    brushSize: 20,

    // Opacity
    beforeOpacity: 0.5,
    maskOpacity:   0.6,
    fmOpacity:     0.5,

    // Visibility toggles
    showBefore:    true,
    showFinalMask: true,
    showFmRef:     false,
    showDiff:      false,

    // Undo / Redo
    undoStack: [],
    redoStack: [],
    maxHistory: 20,

    // Sample metadata
    pairId:        '',
    annotator:     '',
    qualityStatus: 'draft',
    notes:         '',

    // Unsaved flag
    hasUnsaved: false,

    // Pending mask images waiting for canvas init
    _pendingFm:       null,
    _pendingExisting: null,
    _pendingWhich:    null,   // 'fm' or 'existing' — for resize modal

    // Autosave timer
    _autosaveTimer: null,
    _pendingAutosaveData: null,
};

// Expose state on window so browser dev-tools and automated tests can inspect it
window.S = S;

// ============================================================
// DOM ELEMENT CACHE
// ============================================================
const E = {};

function cacheEls() {
    const ids = [
        'topStatusBar','statusSample','statusOn','statusBefore','statusFm',
        'statusTool','statusBrush','statusZoom','statusUnsaved','unsavedSep',
        'displayCanvas','mainView',
        'onImageInput','beforeImageInput','fmMaskInput','existingMaskInput',
        'onImageName','beforeImageName','fmMaskName','existingMaskName',
        'dimMismatchBox','btnResizeMask','btnCancelMaskLoad',
        'dropHint',
        'pairIdInput','annotatorInput','qualitySelect','notesInput',
        'beforeOpacity','maskOpacity','fmOpacity',
        'beforeOpacityVal','maskOpacityVal','fmOpacityVal',
        'renderScale','renderScaleVal',
        'toggleBefore','toggleFinalMask','toggleFmRef','toggleDiff',
        'btnResetView',
        'btnAddFlood','btnRemoveFlood','btnPan',
        'brushSize','brushSizeVal',
        'btnUndo','btnRedo','btnResetToFm','btnClearMask',
        'statFmPx','statFinalPx','statAddedPx','statRemovedPx','statCorrPct','statAreaPct',
        'statsWarnings','btnRefreshStats',
        'btnDownloadFinal','btnDownloadDiff','btnDownloadPreview','btnDownloadMeta',
        'loadingOverlay','toastContainer','canvasLegend',
        'helpModal','btnHelp','btnCloseHelp',
        'autosaveModal','autosaveMsg','btnRestoreAutosave','btnIgnoreAutosave','btnDeleteAutosave',
    ];
    ids.forEach(id => { E[id] = document.getElementById(id); });
}

// ============================================================
// CANVAS HELPERS
// ============================================================
function makeCanvas(w, h, willRead = false) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    if (willRead) c.getContext('2d', { willReadFrequently: true });
    return c;
}

function getCtx(canvas, willRead = false) {
    return willRead
        ? canvas.getContext('2d', { willReadFrequently: true })
        : canvas.getContext('2d');
}

// ============================================================
// CANVAS INITIALIZATION (called when ON image first loads)
// ============================================================
function initMaskCanvases(w, h) {
    S.imgW = w; S.imgH = h;

    S.fmMaskCanvas    = makeCanvas(w, h);
    S.fmMaskCtx       = getCtx(S.fmMaskCanvas, true);
    // Start FM canvas all-black
    S.fmMaskCtx.fillStyle = '#000';
    S.fmMaskCtx.fillRect(0, 0, w, h);

    S.finalMaskCanvas = makeCanvas(w, h);
    S.finalMaskCtx    = getCtx(S.finalMaskCanvas, true);
    // Start final canvas all-black (no flood)
    S.finalMaskCtx.fillStyle = '#000';
    S.finalMaskCtx.fillRect(0, 0, w, h);

    S.finalOverlayCanvas = makeCanvas(w, h);
    S.finalOverlayCtx    = getCtx(S.finalOverlayCanvas);

    S.fmOverlayCanvas = makeCanvas(w, h);
    S.fmOverlayCtx    = getCtx(S.fmOverlayCanvas);

    S.diffOverlayCanvas = makeCanvas(w, h);
    S.diffOverlayCtx    = getCtx(S.diffOverlayCanvas);

    S.maskReady = true;
    updateAllOverlays();
    clearHistory();
}

// ============================================================
// THRESHOLD HELPERS
// ============================================================
// Write a thresholded binary version of srcImage into targetCtx at (w x h).
// intensity > 128 → 255 (flood/white); else → 0 (no-flood/black).
// Uses nearest-neighbor so binary masks are never blurred.
function thresholdImageInto(srcImage, targetCtx, w, h) {
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tCtx = tmp.getContext('2d', { willReadFrequently: true });
    tCtx.imageSmoothingEnabled = false;
    tCtx.drawImage(srcImage, 0, 0, w, h);
    const imgData = tCtx.getImageData(0, 0, w, h);
    binaryThresholdData(imgData.data);
    targetCtx.putImageData(imgData, 0, 0);
}

// Threshold image data in-place.
function binaryThresholdData(data) {
    for (let i = 0; i < data.length; i += 4) {
        const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const v = gray > 128 ? 255 : 0;
        data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
}

// Threshold an existing canvas context in-place.
function thresholdCtxInPlace(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    binaryThresholdData(imgData.data);
    ctx.putImageData(imgData, 0, 0);
}

// ============================================================
// OVERLAY COMPUTATION
// ============================================================
function updateFinalOverlay() {
    if (!S.maskReady) return;
    const w = S.imgW, h = S.imgH;
    const src = S.finalMaskCtx.getImageData(0, 0, w, h);
    const dst = new ImageData(w, h);
    const s = src.data, d = dst.data;
    for (let i = 0; i < s.length; i += 4) {
        if (s[i] > 128) { // flood pixel — render red
            d[i] = 220; d[i + 1] = 50; d[i + 2] = 50; d[i + 3] = 200;
        } else {
            d[i + 3] = 0; // transparent
        }
    }
    S.finalOverlayCtx.putImageData(dst, 0, 0);
}

function updateFmOverlay() {
    if (!S.fmLoaded) return;
    const w = S.imgW, h = S.imgH;
    const src = S.fmMaskCtx.getImageData(0, 0, w, h);
    const dst = new ImageData(w, h);
    const s = src.data, d = dst.data;
    for (let i = 0; i < s.length; i += 4) {
        if (s[i] > 128) { // FM flood pixel — render orange
            d[i] = 255; d[i + 1] = 140; d[i + 2] = 0; d[i + 3] = 200;
        } else {
            d[i + 3] = 0;
        }
    }
    S.fmOverlayCtx.putImageData(dst, 0, 0);
}

function updateDiffOverlay() {
    if (!S.maskReady) return;
    const w = S.imgW, h = S.imgH;
    const dst = new ImageData(w, h);
    const d = dst.data;

    if (!S.fmLoaded) {
        S.diffOverlayCtx.clearRect(0, 0, w, h);
        return;
    }

    const fm  = S.fmMaskCtx.getImageData(0, 0, w, h).data;
    const fin = S.finalMaskCtx.getImageData(0, 0, w, h).data;

    for (let i = 0; i < fm.length; i += 4) {
        const fmF  = fm[i]  > 128;
        const finF = fin[i] > 128;

        if (finF && !fmF) {
            // Human added flood (green)
            d[i] = 50; d[i + 1] = 200; d[i + 2] = 80; d[i + 3] = 220;
        } else if (!finF && fmF) {
            // Human removed flood (blue)
            d[i] = 80; d[i + 1] = 120; d[i + 2] = 255; d[i + 3] = 220;
        } else if (finF && fmF) {
            // Unchanged flood — both agree (yellow)
            d[i] = 220; d[i + 1] = 200; d[i + 2] = 50; d[i + 3] = 200;
        } else {
            d[i + 3] = 0; // no flood in both — transparent
        }
    }
    S.diffOverlayCtx.putImageData(dst, 0, 0);
}

function updateAllOverlays() {
    updateFinalOverlay();
    updateFmOverlay();
    updateDiffOverlay();
}

// ============================================================
// RENDER LOOP
// ============================================================
function startRenderLoop() {
    function loop() {
        render();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

function render() {
    const { ctx, scale, panX, panY, dpr, renderScale, maxEffDpr, vpW, vpH } = S;
    if (!ctx) return;

    const eDpr = Math.min(dpr * renderScale, maxEffDpr);

    // Clear with background colour
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#080810';
    ctx.fillRect(0, 0, S.displayCanvas.width, S.displayCanvas.height);

    if (!S.onLoaded) {
        // Draw placeholder
        ctx.setTransform(eDpr, 0, 0, eDpr, 0, 0);
        ctx.fillStyle = '#3a3a5a';
        ctx.font = '16px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Load the ON/FLOOD image to begin.', vpW / 2, vpH / 2);
        return;
    }

    // Apply zoom + pan transform
    ctx.setTransform(
        scale * eDpr, 0,
        0, scale * eDpr,
        panX * eDpr, panY * eDpr
    );
    ctx.imageSmoothingEnabled = false;

    // 1. ON/FLOOD image (base)
    ctx.globalAlpha = 1;
    ctx.drawImage(S.onImage, 0, 0);

    // 2. BEFORE image overlay
    if (S.beforeImage && S.showBefore && S.beforeOpacity > 0) {
        ctx.globalAlpha = S.beforeOpacity;
        ctx.drawImage(S.beforeImage, 0, 0, S.imgW, S.imgH);
        ctx.globalAlpha = 1;
    }

    // 3. FM reference overlay (orange)
    if (S.fmLoaded && S.showFmRef && S.fmOpacity > 0) {
        ctx.globalAlpha = S.fmOpacity;
        ctx.drawImage(S.fmOverlayCanvas, 0, 0);
        ctx.globalAlpha = 1;
    }

    // 4. Final mask overlay (red) OR diff overlay
    if (S.maskReady) {
        if (S.showDiff && S.fmLoaded && S.maskOpacity > 0) {
            ctx.globalAlpha = S.maskOpacity;
            ctx.drawImage(S.diffOverlayCanvas, 0, 0);
            ctx.globalAlpha = 1;
        } else if (S.showFinalMask && S.maskOpacity > 0) {
            ctx.globalAlpha = S.maskOpacity;
            ctx.drawImage(S.finalOverlayCanvas, 0, 0);
            ctx.globalAlpha = 1;
        }
    }

    // 5. Brush cursor (drawn in world/image space)
    if (S.cursorIn && S.activeTool !== 'pan') {
        const r = S.brushSize / 2;
        const lw = 1.5 / scale;

        ctx.beginPath();
        ctx.arc(S.cursorX, S.cursorY, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = lw * 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(S.cursorX, S.cursorY, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = lw;
        ctx.stroke();
    }
}

// ============================================================
// IMAGE LOADING
// ============================================================
function loadImageFromFile(file, callback) {
    const reader = new FileReader();
    reader.onload = e => {
        const img = new Image();
        img.onload = () => callback(img);
        img.onerror = () => showToast(`Failed to load image: ${file.name}`, 'error');
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

function handleOnFile(file) {
    if (!file) return;
    loadImageFromFile(file, img => {
        S.onImage    = img;
        S.onFileName = file.name;
        S.onLoaded   = true;

        E.onImageName.textContent = file.name;

        // (Re-)initialize mask canvases to this image's dimensions
        initMaskCanvases(img.width, img.height);
        fitToScreen();
        updateStatusBar();

        // Apply any masks that arrived before ON image
        if (S._pendingFm) {
            const pend = S._pendingFm;
            S._pendingFm = null;
            processFmImage(pend);
        }
        if (S._pendingExisting) {
            const pend = S._pendingExisting;
            S._pendingExisting = null;
            processExistingMaskImage(pend);
        }

        tryAutoFillPairId();
        showToast('ON/FLOOD image loaded. Load BEFORE image for comparison.', 'info');
    });
}

function handleBeforeFile(file) {
    if (!file) return;
    loadImageFromFile(file, img => {
        S.beforeImage    = img;
        S.beforeFileName = file.name;
        S.beforeLoaded   = true;
        E.beforeImageName.textContent = file.name;
        tryAutoFillPairId();
        updateStatusBar();
        showToast('BEFORE image loaded.', 'info');
    });
}

function handleFmMaskFile(file) {
    if (!file) return;
    S.fmFileName = file.name;
    E.fmMaskName.textContent = file.name;
    loadImageFromFile(file, img => {
        if (!S.onLoaded) {
            S._pendingFm = img;
            showToast('FM mask stored. Load ON/FLOOD image first.', 'warn');
            return;
        }
        processFmImage(img);
    });
}

function handleExistingMaskFile(file) {
    if (!file) return;
    S.existingFileName = file.name;
    E.existingMaskName.textContent = file.name;
    loadImageFromFile(file, img => {
        if (!S.onLoaded) {
            S._pendingExisting = img;
            showToast('Existing mask stored. Load ON/FLOOD image first.', 'warn');
            return;
        }
        processExistingMaskImage(img);
    });
}

function processFmImage(img) {
    if (img.width !== S.imgW || img.height !== S.imgH) {
        S._pendingWhich = 'fm';
        S._pendingFm = img;
        E.dimMismatchBox.classList.remove('hidden');
        showToast(`FM mask size (${img.width}×${img.height}) ≠ image size (${S.imgW}×${S.imgH}).`, 'warn');
        return;
    }
    applyFmMask(img, S.imgW, S.imgH);
}

function processExistingMaskImage(img) {
    if (img.width !== S.imgW || img.height !== S.imgH) {
        S._pendingWhich = 'existing';
        S._pendingExisting = img;
        E.dimMismatchBox.classList.remove('hidden');
        showToast(`Existing mask size (${img.width}×${img.height}) ≠ image size (${S.imgW}×${S.imgH}).`, 'warn');
        return;
    }
    applyExistingMask(img, S.imgW, S.imgH);
}

function applyFmMask(img, w, h) {
    E.dimMismatchBox.classList.add('hidden');

    // Write thresholded binary mask into fmMaskCanvas
    thresholdImageInto(img, S.fmMaskCtx, w, h);

    // Copy to finalMaskCanvas (this becomes the starting point)
    pushHistory();
    S.finalMaskCtx.imageSmoothingEnabled = false;
    S.finalMaskCtx.drawImage(S.fmMaskCanvas, 0, 0);

    S.fmLoaded  = true;
    S.maskReady = true;

    updateAllOverlays();
    updateStats();
    updateStatusBar();
    clearHistory(); // fresh start — FM mask is the baseline
    checkAutosave(S.pairId);
    showToast('FM mask loaded. Use Add/Remove Flood tools to correct it.', 'success');
}

function applyExistingMask(img, w, h) {
    E.dimMismatchBox.classList.add('hidden');
    pushHistory();
    thresholdImageInto(img, S.finalMaskCtx, w, h);
    S.maskReady = true;
    updateAllOverlays();
    updateStats();
    markUnsaved();
    showToast('Existing final mask loaded. You can continue editing.', 'info');
}

// ============================================================
// MASK OPERATIONS
// ============================================================
function resetToFmMask() {
    if (!S.fmLoaded) { showToast('No FM mask loaded to reset to.', 'error'); return; }
    if (!confirm('Reset the final mask to the original FM mask?\nAll your corrections will be lost.')) return;
    clearHistory();
    S.finalMaskCtx.imageSmoothingEnabled = false;
    S.finalMaskCtx.clearRect(0, 0, S.imgW, S.imgH);
    S.finalMaskCtx.drawImage(S.fmMaskCanvas, 0, 0);
    updateAllOverlays();
    updateStats();
    markUnsaved();
    showToast('Reset to FM mask.', 'info');
}

function clearFinalMask() {
    if (!S.maskReady) return;
    if (!confirm('Clear the entire final mask (all black = no flood)?')) return;
    pushHistory();
    S.finalMaskCtx.fillStyle = '#000';
    S.finalMaskCtx.fillRect(0, 0, S.imgW, S.imgH);
    updateAllOverlays();
    updateStats();
    markUnsaved();
    showToast('Final mask cleared.', 'info');
}

// ============================================================
// DRAWING — BRUSH PAINTING
// ============================================================
function getWorldPos(clientX, clientY) {
    const rect = S.displayCanvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    return {
        x: (cssX - S.panX) / S.scale,
        y: (cssY - S.panY) / S.scale,
    };
}

function paintAt(x, y) {
    if (!S.maskReady) return;
    const r = S.brushSize / 2;
    S.finalMaskCtx.beginPath();
    S.finalMaskCtx.arc(x, y, r, 0, Math.PI * 2);
    S.finalMaskCtx.fillStyle = S.activeTool === 'add' ? '#ffffff' : '#000000';
    S.finalMaskCtx.fill();
}

function paintLine(x1, y1, x2, y2) {
    if (!S.maskReady) return;
    S.finalMaskCtx.beginPath();
    S.finalMaskCtx.moveTo(x1, y1);
    S.finalMaskCtx.lineTo(x2, y2);
    S.finalMaskCtx.strokeStyle = S.activeTool === 'add' ? '#ffffff' : '#000000';
    S.finalMaskCtx.lineWidth = S.brushSize;
    S.finalMaskCtx.lineCap = 'round';
    S.finalMaskCtx.lineJoin = 'round';
    S.finalMaskCtx.stroke();
}

// After a stroke: threshold to binary, refresh overlays, trigger autosave
function finishStroke() {
    if (!S.maskReady) return;
    thresholdCtxInPlace(S.finalMaskCtx, S.imgW, S.imgH);
    updateAllOverlays();
    updateStats();
    markUnsaved();
    scheduleAutosave();
}

// ============================================================
// POINTER EVENTS
// ============================================================
function setupPointerEvents() {
    const c = S.displayCanvas;

    c.addEventListener('pointerdown', e => {
        // Middle-button or Pan tool or Space held → drag
        if (e.button === 1 || S.activeTool === 'pan' || S.spaceHeld) {
            S.isDragging = true;
            S.dragStartX = e.clientX;
            S.dragStartY = e.clientY;
            c.setPointerCapture(e.pointerId);
            c.style.cursor = 'grabbing';
            return;
        }

        if (e.button === 0 && S.onLoaded) {
            if (!S.maskReady) {
                showToast('Load FM Mask first (or it will start all-black).', 'warn');
                // Allow drawing even without FM mask
            }
            S.isDrawing = true;
            pushHistory();
            const pos = getWorldPos(e.clientX, e.clientY);
            paintAt(pos.x, pos.y);
            S.lastPos = pos;
            c.setPointerCapture(e.pointerId);
        }
    });

    c.addEventListener('pointermove', e => {
        const pos = getWorldPos(e.clientX, e.clientY);
        S.cursorX = pos.x;
        S.cursorY = pos.y;
        S.cursorIn = true;

        // Update status bar cursor coords
        updateCursorStatus(Math.floor(pos.x), Math.floor(pos.y));

        if (S.isDragging) {
            const dx = e.clientX - S.dragStartX;
            const dy = e.clientY - S.dragStartY;
            S.panX += dx; S.panY += dy;
            S.dragStartX = e.clientX; S.dragStartY = e.clientY;
        } else if (S.isDrawing && S.lastPos) {
            paintLine(S.lastPos.x, S.lastPos.y, pos.x, pos.y);
            S.lastPos = pos;
        }
    });

    c.addEventListener('pointerup', e => {
        if (S.isDrawing) finishStroke();
        S.isDrawing = false;
        S.isDragging = false;
        S.lastPos = null;
        if (S.activeTool === 'pan' || S.spaceHeld) {
            c.style.cursor = 'grab';
        } else {
            c.style.cursor = 'crosshair';
        }
    });

    c.addEventListener('pointerleave', () => {
        S.cursorIn = false;
        if (S.isDrawing) finishStroke();
        S.isDrawing = false;
        S.isDragging = false;
        S.lastPos = null;
    });

    c.addEventListener('wheel', handleWheel, { passive: false });
}

// ============================================================
// ZOOM / PAN
// ============================================================
function handleWheel(e) {
    e.preventDefault();
    if (!S.onLoaded) return;

    const rect = S.displayCanvas.getBoundingClientRect();
    const mX = e.clientX - rect.left;
    const mY = e.clientY - rect.top;

    const dir = e.deltaY < 0 ? 1 : -1;
    const zoom = Math.exp(dir * 0.12);
    const newScale = Math.max(0.05, Math.min(60, S.scale * zoom));

    const wX = (mX - S.panX) / S.scale;
    const wY = (mY - S.panY) / S.scale;
    S.panX = mX - wX * newScale;
    S.panY = mY - wY * newScale;
    S.scale = newScale;

    updateZoomStatus();
}

function zoomBy(factor) {
    if (!S.onLoaded) return;
    const cx = S.vpW / 2, cy = S.vpH / 2;
    const newScale = Math.max(0.05, Math.min(60, S.scale * factor));
    const wX = (cx - S.panX) / S.scale;
    const wY = (cy - S.panY) / S.scale;
    S.panX = cx - wX * newScale;
    S.panY = cy - wY * newScale;
    S.scale = newScale;
    updateZoomStatus();
}

function fitToScreen() {
    if (!S.onLoaded) return;
    const cw = S.vpW || S.displayCanvas.clientWidth;
    const ch = S.vpH || S.displayCanvas.clientHeight;
    const sw = (cw - 40) / S.imgW;
    const sh = (ch - 40) / S.imgH;
    S.scale = Math.min(sw, sh);
    S.panX = (cw - S.imgW * S.scale) / 2;
    S.panY = (ch - S.imgH * S.scale) / 2;
    updateZoomStatus();
}

function resizeDisplayCanvas() {
    const container = document.getElementById('mainView');
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;
    const eDpr = Math.min(S.dpr * S.renderScale, S.maxEffDpr);

    S.vpW = cssW; S.vpH = cssH; S.dpr = window.devicePixelRatio || 1;

    const c = S.displayCanvas;
    c.width  = Math.max(1, Math.floor(cssW * eDpr));
    c.height = Math.max(1, Math.floor(cssH * eDpr));
    c.style.width  = `${cssW}px`;
    c.style.height = `${cssH}px`;
}

// ============================================================
// UNDO / REDO
// ============================================================
function snapshotMask() {
    return S.finalMaskCtx.getImageData(0, 0, S.imgW, S.imgH);
}

function pushHistory() {
    if (!S.maskReady) return;
    if (S.undoStack.length >= S.maxHistory) S.undoStack.shift();
    S.undoStack.push(snapshotMask());
    S.redoStack = [];
    updateHistoryButtons();
}

function undoMask() {
    if (S.undoStack.length === 0) return;
    S.redoStack.push(snapshotMask());
    S.finalMaskCtx.putImageData(S.undoStack.pop(), 0, 0);
    updateAllOverlays();
    updateStats();
    markUnsaved();
    updateHistoryButtons();
}

function redoMask() {
    if (S.redoStack.length === 0) return;
    S.undoStack.push(snapshotMask());
    S.finalMaskCtx.putImageData(S.redoStack.pop(), 0, 0);
    updateAllOverlays();
    updateStats();
    markUnsaved();
    updateHistoryButtons();
}

function clearHistory() {
    S.undoStack = []; S.redoStack = [];
    updateHistoryButtons();
}

function updateHistoryButtons() {
    E.btnUndo.disabled = S.undoStack.length === 0;
    E.btnRedo.disabled = S.redoStack.length === 0;
}

// ============================================================
// QUALITY STATS
// ============================================================
function computeStats() {
    if (!S.maskReady) return null;
    const w = S.imgW, h = S.imgH;
    const total = w * h;

    const fin = S.finalMaskCtx.getImageData(0, 0, w, h).data;
    let finalCount = 0;
    for (let i = 0; i < fin.length; i += 4) if (fin[i] > 128) finalCount++;

    let fmCount = 0, added = 0, removed = 0, unchanged = 0;
    if (S.fmLoaded) {
        const fm = S.fmMaskCtx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < fm.length; i += 4) {
            const fmF  = fm[i]  > 128;
            const finF = fin[i] > 128;
            if (fmF)           fmCount++;
            if (finF && !fmF)  added++;
            if (!finF && fmF)  removed++;
            if (finF && fmF)   unchanged++;
        }
    }

    const corrPct = total > 0 ? ((added + removed) / total * 100).toFixed(2) : '0.00';
    const areaPct = total > 0 ? (finalCount / total * 100).toFixed(2) : '0.00';

    return { total, finalCount, fmCount, added, removed, unchanged, corrPct, areaPct };
}

function updateStats() {
    const st = computeStats();
    if (!st) {
        ['statFmPx','statFinalPx','statAddedPx','statRemovedPx','statCorrPct','statAreaPct']
            .forEach(id => { E[id].textContent = '—'; });
        E.statsWarnings.innerHTML = '';
        return;
    }

    E.statFmPx.textContent    = S.fmLoaded ? st.fmCount.toLocaleString() : '—';
    E.statFinalPx.textContent = st.finalCount.toLocaleString();
    E.statAddedPx.textContent = S.fmLoaded ? st.added.toLocaleString() : '—';
    E.statRemovedPx.textContent = S.fmLoaded ? st.removed.toLocaleString() : '—';
    E.statCorrPct.textContent = S.fmLoaded ? `${st.corrPct}%` : '—';
    E.statAreaPct.textContent = `${st.areaPct}%`;

    // Warnings
    const warns = [];
    if (st.finalCount === 0) warns.push('Final mask has 0 flood pixels.');
    if (st.finalCount / st.total > 0.8) warns.push('More than 80% of pixels marked as flood — check the mask.');
    if (S.fmLoaded && st.added === 0 && st.removed === 0) warns.push('Final mask is identical to the FM mask — no corrections made.');
    if (!S.pairId) warns.push('Pair ID is empty — set it before exporting.');

    E.statsWarnings.innerHTML = warns.map(w =>
        `<div class="stats-warn-item">⚠ ${w}</div>`).join('');
}

// ============================================================
// EXPORT
// ============================================================
function checkExportPreconditions(requireFm = false) {
    if (!S.onLoaded) { showToast('Load the ON/FLOOD image first.', 'error'); return false; }
    if (!S.maskReady) { showToast('No mask available to export.', 'error'); return false; }
    if (requireFm && !S.fmLoaded) { showToast('FM mask not loaded — diff not available.', 'error'); return false; }
    if (!S.pairId) showToast('Warning: Pair ID is empty — using "output" as filename prefix.', 'warn');
    return true;
}

function exportFinalMask() {
    if (!checkExportPreconditions()) return;
    const w = S.imgW, h = S.imgH;
    // Force strict binary before export
    const imgData = S.finalMaskCtx.getImageData(0, 0, w, h);
    binaryThresholdData(imgData.data);

    const tmp = makeCanvas(w, h);
    tmp.getContext('2d').putImageData(imgData, 0, 0);
    const prefix = S.pairId || 'output';
    downloadCanvas(tmp, `${prefix}_final_mask.png`);
    S.hasUnsaved = false;
    updateUnsavedIndicator();
    showToast('Final corrected mask downloaded.', 'success');
}

function exportDiffMask() {
    if (!checkExportPreconditions(true)) return;
    const w = S.imgW, h = S.imgH;
    const fm  = S.fmMaskCtx.getImageData(0, 0, w, h).data;
    const fin = S.finalMaskCtx.getImageData(0, 0, w, h).data;

    const tmp = makeCanvas(w, h);
    const tCtx = tmp.getContext('2d');
    const dst = new ImageData(w, h);
    const d = dst.data;

    for (let i = 0; i < fm.length; i += 4) {
        const fmF  = fm[i]  > 128;
        const finF = fin[i] > 128;
        if      (finF && !fmF) { d[i]=50;  d[i+1]=200; d[i+2]=80;  d[i+3]=255; } // green: added
        else if (!finF && fmF) { d[i]=80;  d[i+1]=120; d[i+2]=255; d[i+3]=255; } // blue: removed
        else if (finF && fmF)  { d[i]=220; d[i+1]=200; d[i+2]=50;  d[i+3]=255; } // yellow: unchanged flood
        else                   { d[i]=0;   d[i+1]=0;   d[i+2]=0;   d[i+3]=255; } // black: no flood
    }
    tCtx.putImageData(dst, 0, 0);
    downloadCanvas(tmp, `${S.pairId || 'output'}_correction_diff.png`);
    showToast('Correction diff mask downloaded.', 'success');
}

function exportPreview() {
    if (!checkExportPreconditions()) return;
    const w = S.imgW, h = S.imgH;
    const tmp = makeCanvas(w, h);
    const tCtx = tmp.getContext('2d');

    tCtx.imageSmoothingEnabled = false;
    tCtx.drawImage(S.onImage, 0, 0);

    if (S.beforeImage && S.showBefore && S.beforeOpacity > 0) {
        tCtx.globalAlpha = S.beforeOpacity;
        tCtx.drawImage(S.beforeImage, 0, 0, w, h);
        tCtx.globalAlpha = 1;
    }
    if (S.fmLoaded && S.showFmRef && S.fmOpacity > 0) {
        tCtx.globalAlpha = S.fmOpacity;
        tCtx.drawImage(S.fmOverlayCanvas, 0, 0);
        tCtx.globalAlpha = 1;
    }
    if (S.maskReady && S.maskOpacity > 0) {
        tCtx.globalAlpha = S.maskOpacity;
        tCtx.drawImage(S.finalOverlayCanvas, 0, 0);
        tCtx.globalAlpha = 1;
    }
    downloadCanvas(tmp, `${S.pairId || 'output'}_preview.png`);
    showToast('Preview image downloaded.', 'success');
}

function exportMetadata() {
    if (!checkExportPreconditions()) return;
    const st = computeStats() || {};
    const prefix = S.pairId || 'output';
    const meta = {
        pair_id:                  S.pairId || null,
        before_image:             S.beforeFileName || null,
        on_image:                 S.onFileName || null,
        foundation_mask:          S.fmFileName || null,
        final_mask:               `${prefix}_final_mask.png`,
        correction_diff:          `${prefix}_correction_diff.png`,
        preview:                  `${prefix}_preview.png`,
        mask_convention:          '255=flood_or_change, 0=no_flood_or_no_change',
        annotator:                S.annotator || null,
        quality_status:           S.qualityStatus,
        created_at:               new Date().toISOString(),
        image_width:              S.imgW,
        image_height:             S.imgH,
        fm_changed_pixel_count:   S.fmLoaded ? (st.fmCount ?? null) : null,
        final_changed_pixel_count: st.finalCount ?? null,
        added_pixel_count:        S.fmLoaded ? (st.added ?? null) : null,
        removed_pixel_count:      S.fmLoaded ? (st.removed ?? null) : null,
        unchanged_changed_pixel_count: S.fmLoaded ? (st.unchanged ?? null) : null,
        correction_pct:           S.fmLoaded ? parseFloat(st.corrPct) : null,
        changed_area_pct:         parseFloat(st.areaPct),
        notes:                    S.notes || null,
    };
    const blob = new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${prefix}_metadata.json`; a.click();
    URL.revokeObjectURL(url);
    showToast('Metadata JSON downloaded.', 'success');
}

function downloadCanvas(canvas, filename) {
    const a = document.createElement('a');
    a.download = filename;
    a.href = canvas.toDataURL('image/png');
    a.click();
}

// ============================================================
// AUTOSAVE
// ============================================================
function scheduleAutosave() {
    clearTimeout(S._autosaveTimer);
    S._autosaveTimer = setTimeout(doAutosave, 3000);
}

function doAutosave() {
    if (!S.pairId || !S.maskReady) return;
    try {
        const data = {
            finalMask:     S.finalMaskCanvas.toDataURL('image/png'),
            annotator:     S.annotator,
            qualityStatus: S.qualityStatus,
            notes:         S.notes,
            timestamp:     new Date().toISOString(),
        };
        localStorage.setItem(`fmAnnot_${S.pairId}`, JSON.stringify(data));
    } catch (err) {
        console.warn('Autosave failed:', err);
    }
}

function checkAutosave(pairId) {
    if (!pairId) return;
    try {
        const raw = localStorage.getItem(`fmAnnot_${pairId}`);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (!data.finalMask) return;
        S._pendingAutosaveData = data;
        const ts = data.timestamp ? new Date(data.timestamp).toLocaleString() : 'unknown time';
        E.autosaveMsg.textContent = `Autosaved correction found for "${pairId}" (saved: ${ts}). Restore it?`;
        E.autosaveModal.classList.remove('hidden');
    } catch (_) { /* ignore */ }
}

function restoreAutosave(data) {
    if (!data || !data.finalMask || !S.maskReady) return;
    const img = new Image();
    img.onload = () => {
        clearHistory();
        S.finalMaskCtx.imageSmoothingEnabled = false;
        S.finalMaskCtx.drawImage(img, 0, 0, S.imgW, S.imgH);
        thresholdCtxInPlace(S.finalMaskCtx, S.imgW, S.imgH);
        updateAllOverlays();
        updateStats();
        markUnsaved();
    };
    img.src = data.finalMask;
    if (data.annotator)     { S.annotator = data.annotator; E.annotatorInput.value = data.annotator; }
    if (data.qualityStatus) { S.qualityStatus = data.qualityStatus; E.qualitySelect.value = data.qualityStatus; }
    if (data.notes)         { S.notes = data.notes; E.notesInput.value = data.notes; }
    showToast('Autosave restored.', 'success');
}

// ============================================================
// DRAG-AND-DROP
// ============================================================
function detectRole(filename) {
    const lower = filename.toLowerCase().replace(/\.[^.]+$/, '');
    const check = (kws) => kws.some(kw => {
        const re = new RegExp(`(^|[_\\-\\s.])${kw}([_\\-\\s.]|$)`);
        return re.test(lower);
    });

    if (check(['mask','fm','foundation','approx','pred','prediction','rough'])) return 'mask';
    if (check(['before','pre','t1','reference']))                                return 'before';
    if (check(['on','during','flood','after','post','t2']))                      return 'on';
    return null;
}

function autoDetectPairId(filenames) {
    // Try numeric ID pattern first (e.g. "0001")
    for (const fn of filenames) {
        const m = fn.replace(/\.[^.]+$/, '').match(/\d{3,}/);
        if (m) return m[0];
    }
    return '';
}

function tryAutoFillPairId() {
    if (S.pairId) return; // already set manually
    const fns = [S.onFileName, S.beforeFileName, S.fmFileName].filter(Boolean);
    const id = autoDetectPairId(fns);
    if (id) {
        S.pairId = id;
        E.pairIdInput.value = id;
        updateStatusBar();
    }
}

function setupDragDrop() {
    const main = E.mainView;
    const hint = E.dropHint;

    const prevent = e => { e.preventDefault(); e.stopPropagation(); };

    main.addEventListener('dragenter', e => { prevent(e); hint.classList.add('drag-active'); });
    main.addEventListener('dragover',  e => { prevent(e); });
    main.addEventListener('dragleave', e => { prevent(e); hint.classList.remove('drag-active'); });

    main.addEventListener('drop', e => {
        prevent(e);
        hint.classList.remove('drag-active');
        const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
        if (files.length === 0) return;

        const assigned = { on: null, before: null, mask: null };
        const unassigned = [];

        files.forEach(f => {
            const role = detectRole(f.name);
            if (role && !assigned[role]) assigned[role] = f;
            else unassigned.push(f);
        });

        // Fill unassigned slots with leftover files
        unassigned.forEach(f => {
            if (!assigned.on)     assigned.on = f;
            else if (!assigned.before) assigned.before = f;
            else if (!assigned.mask)   assigned.mask = f;
        });

        if (assigned.on)     handleOnFile(assigned.on);
        if (assigned.before) handleBeforeFile(assigned.before);
        if (assigned.mask)   handleFmMaskFile(assigned.mask);

        if (files.length >= 2) {
            const id = autoDetectPairId(files.map(f => f.name));
            if (id && !S.pairId) { S.pairId = id; E.pairIdInput.value = id; updateStatusBar(); }
        }
    });
}

// ============================================================
// COLLAPSIBLE SECTIONS
// ============================================================
function setupCollapsibles() {
    document.querySelectorAll('.group-header').forEach(header => {
        const targetId = header.dataset.target;
        const content  = document.getElementById(targetId);
        if (!content) return;

        header.addEventListener('click', () => {
            const isCollapsed = header.classList.contains('collapsed');
            if (isCollapsed) {
                header.classList.remove('collapsed');
                content.classList.remove('hidden');
            } else {
                header.classList.add('collapsed');
                content.classList.add('hidden');
            }
        });
    });
}

// ============================================================
// TOOL SWITCHING
// ============================================================
function setTool(tool) {
    S.activeTool = tool;
    [E.btnAddFlood, E.btnRemoveFlood, E.btnPan].forEach(b => b.classList.remove('active'));
    if (tool === 'add')    { E.btnAddFlood.classList.add('active');    S.displayCanvas.style.cursor = 'crosshair'; }
    if (tool === 'remove') { E.btnRemoveFlood.classList.add('active'); S.displayCanvas.style.cursor = 'crosshair'; }
    if (tool === 'pan')    { E.btnPan.classList.add('active');         S.displayCanvas.style.cursor = 'grab'; }
    E.statusTool.textContent = `Tool: ${tool === 'add' ? 'Add Flood' : tool === 'remove' ? 'Remove Flood' : 'Pan'}`;
}

// ============================================================
// STATUS BAR UPDATES
// ============================================================
function updateStatusBar() {
    // Sample ID
    E.statusSample.textContent = `Sample: ${S.pairId || '—'}`;

    // Loaded chips
    setChip(E.statusOn,     S.onLoaded,     'ON', S.onFileName);
    setChip(E.statusBefore, S.beforeLoaded, 'BEFORE', S.beforeFileName);
    setChip(E.statusFm,     S.fmLoaded,     'FM Mask', S.fmFileName);

    updateZoomStatus();
    updateUnsavedIndicator();
}

function setChip(el, loaded, label, filename) {
    el.textContent = loaded ? `${label}: ✓` : `${label}: not loaded`;
    el.className = `status-chip ${loaded ? 'chip-loaded' : 'chip-missing'}`;
    if (loaded && filename) el.title = filename;
}

function updateZoomStatus() {
    E.statusZoom.textContent = `Zoom: ${Math.round(S.scale * 100)}%`;
}

function updateCursorStatus(x, y) {
    // no separate element; could extend status if desired
}

function updateUnsavedIndicator() {
    const show = S.hasUnsaved;
    E.statusUnsaved.classList.toggle('hidden', !show);
    E.unsavedSep.classList.toggle('hidden', !show);
}

function markUnsaved() {
    S.hasUnsaved = true;
    updateUnsavedIndicator();
}

function updateBrushUI() {
    E.brushSizeVal.textContent = S.brushSize;
    E.brushSize.value          = S.brushSize;
    E.statusBrush.textContent  = `Brush: ${S.brushSize}px`;
}

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
function setupHotkeys() {
    window.addEventListener('keydown', e => {
        const tag = e.target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        if (e.key === ' ') {
            e.preventDefault();
            if (!S.spaceHeld) {
                S.spaceHeld = true;
                S.toolBeforeSpace = S.activeTool;
                setTool('pan');
            }
            return;
        }

        // Undo / Redo via Ctrl+Z / Ctrl+Y
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoMask(); return; }
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redoMask(); return; }
        if (e.ctrlKey || e.metaKey) return;

        switch (e.key) {
            case 'a': case 'A': setTool('add');    break;
            case 'r': case 'R': setTool('remove'); break;
            case 'p': case 'P': setTool('pan');    break;
            case 'z': case 'Z': undoMask(); break;
            case 'y': case 'Y': redoMask(); break;
            case '[': S.brushSize = Math.max(1, S.brushSize - 2);   updateBrushUI(); break;
            case ']': S.brushSize = Math.min(150, S.brushSize + 2); updateBrushUI(); break;
            case '=': case '+': zoomBy(1.25); break;
            case '-': case '_': zoomBy(0.8);  break;
            case '0': fitToScreen(); break;
            case 'f': case 'F':
                E.toggleFinalMask.checked = !E.toggleFinalMask.checked;
                S.showFinalMask = E.toggleFinalMask.checked;
                break;
            case 'm': case 'M':
                E.toggleFmRef.checked = !E.toggleFmRef.checked;
                S.showFmRef = E.toggleFmRef.checked;
                break;
            case 'd': case 'D':
                E.toggleDiff.checked = !E.toggleDiff.checked;
                S.showDiff = E.toggleDiff.checked;
                break;
            case 'h': case 'H': case '?':
                E.helpModal.classList.remove('hidden');
                break;
        }
    });

    window.addEventListener('keyup', e => {
        if (e.key === ' ') {
            S.spaceHeld = false;
            if (S.toolBeforeSpace) { setTool(S.toolBeforeSpace); S.toolBeforeSpace = null; }
        }
    });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    E.toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 3200);
}

// ============================================================
// EVENT LISTENERS SETUP
// ============================================================
function setupEventListeners() {
    // File inputs
    E.onImageInput.addEventListener('change',       e => handleOnFile(e.target.files[0]));
    E.beforeImageInput.addEventListener('change',   e => handleBeforeFile(e.target.files[0]));
    E.fmMaskInput.addEventListener('change',        e => handleFmMaskFile(e.target.files[0]));
    E.existingMaskInput.addEventListener('change',  e => handleExistingMaskFile(e.target.files[0]));

    // Dimension mismatch buttons
    E.btnResizeMask.addEventListener('click', () => {
        E.dimMismatchBox.classList.add('hidden');
        if (S._pendingWhich === 'fm' && S._pendingFm) {
            applyFmMask(S._pendingFm, S.imgW, S.imgH);
            S._pendingFm = null;
        } else if (S._pendingWhich === 'existing' && S._pendingExisting) {
            applyExistingMask(S._pendingExisting, S.imgW, S.imgH);
            S._pendingExisting = null;
        }
        S._pendingWhich = null;
    });
    E.btnCancelMaskLoad.addEventListener('click', () => {
        E.dimMismatchBox.classList.add('hidden');
        S._pendingFm = null; S._pendingExisting = null; S._pendingWhich = null;
        showToast('Mask load cancelled.', 'info');
    });

    // Sliders
    E.beforeOpacity.addEventListener('input', e => {
        S.beforeOpacity = parseFloat(e.target.value);
        E.beforeOpacityVal.textContent = S.beforeOpacity.toFixed(2);
    });
    E.maskOpacity.addEventListener('input', e => {
        S.maskOpacity = parseFloat(e.target.value);
        E.maskOpacityVal.textContent = S.maskOpacity.toFixed(2);
    });
    E.fmOpacity.addEventListener('input', e => {
        S.fmOpacity = parseFloat(e.target.value);
        E.fmOpacityVal.textContent = S.fmOpacity.toFixed(2);
    });
    E.brushSize.addEventListener('input', e => {
        S.brushSize = parseInt(e.target.value);
        updateBrushUI();
    });
    E.renderScale.addEventListener('change', e => {
        S.renderScale = parseFloat(e.target.value);
        E.renderScaleVal.textContent = `${S.renderScale}x`;
        resizeDisplayCanvas();
    });

    // Toggles
    E.toggleBefore.addEventListener('change',    e => { S.showBefore    = e.target.checked; });
    E.toggleFinalMask.addEventListener('change', e => { S.showFinalMask = e.target.checked; });
    E.toggleFmRef.addEventListener('change',     e => { S.showFmRef     = e.target.checked; });
    E.toggleDiff.addEventListener('change',      e => { S.showDiff      = e.target.checked; });

    // Tools
    E.btnAddFlood.addEventListener('click',    () => setTool('add'));
    E.btnRemoveFlood.addEventListener('click', () => setTool('remove'));
    E.btnPan.addEventListener('click',         () => setTool('pan'));

    // Actions
    E.btnResetView.addEventListener('click',   fitToScreen);
    E.btnUndo.addEventListener('click',        undoMask);
    E.btnRedo.addEventListener('click',        redoMask);
    E.btnResetToFm.addEventListener('click',   resetToFmMask);
    E.btnClearMask.addEventListener('click',   clearFinalMask);
    E.btnRefreshStats.addEventListener('click', updateStats);

    // Export
    E.btnDownloadFinal.addEventListener('click',   exportFinalMask);
    E.btnDownloadDiff.addEventListener('click',    exportDiffMask);
    E.btnDownloadPreview.addEventListener('click', exportPreview);
    E.btnDownloadMeta.addEventListener('click',    exportMetadata);

    // Sample info fields
    E.pairIdInput.addEventListener('input', e => {
        S.pairId = e.target.value.trim();
        updateStatusBar();
    });
    E.annotatorInput.addEventListener('input', e => { S.annotator = e.target.value.trim(); });
    E.qualitySelect.addEventListener('change', e => { S.qualityStatus = e.target.value; });
    E.notesInput.addEventListener('input', e => { S.notes = e.target.value; });

    // Help modal
    E.btnHelp.addEventListener('click',      () => E.helpModal.classList.remove('hidden'));
    E.btnCloseHelp.addEventListener('click', () => E.helpModal.classList.add('hidden'));
    E.helpModal.addEventListener('click', e => {
        if (e.target === E.helpModal) E.helpModal.classList.add('hidden');
    });

    // Autosave modal
    E.btnRestoreAutosave.addEventListener('click', () => {
        if (S._pendingAutosaveData) restoreAutosave(S._pendingAutosaveData);
        S._pendingAutosaveData = null;
        E.autosaveModal.classList.add('hidden');
    });
    E.btnIgnoreAutosave.addEventListener('click', () => {
        S._pendingAutosaveData = null;
        E.autosaveModal.classList.add('hidden');
    });
    E.btnDeleteAutosave.addEventListener('click', () => {
        if (S.pairId) localStorage.removeItem(`fmAnnot_${S.pairId}`);
        S._pendingAutosaveData = null;
        E.autosaveModal.classList.add('hidden');
        showToast('Autosave deleted.', 'info');
    });

    // Close modals on Escape
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            E.helpModal.classList.add('hidden');
            E.autosaveModal.classList.add('hidden');
        }
    });

    // Window resize
    window.addEventListener('resize', () => {
        resizeDisplayCanvas();
    });
}

// ============================================================
// INIT
// ============================================================
function init() {
    cacheEls();

    // Grab display canvas and context
    S.displayCanvas = E.displayCanvas;
    S.ctx = S.displayCanvas.getContext('2d', { alpha: false });

    // Initial canvas size
    resizeDisplayCanvas();

    // Wire up interactions
    setupPointerEvents();
    setupEventListeners();
    setupCollapsibles();
    setupDragDrop();
    setupHotkeys();

    // Set initial tool state
    setTool('add');
    updateBrushUI();
    updateStatusBar();

    // Open Sample Loading section expanded by default
    // (already set up in HTML — section 1 is open, section 4 tools is open)

    // Start render loop
    startRenderLoop();

    showToast('Load ON/FLOOD image to begin.', 'info');
}

document.addEventListener('DOMContentLoaded', init);
