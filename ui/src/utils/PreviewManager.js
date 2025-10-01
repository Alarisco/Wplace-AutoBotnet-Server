/**
 * Gestor de Preview para el WPlace Master Dashboard
 * 
 * Este módulo maneja toda la lógica relacionada con el preview del proyecto:
 * - Gestión del canvas y renderizado de píxeles
 * - Control de zoom y ajuste automático
 * - Manejo de datos de preview de Guard e Image
 * - Controles de visualización (toggles, estadísticas)
 * - Interacciones del canvas (pan, zoom con rueda)
 */

export class PreviewManager {
  constructor(dashboard) {
    this.dashboard = dashboard;
    this.previewZoom = 1;
    this.lastPreviewData = null;
    this.guardPreview = {
      analysis: null,
      togglesInitialized: false,
      show: { correct: true, incorrect: true, missing: true },
      area: null
    };
    this.previewChanges = [];
    this.previewMeta = {};
    this.lastPreviewAt = 0;
    this._previewRefreshCooldownUntil = 0;
    this._lastPriorityPreviewAt = 0; // Timestamp del último preview_data prioritario
  }

  /**
   * Renderiza el preview básico (método mínimo)
   */
  renderPreview() {
    try {
      const canvas = document.getElementById('preview-canvas');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      
      if (!this.lastPreviewData) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const stats = document.getElementById('guard-preview-stats');
        if (stats) stats.textContent = 'Sin datos';
        return;
      }
    } catch (error) {
      console.error('Error in renderPreview:', error);
    }
  }

  /**
   * Obtiene el zoom máximo permitido basado en el contenedor
   */
  getMaxAllowedZoom() {
    const canvas = document.getElementById('preview-canvas');
    const container = document.getElementById('canvas-container');
    if (!canvas || !container || !canvas.width || !canvas.height) return 1;
    
    const cs = getComputedStyle(container);
    const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0');
    const innerW = Math.max(0, container.clientWidth - padX);
    const innerH = Math.max(0, container.clientHeight - padY);
    
    const stats = document.getElementById('guard-preview-stats');
    const statsH = stats ? stats.offsetHeight + 8 : 0;
    const SAFE = 0.99;
    
    const scaleX = innerW / canvas.width;
    const scaleY = Math.max(0.1, (innerH - statsH) / canvas.height);
    const cap = Math.max(0.1, Math.min(scaleX, scaleY)) * SAFE;
    
    return isFinite(cap) && cap > 0 ? cap : 1;
  }

  /**
   * Establece el nivel de zoom del canvas
   */
  setZoom(zoom) {
    const canvas = document.getElementById('preview-canvas');
    if (!canvas || !canvas.width || !canvas.height) return;
    
    const maxAllowed = this.getMaxAllowedZoom();
    const minAllowed = 0.5;
    const clamped = Math.max(minAllowed, Math.min(zoom, maxAllowed));
    this.previewZoom = clamped;
    
    // Escalado real para que el layout conozca el tamaño
    canvas.style.width = `${Math.max(1, Math.round(canvas.width * clamped))}px`;
    canvas.style.height = `${Math.max(1, Math.round(canvas.height * clamped))}px`;
    
    // Sincronizar UI
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomLevel = document.getElementById('zoom-level');
    if (zoomSlider) zoomSlider.value = String(clamped);
    if (zoomLevel) zoomLevel.textContent = `${Math.round(clamped * 100)}%`;
  }

  /**
   * Ajusta el zoom automáticamente para que el canvas encaje en el contenedor
   */
  fitZoom() {
    const canvas = document.getElementById('preview-canvas');
    const container = document.getElementById('canvas-container');
    if (!canvas || !container) return;

    const cs = getComputedStyle(container);
    const padX = parseFloat(cs.paddingLeft || '0') + parseFloat(cs.paddingRight || '0');
    const padY = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0');
    const innerW = Math.max(0, container.clientWidth - padX);
    const innerH = Math.max(0, container.clientHeight - padY);

    const stats = document.getElementById('guard-preview-stats');
    const statsH = stats ? stats.offsetHeight + 8 : 0;

    const scaleX = innerW / canvas.width;
    const scaleY = Math.max(0.1, (innerH - statsH) / canvas.height);
    const SAFE = 0.99;
    const scale = Math.max(0.1, Math.min(scaleX, scaleY, 5)) * SAFE;

    this.setZoom(scale);
  }

  /**
   * Ajusta el tamaño del panel de preview
   */
  adjustPreviewSize() {
    const canvas = document.getElementById('preview-canvas');
    const previewContent = document.getElementById('preview-content');
    const panel = document.getElementById('preview-panel');
    const container = document.getElementById('canvas-container');
    
    if (!previewContent || !panel || panel.style.display === 'none') return;

    const MIN_H = 520;
    const MAX_VH = 0.92;
    const B_MARGIN = 2;

    const rect = previewContent.getBoundingClientRect();
    const viewportCap = Math.floor(window.innerHeight * MAX_VH);
    const availByViewport = Math.max(0, Math.floor(window.innerHeight - rect.top - B_MARGIN));

    // Respetar altura preferida del usuario
    let savedH = 0;
    try { 
      savedH = parseInt(localStorage.getItem('previewPanel.height') || '0', 10) || 0; 
    } catch {}
    
    if (savedH > 0) {
      const clamped = Math.max(MIN_H, Math.min(savedH, viewportCap, availByViewport));
      previewContent.style.height = `${clamped}px`;
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        setTimeout(() => this.fitZoom(), 0);
      }
      this.dashboard.log(`📏 Preview height (user) ${clamped}px`);
      return;
    }

    // Calcular altura necesaria
    const stats = document.getElementById('guard-preview-stats');
    const statsH = stats ? stats.offsetHeight : 0;
    const padY = container ? (() => {
      const cs = getComputedStyle(container);
      return (parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0'));
    })() : 0;
    const canvasH = canvas ? canvas.offsetHeight : 0;
    const needed = Math.ceil(canvasH + statsH + padY);

    const finalH = Math.max(MIN_H, Math.min(needed, viewportCap, availByViewport));
    previewContent.style.height = `${finalH}px`;

    if (canvas && canvas.width > 0 && canvas.height > 0) {
      setTimeout(() => this.fitZoom(), 0);
    }

    this.dashboard.log(`📏 Preview height set to ${finalH}px`);
  }

  /**
   * Muestra el preview desde un proyecto Image
   */
  showPreviewFromProject(json) {
    try {
      const panel = document.getElementById('preview-panel');
      if (panel) panel.style.display = 'block';
      
      const canvas = document.getElementById('preview-canvas');
      if (canvas && json?.imageData?.width && json?.imageData?.height && Array.isArray(json?.imageData?.fullPixelData)) {
        const w = json.imageData.width;
        const h = json.imageData.height;
        canvas.width = w;
        canvas.height = h;
        
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const imgData = ctx.createImageData(w, h);
          json.imageData.fullPixelData.slice(0, w * h).forEach(p => {
            if (p && p.x >= 0 && p.y >= 0 && p.x < w && p.y < h) {
              const idx = (p.y * w + p.x) * 4;
              imgData.data[idx] = p.r || 0;
              imgData.data[idx + 1] = p.g || 0;
              imgData.data[idx + 2] = p.b || 0;
              imgData.data[idx + 3] = 255;
            }
          });
          ctx.putImageData(imgData, 0, 0);
        }
      }
      
      setTimeout(() => {
        this.restorePreviewPreferredHeight();
        this.adjustPreviewSize();
        this.fitZoom();
      }, 100);
      
      try { 
        this.dashboard.updateControlButtons(); 
      } catch {}
    } catch (e) {
      this.dashboard.log('⚠️ Preview render error: ' + e.message);
    }
  }

  /**
   * Muestra el preview Guard desde un proyecto
   */
  showGuardPreviewFromProject(json) {
    try {
      const panel = document.getElementById('preview-panel');
      if (panel) panel.style.display = 'block';
      
      const area = json.protectionData?.area || json.protectionArea;
      const total = json.protectionData?.protectedPixels || (Array.isArray(json.originalPixels) ? json.originalPixels.length : 0);
      
      if (area && Array.isArray(json.originalPixels)) {
        const originalMap = new Map();
        json.originalPixels.forEach(p => {
          if (p && p.x !== undefined && p.y !== undefined) {
            originalMap.set(`${p.x},${p.y}`, { r: p.r, g: p.g, b: p.b });
          }
        });
        
        const analysis = {
          correct: new Map(),
          incorrect: new Map(),
          missing: originalMap,
          originalPixels: originalMap,
          currentPixels: new Map()
        };
        
        this.guardPreview.analysis = analysis;
        this.guardPreview.area = area;
        this.renderGuardPreviewCanvas({ analysis, area });
        this.initGuardPreviewToggles();
        
        setTimeout(() => {
          this.restorePreviewPreferredHeight();
          this.adjustPreviewSize();
          this.fitZoom();
        }, 100);
        
        try { 
          this.dashboard.updateControlButtons(); 
        } catch {}
      }
    } catch (e) {
      this.dashboard.log('⚠️ Guard preview error: ' + e.message);
    }
  }

  /**
   * Inicializa los toggles de visualización del Guard preview
   */
  initGuardPreviewToggles() {
    if (this.guardPreview.togglesInitialized) return;
    
    const container = document.getElementById('guard-preview-controls');
    if (!container) {
      this.dashboard.log('⚠️ Container guard-preview-controls not found');
      return;
    }
    
    container.innerHTML = '';
    
    const controlsHTML = `
      <div class="space-y-2">
        ${this.dashboard.createCompactToggle('gp-show-correct', '✅ Correctos', this.guardPreview.show.correct)}
        ${this.dashboard.createCompactToggle('gp-show-incorrect', '❌ Incorrectos', this.guardPreview.show.incorrect)}
        ${this.dashboard.createCompactToggle('gp-show-missing', '⚪ Faltantes', this.guardPreview.show.missing)}
      </div>
    `;
    
    container.innerHTML = controlsHTML;
    this.setupGuardPreviewControls();
    this.guardPreview.togglesInitialized = true;
  }

  /**
   * Configura los controles del Guard preview
   */
  setupGuardPreviewControls() {
    const toggleIds = ['gp-show-correct', 'gp-show-incorrect', 'gp-show-missing'];
    toggleIds.forEach(id => {
      const toggle = document.getElementById(id);
      if (!toggle) return;
      
      this.dashboard.updateToggleState(id, toggle.checked);
      
      toggle.addEventListener('change', () => {
        this.dashboard.updateToggleState(id, toggle.checked);
        
        // Actualizar estado interno
        this.guardPreview.show.correct = document.getElementById('gp-show-correct')?.checked || false;
        this.guardPreview.show.incorrect = document.getElementById('gp-show-incorrect')?.checked || false;
        this.guardPreview.show.missing = document.getElementById('gp-show-missing')?.checked || false;
        
        // Re-renderizar
        if (this.guardPreview.analysis && this.guardPreview.area) {
          this.renderGuardPreviewCanvas({
            analysis: this.guardPreview.analysis,
            area: this.guardPreview.area
          });
        }
      });
    });
    
    // Configurar interacciones del canvas
    const canvas = document.getElementById('preview-canvas');
    if (canvas) {
      this.setupCanvasInteractions(canvas);
    }
  }

  /**
   * Configura las interacciones del canvas (pan y zoom)
   */
  setupCanvasInteractions(canvas) {
    if (!canvas) return;
    
    const canvasContainer = canvas.parentElement;
    if (!canvasContainer) return;
    
    canvasContainer.style.overflow = 'auto';
    canvasContainer.style.position = 'relative';
    
    // Variables para pan
    let isPanning = false;
    let startX = 0;
    let startY = 0;
    let scrollLeftStart = 0;
    let scrollTopStart = 0;
    
    // Pan con mouse
    canvasContainer.addEventListener('mousedown', (e) => {
      isPanning = true;
      startX = e.clientX;
      startY = e.clientY;
      scrollLeftStart = canvasContainer.scrollLeft;
      scrollTopStart = canvasContainer.scrollTop;
      canvasContainer.style.cursor = 'grabbing';
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      
      canvasContainer.scrollLeft = scrollLeftStart - dx;
      canvasContainer.scrollTop = scrollTopStart - dy;
    });
    
    document.addEventListener('mouseup', () => {
      isPanning = false;
      canvasContainer.style.cursor = 'grab';
    });
    
    // Zoom con rueda del mouse
    canvasContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const slider = document.getElementById('zoom-slider');
      const label = document.getElementById('zoom-level');
      if (!slider || !label) return;
      
      const factor = 1.1;
      const oldZoom = parseFloat(slider.value || '1') || 1;
      const proposed = oldZoom * (e.deltaY < 0 ? factor : 1 / factor);
      this.setZoom(proposed);
    }, { passive: false });
  }

  /**
   * Actualiza el preview desde datos de un slave
   * @param {string} slaveId - ID del slave
   * @param {Object} data - Datos del preview
   * @param {Object} options - Opciones de actualización
   * @param {boolean} options.priority - Si true, siempre actualiza. Si false, solo si no hay datos más recientes.
   */
  updatePreviewFromSlave(slaveId, data, options = {}) {
    try {
      if (!data) return;
      
      const now = Date.now();
      const isPriority = options.priority !== false; // Por defecto es priority
      
      // Si no es priority (viene de telemetry_update), verificar si ya tenemos datos recientes
      if (!isPriority) {
        // Si recibimos preview_data hace menos de 2 segundos, ignorar telemetry_update
        if (this._lastPriorityPreviewAt && (now - this._lastPriorityPreviewAt) < 2000) {
          this.dashboard.uiHelpers.logOnce('preview:skip-stale', '⏭️ Skipping stale telemetry preview (have fresh preview_data)', 2000);
          return;
        }
      } else {
        // Actualizar timestamp de preview prioritario
        this._lastPriorityPreviewAt = now;
      }
      
      this.lastPreviewData = data;
      this.dashboard.log(`🔄 Processing ${isPriority ? 'priority' : 'telemetry'} preview data from ${slaveId}`);
      
      const area = data.protectedArea || data.area;
      if (!area) {
        this.dashboard.log('⚠️ No area data found in preview');
        return;
      }
      
      // Convertir listas a Maps
      const toMap = (arr) => {
        const m = new Map();
        if (Array.isArray(arr)) {
          arr.forEach(p => {
            if (p && p.x !== undefined && p.y !== undefined) {
              m.set(`${p.x},${p.y}`, {
                r: p.r || 0,
                g: p.g || 0,
                b: p.b || 0,
                originalR: p.originalR,
                originalG: p.originalG,
                originalB: p.originalB
              });
            }
          });
        }
        return m;
      };
      
      const correct = toMap(data.correctPixelsList || []);
      const incorrect = toMap(data.incorrectPixelsList || []);
      const missing = toMap(data.missingPixelsList || []);
      const originalPixels = toMap(data.originalPixels || []);
      
      const analysis = { correct, incorrect, missing, originalPixels };
      
      // Construir lista de cambios
      const changes = [];
      if (Array.isArray(data.incorrectPixelsList)) {
        data.incorrectPixelsList.forEach(p => {
          if (p && typeof p.x !== 'undefined' && typeof p.y !== 'undefined') {
            changes.push({
              type: 'incorrect',
              x: p.x,
              y: p.y,
              expectedColor: p.originalR !== undefined ?
                ((p.originalR & 0xFF) << 16) | ((p.originalG & 0xFF) << 8) | (p.originalB & 0xFF) :
                (p.color || 0),
              color: p.r !== undefined ?
                ((p.r & 0xFF) << 16) | ((p.g & 0xFF) << 8) | (p.b & 0xFF) :
                (p.currentColor || 0)
            });
          }
        });
      }
      
      if (Array.isArray(data.missingPixelsList)) {
        data.missingPixelsList.forEach(p => {
          if (p && typeof p.x !== 'undefined' && typeof p.y !== 'undefined') {
            changes.push({
              type: 'missing',
              x: p.x,
              y: p.y,
              expectedColor: p.r !== undefined ?
                ((p.r & 0xFF) << 16) | ((p.g & 0xFF) << 8) | (p.b & 0xFF) :
                (p.color || 0)
            });
          }
        });
      }
      
      this.lastPreviewData = { ...data, changes };
      this.guardPreview.analysis = analysis;
      this.guardPreview.area = area;
      this.renderGuardPreviewCanvas({ analysis, area });
      
      // Actualizar paleta de colores si hay datos disponibles
      if (data.availableColors && this.dashboard.configManager) {
        try {
          this.dashboard.configManager.renderAllInlineChips();
        } catch (err) {
          this.dashboard.log('⚠️ Error updating color palette: ' + err.message);
        }
      }
      
    } catch (err) {
      this.dashboard.log('⚠️ updatePreviewFromSlave error: ' + err.message);
      console.error('Preview processing error:', err, data);
    }
  }

  /**
   * Renderiza el canvas del Guard preview
   */
  renderGuardPreviewCanvas(payload) {
    try {
      if (!payload || !payload.analysis || !payload.area) return;
      
      // Inferir modo Guard si no está detectado
      if (!this.dashboard.detectedBotMode) {
        this.dashboard.detectedBotMode = 'Guard';
        const detectedEl = document.getElementById('detected-mode');
        if (detectedEl) detectedEl.textContent = `Detected mode: ${this.dashboard.detectedBotMode}`;
        try { 
          this.dashboard.updateControlButtons(); 
        } catch {}
      }
      
      this.initGuardPreviewToggles();
      
      const panel = document.getElementById('preview-panel');
      if (panel) panel.style.display = 'block';
      
      const area = payload.area;
      const correctCount = payload.analysis.correct?.size || 0;
      const incorrectCount = payload.analysis.incorrect?.size || 0;
      const missingCount = payload.analysis.missing?.size || 0;
      const originalCount = payload.analysis.originalPixels?.size || 0;
      const total = Math.max(originalCount, correctCount + incorrectCount + missingCount);
      
      this.updateGuardStatistics(payload.analysis);
      
      const canvas = document.getElementById('preview-canvas');
      if (!canvas) return;
      
      const width = area.x2 - area.x1 + 1;
      const height = area.y2 - area.y1 + 1;
      
      this.dashboard.log(`🎨 Rendering ${total} pixels in ${width}x${height} canvas`);
      
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      const imageData = ctx.createImageData(width, height);
      
      // Fondo gris claro
      for (let i = 0; i < imageData.data.length; i += 4) {
        imageData.data[i] = 240;     // R
        imageData.data[i + 1] = 240; // G
        imageData.data[i + 2] = 240; // B
        imageData.data[i + 3] = 60;  // Alpha bajo
      }
      
      // Obtener estado de toggles
      const showCorrectEl = document.getElementById('gp-show-correct');
      const showIncorrectEl = document.getElementById('gp-show-incorrect');
      const showMissingEl = document.getElementById('gp-show-missing');
      
      const showCorrect = showCorrectEl ? showCorrectEl.checked : this.guardPreview.show.correct;
      const showIncorrect = showIncorrectEl ? showIncorrectEl.checked : this.guardPreview.show.incorrect;
      const showMissing = showMissingEl ? showMissingEl.checked : this.guardPreview.show.missing;
      
      // Función para dibujar píxel
      const drawPixel = (x, y, r, g, b, a = 255) => {
        const index = ((y - area.y1) * width + (x - area.x1)) * 4;
        if (index >= 0 && index < imageData.data.length - 3) {
          imageData.data[index] = r;
          imageData.data[index + 1] = g;
          imageData.data[index + 2] = b;
          imageData.data[index + 3] = a;
        }
      };
      
      // Dibujar píxeles originales como fondo
      if (payload.analysis.originalPixels) {
        for (const [key, pixel] of payload.analysis.originalPixels) {
          const [x, y] = key.split(',').map(Number);
          drawPixel(x, y, pixel?.r ?? 128, pixel?.g ?? 128, pixel?.b ?? 128, 255);
        }
      }

      // Dibujar píxeles según toggles
      if (showCorrect && payload.analysis.correct) {
        for (const [key] of payload.analysis.correct) {
          const [x, y] = key.split(',').map(Number);
          drawPixel(x, y, 0, 200, 0, 220);
        }
      }

      if (showIncorrect && payload.analysis.incorrect) {
        for (const [key] of payload.analysis.incorrect) {
          const [x, y] = key.split(',').map(Number);
          drawPixel(x, y, 220, 30, 30, 230);
        }
      }

      if (showMissing && payload.analysis.missing) {
        for (const [key] of payload.analysis.missing) {
          const [x, y] = key.split(',').map(Number);
          drawPixel(x, y, 240, 210, 0, 220);
        }
      }

      ctx.putImageData(imageData, 0, 0);
      
      try { 
        this.updateGuardStatistics(payload.analysis); 
      } catch {}
      
      setTimeout(() => {
        this.restorePreviewPreferredHeight();
        this.adjustPreviewSize();
        this.fitZoom();
      }, 50);
      
    } catch (err) {
      this.dashboard.log('⚠️ renderGuardPreviewCanvas error: ' + err.message);
      console.error('Canvas render error:', err, payload);
    }
  }

  /**
   * Actualiza las estadísticas del Guard
   */
  updateGuardStatistics(analysis) {
    try {
      const correctCount = analysis?.correct?.size || 0;
      const incorrectCount = analysis?.incorrect?.size || 0;
      const missingCount = analysis?.missing?.size || 0;
      
      const rp = document.getElementById('repaired-pixels');
      const inc = document.getElementById('incorrect-pixels');
      const miss = document.getElementById('missing-pixels');
      
      if (rp) rp.textContent = String(correctCount);
      if (inc) inc.textContent = String(incorrectCount);
      if (miss) miss.textContent = String(missingCount);
      
      const total = (analysis?.originalPixels?.size || (correctCount + incorrectCount + missingCount));
      const acc = total ? (correctCount / total * 100) : 0;
      this.dashboard.updateOverallProgressBar(acc);
    } catch (error) {
      console.error('Error updating guard statistics:', error);
    }
  }

  /**
   * Oculta el panel de preview
   */
  hidePreviewPanel() {
    const panel = document.getElementById('preview-panel');
    if (panel) panel.style.display = 'none';
  }

  /**
   * Persiste la altura preferida del preview
   */
  persistPreviewPreferredHeight(h) {
    try {
      localStorage.setItem('previewPanel.height', String(h));
    } catch {}
  }

  /**
   * Restaura la altura preferida del preview
   */
  restorePreviewPreferredHeight() {
    try {
      const v = parseInt(localStorage.getItem('previewPanel.height') || '0', 10);
      if (v > 0) {
        const content = document.getElementById('preview-content');
        if (content) content.style.height = `${v}px`;
      }
    } catch {}
  }

  /**
   * Solicita un refresh del preview con throttling
   */
  requestPreviewRefreshThrottle() {
    const now = Date.now();
    if (now < this._previewRefreshCooldownUntil) return;
    
    this._previewRefreshCooldownUntil = now + 2000; // 2 segundos de cooldown
    
    try {
      fetch(`${this.dashboard.apiBase()}/api/guard/check`, { method: 'POST' })
        .then(response => {
          if (response.ok) {
            return response.json();
          } else if (response.status === 400) {
            // 400 es normal cuando no hay slaves conectados
            return response.json().then(data => {
              if (data.detail && data.detail.includes('No favorite slave connected')) {
                this.dashboard.log('ℹ️ No slaves connected for preview refresh (normal)');
                return { ok: false, reason: 'no_slaves' };
              }
              throw new Error(data.detail || 'Bad request');
            });
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        })
        .then(data => {
          if (data.ok) {
            this.dashboard.log('🔄 Preview refresh requested');
          }
        })
        .catch(error => {
          // Solo loggear errores reales, no cuando no hay slaves
          if (!error.message.includes('No favorite slave connected') && 
              !error.message.includes('no_slaves')) {
            this.dashboard.log(`⚠️ Error requesting preview refresh: ${error.message}`);
          }
        });
    } catch (error) {
      this.dashboard.log(`⚠️ Error in requestPreviewRefreshThrottle: ${error.message}`);
    }
  }
}