/**
 * Gestor de Sesiones para el WPlace Master Dashboard
 * 
 * Este módulo maneja toda la lógica relacionada con las sesiones de trabajo:
 * - Creación, inicio, pausa y detención de sesiones
 * - Gestión del estado de sesiones (running, paused, stopped)
 * - Manejo de proyectos y configuración de sesiones
 * - Ejecución de lotes individuales (one-batch)
 * - Integración con la configuración Guard
 */

export class SessionManager {
  constructor(dashboard) {
    this.dashboard = dashboard;
    this.currentSession = null;
    this.sessionStatus = null; // 'running' | 'paused' | null
  }

  /**
   * Inicia una nueva sesión de trabajo
   */
  async startSession() {
    // Mostrar spinner y deshabilitar botón
    this.showStartSpinner();
    
    const selectedSlaves = this.dashboard.slaveManager.getSelectedSlaves();
    
    try {
      // Persistir selección
      localStorage.setItem('selectedSlaves', JSON.stringify(selectedSlaves));
      await fetch(`${this.dashboard.apiBase()}/api/ui/selected-slaves`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slave_ids: selectedSlaves })
      });
    } catch {}
    
    const strategy = document.getElementById('gc-chargeStrategy')?.value || 
                    this.dashboard.guardConfig?.chargeStrategy || 'greedy';

    if (!selectedSlaves.length || !this.dashboard.detectedBotMode) {
      this.dashboard.log('Please select slaves and load a project file');
      this.hideStartSpinner();
      return;
    }

    try {
      this.dashboard.log(`🚀 Starting session with mode: ${this.dashboard.detectedBotMode}`);
      
      // Crear proyecto
      const projectConfig = {
        mode: this.dashboard.detectedBotMode,
        config: this.dashboard.projectConfig || {}
      };

      const projectResponse = await fetch(`${this.dashboard.apiBase()}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: `Session ${Date.now()}`, 
          ...projectConfig 
        })
      });
      
      const projectData = await projectResponse.json();
      this.dashboard.log(`📁 Project created: ${projectData.project_id}`);

      // Crear sesión
      const sessionResponse = await fetch(`${this.dashboard.apiBase()}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectData.project_id,
          slave_ids: selectedSlaves,
          strategy: strategy
        })
      });
      
      const sessionData = await sessionResponse.json();
      this.currentSession = sessionData.session_id;
      this.dashboard.log(`🎯 Session created: ${this.currentSession}`);

      // Iniciar sesión (orquestador continuo)
      const startRes = await fetch(`${this.dashboard.apiBase()}/api/sessions/${this.currentSession}/start`, {
        method: 'POST'
      });
      const startJs = await startRes.json();
      const totalRem = startJs?.total_remaining ?? 0;
      
      this.dashboard.log(`✅ Session started; total remaining charges: ${totalRem}`);
      this.sessionStatus = 'running';
      
      // Actualizar UI
      const rc = document.getElementById('remaining-charges');
      if (rc) rc.textContent = String(totalRem);
      
      this._updateSessionButtons();
      this.hideStartSpinner();
      
      try { 
        this.dashboard.updateControlButtons(); 
      } catch {}
      
    } catch (error) {
      this.dashboard.log(`❌ Error starting session: ${error}`);
      this.hideStartSpinner();
    }
  }

  /**
   * Pausa la sesión actual
   */
  async pauseSession() {
    if (!this.currentSession) return;
    
    try {
      await fetch(`${this.dashboard.apiBase()}/api/sessions/${this.currentSession}/pause`, {
        method: 'POST'
      });
      this.dashboard.log('Session paused');
      this.sessionStatus = 'paused';
      this._updateSessionButtons();
      
      try { 
        this.dashboard.updateControlButtons(); 
      } catch {}
    } catch (error) {
      this.dashboard.log(`Error pausing session: ${error}`);
    }
  }

  /**
   * Detiene la sesión actual
   */
  async stopSession() {
    if (!this.currentSession) return;
    
    try {
      await fetch(`${this.dashboard.apiBase()}/api/sessions/${this.currentSession}/stop`, {
        method: 'POST'
      });
      this.dashboard.log('Session stopped');
      this.currentSession = null;
      this.sessionStatus = null;
      this._updateSessionButtons();
      
      try { 
        this.dashboard.updateControlButtons(); 
      } catch {}
    } catch (error) {
      this.dashboard.log(`Error stopping session: ${error}`);
    }
  }

  /**
   * Ejecuta un lote individual de trabajo
   */
  async sendOneBatch() {
    try {
      const selectedSlaves = this.dashboard.slaveManager.getSelectedSlaves();
      
      if (!selectedSlaves.length) {
        this.dashboard.log('⚠️ Selecciona al menos un slave');
        return;
      }
      
      if (!this.dashboard.detectedBotMode || !this.dashboard.projectConfig) {
        // Intentar rehidratar desde el backend si hay un último guard upload
        try {
          const resp = await fetch(`${this.dashboard.apiBase()}/api/guard/last-upload`);
          if (resp.ok) {
            const js = await resp.json();
            if (js && js.ok && js.data) {
              this.dashboard.projectConfig = js.data;
              this.dashboard.detectedBotMode = 'Guard';
              const detectedEl = document.getElementById('detected-mode');
              if (detectedEl) detectedEl.textContent = `Detected mode: ${this.dashboard.detectedBotMode}`;
              const statusEl = document.getElementById('file-status');
              if (statusEl) statusEl.textContent = `Loaded from server: ${js.filename || 'guard.json'}`;
              try { this.dashboard.previewManager.requestPreviewRefreshThrottle(); } catch {}
            }
          } else if (resp.status === 404) {
            // 404 es normal cuando no hay uploads previos, no es un error
            this.dashboard.log('ℹ️ No previous guard upload found (normal on first load)');
          }
        } catch (error) {
          // Solo loggear errores reales de red, no 404s
          if (error.message && !error.message.includes('404')) {
            this.dashboard.log('⚠️ Error checking for previous guard upload: ' + error.message);
          }
        }
      }

      if (!this.dashboard.detectedBotMode || !this.dashboard.projectConfig) {
        this.dashboard.log('⚠️ Carga un proyecto antes de pedir un lote');
        return;
      }
      
      // Asegurar sesión/proyecto creados si no existían
      if (!this.currentSession) {
        const projectConfig = {
          mode: this.dashboard.detectedBotMode,
          config: this.dashboard.projectConfig || {}
        };
        
        const projectResponse = await fetch(`${this.dashboard.apiBase()}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            name: `Session ${Date.now()}`, 
            ...projectConfig 
          })
        });
        const projectData = await projectResponse.json();
        
        const strategy = document.getElementById('gc-chargeStrategy')?.value || 
                        this.dashboard.guardConfig?.chargeStrategy || 'greedy';
        
        const sessionResponse = await fetch(`${this.dashboard.apiBase()}/api/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectData.project_id,
            slave_ids: selectedSlaves,
            strategy: strategy
          })
        });
        const sessionData = await sessionResponse.json();
        this.currentSession = sessionData.session_id;
      }
      
      this.dashboard.log('🎯 Ejecutando un lote usando el planificador cooperativo');
      
      const res = await fetch(`${this.dashboard.apiBase()}/api/sessions/${this.currentSession}/one-batch`, {
        method: 'POST'
      });
      const js = await res.json();
      
      if (res.ok && js.ok) {
        this.dashboard.log(`✅ Lote planificado: asignados ${js.assigned}, cargas totales ${js.total_remaining}`);
        const rc = document.getElementById('remaining-charges');
        if (rc) rc.textContent = String(js.total_remaining ?? '');
      } else {
        this.dashboard.log(`⚠️ No se pudo planificar lote: ${js.reason || js.detail || 'unknown'}`);
      }
    } catch (e) {
      this.dashboard.log(`❌ Error en 'Un lote': ${e?.message || e}`);
    }
  }

  /**
   * Actualiza el estado de los botones de sesión
   */
  _updateSessionButtons() {
    const startBtn = document.getElementById('start-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const oneBatchBtn = document.getElementById('one-batch-btn');
    
    if (this.sessionStatus === 'running') {
      if (startBtn) startBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
      if (oneBatchBtn) oneBatchBtn.disabled = false;
    } else if (this.sessionStatus === 'paused') {
      if (startBtn) startBtn.disabled = false;
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (oneBatchBtn) oneBatchBtn.disabled = false;
    } else {
      // stopped o null
      if (startBtn) startBtn.disabled = false;
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = true;
      if (oneBatchBtn) oneBatchBtn.disabled = true;
    }
  }

  /**
   * Muestra el spinner del botón Start
   */
  showStartSpinner() {
    const startBtnText = document.getElementById('start-btn-text');
    const startBtnSpinner = document.getElementById('start-btn-spinner');
    
    if (startBtnText && startBtnSpinner) {
      startBtnText.style.opacity = '0';
      startBtnSpinner.style.opacity = '1';
    }
  }

  /**
   * Oculta el spinner del botón Start
   */
  hideStartSpinner() {
    const startBtnText = document.getElementById('start-btn-text');
    const startBtnSpinner = document.getElementById('start-btn-spinner');
    
    if (startBtnText && startBtnSpinner) {
      startBtnText.style.opacity = '1';
      startBtnSpinner.style.opacity = '0';
    }
  }

  /**
   * Limpia el proyecto actual
   */
  async clearProject() {
    try {
      const r = await fetch(`${this.dashboard.apiBase()}/api/projects/clear-all`, {
        method: 'POST'
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.dashboard.log('🧹 Limpieza global solicitada');
    } catch (e) {
      this.dashboard.log(`⚠️ Error calling /api/projects/clear-all: ${e?.message || e}`);
    }
    
    // Detener análisis Guard en todos los slaves
    try {
      await fetch(`${this.dashboard.apiBase()}/api/guard/clear`, {
        method: 'POST'
      });
      this.dashboard.log('🛡️ Guard state cleared en slaves');
    } catch (e) {
      this.dashboard.log(`⚠️ Error clearing guard state: ${e?.message || e}`);
    }
    
    // Reset inmediato local
    try {
      const statusEl = document.getElementById('file-status');
      if (statusEl) statusEl.textContent = 'No file selected';
      
      const fileInput = document.getElementById('project-file');
      if (fileInput) fileInput.value = '';
      
      const detectedEl = document.getElementById('detected-mode');
      if (detectedEl) detectedEl.textContent = 'No file loaded - mode will be auto-detected';
      
      this.dashboard.activeProject = null;
      this.dashboard.projectConfig = null;
      this.dashboard.detectedBotMode = null;
      this.dashboard.previewManager.lastPreviewData = null;
      this.dashboard.previewManager.previewChanges = [];
      this.dashboard.previewManager.previewMeta = {};
      this.dashboard.previewManager.guardPreview = {
        analysis: null,
        togglesInitialized: false,
        show: { correct: true, incorrect: true, missing: true },
        area: null
      };
      
      const panel = document.getElementById('preview-panel');
      if (panel) panel.style.display = 'none';
      
      ['repaired-pixels', 'incorrect-pixels', 'missing-pixels'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '0';
      });
      
      try {
        localStorage.removeItem('previewPanel.height');
      } catch {}
      
      this.dashboard.updateControlButtons();
    } catch {}
    
    this.dashboard.previewManager.renderPreview();
  }

  /**
   * Detecta el modo del proyecto basado en su contenido
   */
  detectProjectMode(json, fileName) {
    // Prioridad explícita
    if (json && typeof json.mode === 'string') {
      const m = json.mode.toLowerCase();
      if (m.startsWith('guard')) return 'Guard';
      if (m.startsWith('image')) return 'Image';
    }
    
    // Señales de Guard
    const guardSignals = [
      json?.protectionData,
      json?.protectionArea,
      json?.originalPixels,
      json?.protectionData?.area,
      json?.protectionData?.protectedPixels,
    ].some(Boolean);
    
    // Señales de Image
    const imageSignals = [
      json?.imageData?.width,
      json?.imageData?.height,
      json?.imageData?.fullPixelData,
      Array.isArray(json?.remainingPixels) && json.remainingPixels.length > 0,
      Array.isArray(json?.imageData?.fullPixelData) && json.imageData.fullPixelData.length > 0,
      Array.isArray(json?.pixels) && json.pixels.length > 0
    ].some(Boolean);
    
    if (guardSignals && !imageSignals) return 'Guard';
    if (imageSignals && !guardSignals) return 'Image';
    
    // Heurística por nombre archivo
    const lower = fileName.toLowerCase();
    if (/guard|protection/.test(lower)) return 'Guard';
    if (/image|progress|collage/.test(lower)) return 'Image';
    
    // Empate: preferir Guard si protectionData existe
    if (guardSignals) return 'Guard';
    if (imageSignals) return 'Image';
    return 'Image'; // fallback
  }

  /**
   * Maneja el cambio de archivo de proyecto
   */
  handleFileChange(e) {
    try {
      const input = e?.target;
      const file = input && input.files && input.files[0];
      const statusEl = document.getElementById('file-status');
      const detectedEl = document.getElementById('detected-mode');
      
      if (!file) {
        if (statusEl) statusEl.textContent = 'No file selected';
        return;
      }
      
      if (statusEl) statusEl.textContent = 'Reading...';
      
      // Mostrar barra de progreso para carga de archivo
      this.dashboard.uiHelpers.showLoadingProgress(
        'file-loading-progress', 
        'file-loading-bar', 
        'file-loading-percentage'
      );
      
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const text = String(reader.result || '');
          const json = JSON.parse(text);
          this.dashboard.projectConfig = json;
          
          const mode = this.detectProjectMode(json, file.name);
          this.dashboard.detectedBotMode = mode;
          
          if (detectedEl) {
            detectedEl.textContent = mode ? `Detected mode: ${mode}` : 'Unknown mode';
          }
          if (statusEl) statusEl.textContent = `Loaded: ${file.name}`;
          
          // Mostrar preview según modo
          if (mode === 'Image') {
            this.dashboard.previewManager.showPreviewFromProject(json);
          } else {
            this.dashboard.previewManager.showGuardPreviewFromProject(json);
          }
          
          // Enviar guardData al favorito para rehidratar (si aplica)
          try {
            if (mode === 'Guard') {
              // Calcular tamaño del JSON para determinar si necesita compresión
              const jsonString = JSON.stringify({ filename: file.name, data: json });
              const jsonSize = new Blob([jsonString]).size;
              
              this.dashboard.log(`📏 Guard JSON size: ${(jsonSize / 1024 / 1024).toFixed(2)}MB`);
              
              // Si el archivo es muy grande (>10MB), usar compresión
              if (jsonSize > 10 * 1024 * 1024) {
                this.dashboard.log('🗜️ Large file detected, applying compression...');
                
                // Asegurar que pako esté disponible
                await this._ensurePako();
                
                // Comprimir usando gzip si está disponible
                if (window.pako && window.pako.gzip) {
                  try {
                    const compressed = window.pako.gzip(jsonString);
                    const compressedSize = compressed.length;
                    const compressionRatio = ((jsonSize - compressedSize) / jsonSize * 100).toFixed(1);
                    
                    this.dashboard.log(`🗜️ Compressed: ${(jsonSize / 1024 / 1024).toFixed(2)}MB → ${(compressedSize / 1024 / 1024).toFixed(2)}MB (${compressionRatio}% reduction)`);
                    
                    // Enviar datos comprimidos con headers especiales
                    fetch(`${this.dashboard.apiBase()}/api/guard/upload`, {
                      method: 'POST',
                      headers: { 
                        'Content-Type': 'application/octet-stream',
                        'X-Content-Encoding': 'gzip',
                        'X-Original-Filename': file.name,
                        'X-Original-Size': jsonSize.toString()
                      },
                      body: compressed
                    }).then(r => r.json()).then(resp => {
                      this.dashboard.log(`📤 Guard upload sent (compressed) → fav=${resp.sent_to || 'n/a'} pixels=${json?.originalPixels?.length || json?.protectionData?.protectedPixels || 0}`);
                    }).catch(err => {
                      this.dashboard.log('❌ Guard upload error (compressed): ' + (err?.message || err));
                      // Fallback: intentar sin compresión si falla
                      this._fallbackUncompressedUpload(file, json);
                    });
                    
                    return; // Salir temprano si la compresión funcionó
                  } catch (compressionError) {
                    this.dashboard.log('⚠️ Compression failed, trying uncompressed: ' + compressionError.message);
                  }
                } else {
                  this.dashboard.log('⚠️ Pako not available, trying uncompressed upload');
                }
              }
              
              // Envío normal (sin compresión o archivos pequeños)
              fetch(`${this.dashboard.apiBase()}/api/guard/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: jsonString
              }).then(r => r.json()).then(resp => {
                this.dashboard.log(`📤 Guard upload sent → fav=${resp.sent_to || 'n/a'} pixels=${json?.originalPixels?.length || json?.protectionData?.protectedPixels || 0}`);
              }).catch(err => {
                this.dashboard.log('❌ Guard upload error: ' + (err?.message || err));
              });
            }
          } catch (upErr) {
            this.dashboard.log('⚠️ Upload exception: ' + (upErr?.message || upErr));
          }
          
          this.dashboard.updateControlButtons();
        } catch (parseErr) {
          if (statusEl) statusEl.textContent = 'Invalid JSON';
          this.dashboard.log('❌ JSON parse error: ' + (parseErr?.message || parseErr));
        }
      };
      
      reader.onerror = () => {
        this.dashboard.projectConfig = null;
        this.dashboard.detectedBotMode = null;
        if (statusEl) statusEl.textContent = 'Read error';
        this.dashboard.updateControlButtons();
        this.dashboard.log('❌ File read error');
      };
      
      reader.readAsText(file);
    } catch (ex) {
      this.dashboard.log('❌ Unexpected handleFileChange error: ' + (ex?.message || ex));
    }
  }

  /**
   * Asegurar que pako esté disponible para compresión
   */
  async _ensurePako() {
    if (typeof window.pako !== 'undefined') {
      return; // Ya está disponible
    }

    try {
      // Intentar cargar pako dinámicamente
      const pako = await import('pako');
      window.pako = pako;
      this.dashboard.log('📦 Pako loaded dynamically');
    } catch (importError) {
      this.dashboard.log('⚠️ Failed to load pako dynamically, trying CDN...');
      
      // Fallback: cargar desde CDN
      return new Promise((resolve, reject) => {
        if (typeof window.pako !== 'undefined') {
          resolve();
          return;
        }

        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js';
        script.onload = () => {
          this.dashboard.log('📦 Pako loaded from CDN');
          resolve();
        };
        script.onerror = () => {
          this.dashboard.log('❌ Failed to load pako from CDN');
          reject(new Error('Failed to load pako'));
        };
        document.head.appendChild(script);
      });
    }
  }

  /**
   * Fallback para envío sin compresión cuando falla la compresión
   */
  _fallbackUncompressedUpload(file, json) {
    try {
      const jsonString = JSON.stringify({ filename: file.name, data: json });
      fetch(`${this.dashboard.apiBase()}/api/guard/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonString
      }).then(r => r.json()).then(resp => {
        this.dashboard.log(`📤 Guard upload sent (fallback) → fav=${resp.sent_to || 'n/a'} pixels=${json?.originalPixels?.length || json?.protectionData?.protectedPixels || 0}`);
      }).catch(err => {
        this.dashboard.log('❌ Guard upload error (fallback): ' + (err?.message || err));
      });
    } catch (fallbackError) {
      this.dashboard.log('❌ Fallback upload failed: ' + fallbackError.message);
    }
  }

  /**
   * Verifica si hay una sesión activa
   */
  hasActiveSession() {
    return this.currentSession !== null;
  }

  /**
   * Verifica si la sesión está corriendo
   */
  isSessionRunning() {
    return this.sessionStatus === 'running';
  }

  /**
   * Verifica si la sesión está pausada
   */
  isSessionPaused() {
    return this.sessionStatus === 'paused';
  }
}