// WPlace Dashboard bootstrap module
// Carga los módulos utilitarios y expone una clase orquestadora que inicializa la app

import { WebSocketManager } from '/utils/WebSocketManager.js';
import { SlaveManager } from '/utils/SlaveManager.js';
import { PreviewManager } from '/utils/PreviewManager.js';
import { SessionManager } from '/utils/SessionManager.js';
import { ConfigManager } from '/utils/ConfigManager.js';
import { UIHelpers } from '/utils/UIHelpers.js';
import { ProjectsListManager } from '/utils/ProjectsListManager.js';

class WPlaceDashboard {
  constructor() {
    // Estado base
    this.detectedBotMode = null;
    this.projectConfig = null;
    this.activeProject = null;
    this.currentRoundPlan = {};
    this._recentRepairs = new Map();
    this._recentTTL = 5;

    // Módulos
    this.uiHelpers = new UIHelpers(this);
    this.webSocketManager = new WebSocketManager(this);
    this.slaveManager = new SlaveManager(this);
    this.previewManager = new PreviewManager(this);
    this.sessionManager = new SessionManager(this);
    this.configManager = new ConfigManager(this);
    this.projectsListManager = new ProjectsListManager(this);

    // Init
    this.init();
  }

  init() {
    this.webSocketManager.connect();
    this.setupEventListeners();
    this.configManager.loadGuardConfig();
    this.configManager.setupConfigPanelListeners();
    this.previewManager.restorePreviewPreferredHeight();

    try { this.updateControlButtons(); } catch {}
    try { this.configManager.updateConfigPanelEnabledState(); } catch {}
  }

  setupEventListeners() {
    document.getElementById('start-btn')?.addEventListener('click', () => this.sessionManager.startSession());
    document.getElementById('pause-btn')?.addEventListener('click', () => this.sessionManager.pauseSession());
    document.getElementById('stop-btn')?.addEventListener('click', () => this.sessionManager.stopSession());

    const oneBatchBtn = document.getElementById('one-batch-btn');
    if (oneBatchBtn) oneBatchBtn.addEventListener('click', () => this.sessionManager.sendOneBatch());

    const fitZoomBtn = document.getElementById('fit-zoom');
    if (fitZoomBtn) fitZoomBtn.addEventListener('click', () => this.previewManager.fitZoom());

    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => {
        const desired = parseFloat(e.target.value);
        this.previewManager.setZoom(desired);
      });
    }

    document.getElementById('project-file')?.addEventListener('change', (e) => this.sessionManager.handleFileChange(e));
    const clearBtn = document.getElementById('clear-project-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => this.sessionManager.clearProject());

    this.setupPreviewResizer();
    this.setupLogsToggle();

    window.addEventListener('resize', () => {
      const previewPanel = document.getElementById('preview-panel');
      if (previewPanel && previewPanel.style.display !== 'none') {
        this.previewManager.adjustPreviewSize();
      }
    });

    document.addEventListener('change', (e) => {
      const target = e.target;
      if (target && target.classList && target.classList.contains('slave-toggle')) {
        this.updateControlButtons();
        this.recomputeRoundPlan();
      }
    });
  }

  setupPreviewResizer() {
    const resizer = document.getElementById('preview-resizer');
    if (!resizer) return;

    let isResizing = false;
    let startY = 0;
    let startH = 0;

    resizer.addEventListener('mousedown', (e) => {
      const content = document.getElementById('preview-content');
      if (!content) return;

      isResizing = true;
      startY = e.clientY;
      startH = content.offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const onMove = (e) => {
      if (!isResizing) return;
      const content = document.getElementById('preview-content');
      if (!content) return;

      const delta = e.clientY - startY;
      const next = Math.max(520, Math.min(window.innerHeight * 0.95, startH + delta));
      content.style.height = `${Math.round(next)}px`;
      this.previewManager.persistPreviewPreferredHeight(Math.round(next));
      this.previewManager.fitZoom();
    };

    const onUp = () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.cursor = 'default';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }

  setupLogsToggle() {
    const logsToggle = document.getElementById('logs-toggle');
    const logsCaret = document.getElementById('logs-caret');
    const logsWrapper = document.getElementById('logs-wrapper');

    if (logsToggle && logsCaret && logsWrapper) {
      logsToggle.addEventListener('click', () => {
        const open = logsWrapper.style.maxHeight && parseInt(logsWrapper.style.maxHeight) > 0;
        if (open) {
          logsWrapper.style.maxHeight = '0px';
          logsCaret.style.transform = 'rotate(-90deg)';
        } else {
          logsWrapper.style.maxHeight = '220px';
          logsCaret.style.transform = 'rotate(0deg)';
        }
      });
    }
  }

  handleWebSocketMessage(message) {
    this.uiHelpers.logOnce(`proc:${message.type}`, `🔄 Processing message type: ${message.type}`, 1200);

    switch (message.type) {
      case 'projects_cleared':
        this.handleProjectsCleared();
        break;
      case 'project_created':
        this.handleProjectCreated(message);
        break;
      case 'initial_state':
        this.handleInitialState(message);
        break;
      case 'slave_connected':
      case 'slave_reconnected':
        this.handleSlaveConnected(message);
        break;
      case 'slave_disconnected':
        this.handleSlaveDisconnected(message);
        break;
      case 'ui_selected_slaves':
        this.handleUISelectedSlaves(message);
        break;
      case 'telemetry_update':
        this.handleTelemetryUpdate(message);
        break;
      case 'status_update':
        this.handleStatusUpdate(message);
        break;
      case 'slave_favorite':
        this.handleSlaveFavorite(message);
        break;
      case 'preview_data':
        this.handlePreviewData(message);
        break;
      case 'repair_ack':
      case 'repair_progress':
      case 'repair_complete':
      case 'repair_error':
        this.handleRepairMessages(message);
        break;
      case 'paint_progress':
      case 'paint_result':
        this.handlePaintMessages(message);
        break;
      case 'guard_config':
        this.handleGuardConfig(message);
        break;
      case 'guard_cleared':
        this.handleGuardCleared(message);
        break;
      case 'guard_upload_sent':
        this.handleGuardUploadSent(message);
        break;
      case 'project_created':
        this.upsertProjectInList(message.project);
        break;
      case 'project_deleted':
        this.removeProjectFromList(message.project_id);
        break;
      case 'log':
        this.log(`[${message.slave_id}] ${message.message}`);
        break;
      default:
        this.log(`❓ Unknown message type: ${message.type}`);
        console.log('Full unknown message:', message);
    }
  }

  handleProjectCreated(message) {
    try {
      if (message.project) {
        this.log(`📁 New project created: ${message.project.name} (${message.project.mode})`);
        this.upsertProjectInList(message.project);
        
        // Si es un proyecto Guard, actualizar la configuración actual
        if (message.project.mode === 'Guard') {
          this.projectConfig = message.project.config;
          this.detectedBotMode = 'Guard';
          
          const detectedEl = document.getElementById('detected-mode');
          if (detectedEl) detectedEl.textContent = `Detected mode: ${this.detectedBotMode}`;
          
          const statusEl = document.getElementById('file-status');
          if (statusEl) statusEl.textContent = `Loaded: ${message.project.name}`;
          
          try { this.previewManager.requestPreviewRefreshThrottle(); } catch {}
          this.updateControlButtons();
        }
      }
    } catch (e) {
      this.log(`❌ Error handling project_created: ${e.message}`);
    }
  }

  handleProjectsCleared() {
    this.log('🧹 Proyecto(s) limpiado(s)');
    try {
      const statusEl = document.getElementById('file-status');
      if (statusEl) statusEl.textContent = 'No file selected';

      this.activeProject = null;
      this.projectConfig = null;
      this.detectedBotMode = null;
      this.previewManager.lastPreviewData = null;
      this.previewManager.previewChanges = [];
      this.previewManager.previewMeta = {};
      this.previewManager.guardPreview = {
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

      try { localStorage.removeItem('previewPanel.height'); } catch {}
      this.updateControlButtons();
    } catch {}
    this.previewManager.renderPreview();
  }

  handleInitialState(message) {
    this.log(`📋 Initial state received with ${(message.slaves || []).length} slaves`);
    this.slaveManager.updateSlavesList(message.slaves || []);

    try {
      if (Array.isArray(message.selected_slaves)) {
        this.slaveManager._selectedSlavesServer = new Set(message.selected_slaves);
      }

      if (Array.isArray(message.available_colors) && message.available_colors.length > 0) {
        if (!this.previewManager.lastPreviewData) this.previewManager.lastPreviewData = {};
        const hasPalette = Array.isArray(this.previewManager.lastPreviewData.availableColors) && 
                           this.previewManager.lastPreviewData.availableColors.length > 0;
        if (!hasPalette) {
          this.previewManager.lastPreviewData.availableColors = message.available_colors;
          this.log('🎨 Paleta cargada desde initial_state');
          try { this.configManager.renderAllInlineChips(); } catch {}
        }
      }

      const fav = (message.slaves || []).find(s => s.is_favorite && s.telemetry && s.telemetry.preview_data);
      if (fav) this.handleFavoritePreviewData(fav);

      this.handleSessionRehydration(message);

      // Renderizar proyectos con logging para debug
      try {
        const projects = Array.isArray(message.projects) ? message.projects : [];
        this.log(`📁 Rendering ${projects.length} projects from initial_state`);
        if (projects.length > 0) {
          this.log(`📁 Projects: ${projects.map(p => `${p.name} (${p.mode})`).join(', ')}`);
        }
        this.renderProjectsList(projects);
        
        // Mostrar/ocultar mensaje de "no hay proyectos"
        const emptyEl = document.getElementById('projects-empty');
        if (emptyEl) {
          emptyEl.style.display = projects.length === 0 ? 'block' : 'none';
        }
      } catch (e) {
        this.log(`❌ Error rendering projects: ${e.message}`);
      }

      this.autoAssignFavoriteIfNeeded();

      try {
        const noProjects = !Array.isArray(message.projects) || message.projects.length === 0;
        if (noProjects && !this.projectConfig) {
          fetch(`${this.apiBase()}/api/guard/last-upload`).then(r => r.ok ? r.json() : null).then(js => {
            if (js && js.ok && js.data) {
              this.projectConfig = js.data;
              this.detectedBotMode = 'Guard';
              const detectedEl = document.getElementById('detected-mode');
              if (detectedEl) detectedEl.textContent = `Detected mode: ${this.detectedBotMode}`;
              const statusEl = document.getElementById('file-status');
              if (statusEl) statusEl.textContent = `Loaded from server: ${js.filename || 'guard.json'}`;
              const panel = document.getElementById('preview-panel');
              if (panel) panel.style.display = 'block';
              try { this.previewManager.requestPreviewRefreshThrottle(); } catch {}
              this.updateControlButtons();
              this.log('♻️ Project rehydrated from last guard upload');
            }
          }).catch(() => {});
        }
      } catch {}

      try { this.previewManager.requestPreviewRefreshThrottle(); } catch {}
    } catch (e) {
      this.log('Error loading persisted preview: ' + e.message);
    }
  }

  handleFavoritePreviewData(fav) {
    this.log(`🔁 Loading persisted preview from favorite slave ${fav.id}`);

    try {
      const pd = fav.telemetry.preview_data;
      const looksGuard = !!(pd && (pd.protectedArea || pd.area || pd.correctPixelsList || pd.incorrectPixelsList || pd.missingPixelsList || pd.analysis));
      const looksImage = !!(pd && (pd.imageData && (pd.imageData.fullPixelData || (pd.imageData.width && pd.imageData.height))));
      if (looksGuard) this.detectedBotMode = 'Guard';
      else if (looksImage) this.detectedBotMode = 'Image';
      const detectedEl = document.getElementById('detected-mode');
      if (detectedEl) detectedEl.textContent = this.detectedBotMode ? `Detected mode: ${this.detectedBotMode}` : 'No file loaded - mode will be auto-detected';
    } catch {}

    try {
      const pd = fav?.telemetry?.preview_data;
      if (pd) {
        this.previewManager.updatePreviewFromSlave(fav.id, pd);
        this.previewManager.renderGuardPreviewCanvas(pd);
      }
    } catch {}

    try { this.updateControlButtons(); } catch {}
  }

  handleSessionRehydration(message) {
    const sessions = Array.isArray(message.sessions) ? message.sessions : [];
    const projects = Array.isArray(message.projects) ? message.projects : [];

    const running = sessions.find(s => s.status === 'running');
    const paused = sessions.find(s => s.status === 'paused');
    const sess = running || paused || sessions[0];

    if (sess) {
      this.sessionManager.currentSession = sess.id || sess.session_id || null;
      this.sessionManager.sessionStatus = sess.status || null;
      this.log(`♻️ Rehydrated session: ${this.sessionManager.currentSession} (status=${sess.status || 'unknown'})`);

      if (Array.isArray(sess.slave_ids)) {
        setTimeout(() => {
          try {
            const ids = new Set(sess.slave_ids);
            document.querySelectorAll('.slave-toggle').forEach(cb => {
              cb.checked = ids.has(cb.value);
              this.updateToggleState(cb.id, cb.checked);
            });
            this.updateControlButtons();
          } catch {}
        }, 50);
      }

      const proj = projects.find(p => (p.id === sess.project_id));
      if (proj) this.handleProjectRehydration(proj);

      this.updateSessionButtonsFromStatus(sess.status);
      try { this.updateControlButtons(); } catch {}
    } else if (projects.length > 0) {
      this.log(`♻️ No sessions found, but ${projects.length} projects available. Loading first project.`);
      const proj = projects[0];
      if (proj) this.handleProjectRehydration(proj);
    }
  }

  handleProjectRehydration(proj) {
    const m = (proj.mode || '').toString().toLowerCase();
    this.detectedBotMode = m.startsWith('guard') ? 'Guard' : (m.startsWith('image') ? 'Image' : (proj.mode || null));
    this.projectConfig = proj.config || null;

    const detectedEl = document.getElementById('detected-mode');
    if (detectedEl) detectedEl.textContent = this.detectedBotMode ? `Detected mode: ${this.detectedBotMode}` : 'No file loaded - mode will be auto-detected';

    const statusEl = document.getElementById('file-status');
    if (statusEl) statusEl.textContent = proj.name ? `Loaded from server: ${proj.name}` : 'Loaded from server';

    const panel = document.getElementById('preview-panel');
    if (panel) panel.style.display = 'block';

    try {
      if ((this.detectedBotMode || '').toLowerCase().startsWith('guard') && !this.previewManager.lastPreviewData) {
        this.previewManager.requestPreviewRefreshThrottle();
      }
    } catch {}

    try { this.updateControlButtons(); } catch {}
    this.log(`♻️ Project rehydrated: mode=${this.detectedBotMode}, config=${!!this.projectConfig}`);
  }

  renderProjectsList(projects) {
    try { this.projectsListManager.render(projects || []); } catch {}
  }
  upsertProjectInList(project) {
    try { this.projectsListManager.upsert(project); } catch {}
  }
  removeProjectFromList(projectId) {
    try { this.projectsListManager.remove(projectId); } catch {}
  }

  updateSessionButtonsFromStatus(status) {
    const startBtn = document.getElementById('start-btn');
    const pauseBtn = document.getElementById('pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const oneBatchBtn = document.getElementById('one-batch-btn');

    if (status === 'running') {
      if (startBtn) startBtn.disabled = true;
      if (pauseBtn) pauseBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = false;
      if (oneBatchBtn) oneBatchBtn.disabled = false;
    } else if (status === 'paused') {
      if (startBtn) startBtn.disabled = false;
      if (pauseBtn) pauseBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (oneBatchBtn) oneBatchBtn.disabled = false;
    }
  }

  autoAssignFavoriteIfNeeded() {
    try {
      const anyFav = Array.from(this.slaveManager.slaves.values()).some(s => s && s.is_favorite);
      if (!anyFav && this.detectedBotMode && this.detectedBotMode.toLowerCase().startsWith('guard') && this.slaveManager.slaves.size > 0) {
        const first = Array.from(this.slaveManager.slaves.values())[0];
        if (first && first.id) {
          this.log(`⭐ No había favorito; autoasignando ${first.id}`);
          this.slaveManager.setFavoriteSlave(first.id).then(() => {
            try { this.previewManager.requestPreviewRefreshThrottle(); } catch {}
          }).catch(() => {});
        }
      }
    } catch {}
  }

  handleSlaveConnected(message) {
    this.log(`🤖 Slave ${message.type === 'slave_reconnected' ? 'reconnected' : 'connected'}: ${message.slave_id}`);
    setTimeout(() => {
      this.slaveManager.refreshSlaves();
      // Comentado: auto-activación automática de slaves
      // setTimeout(() => { this._autoActivateNewSlave(message.slave_id); }, 200);
    }, 100);
  }

  async _autoActivateNewSlave(slaveId) {
    try {
      const checkbox = document.getElementById(`slave-toggle-${slaveId}`);
      if (checkbox && !checkbox.checked) {
        checkbox.checked = true;
        this.updateToggleState(checkbox.id, true);

        const selected = Array.from(document.querySelectorAll('.slave-toggle:checked')).map(cb => cb.value);
        localStorage.setItem('selectedSlaves', JSON.stringify(selected));

        await fetch(`${this.apiBase()}/api/ui/selected-slaves`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slave_ids: selected })
        }).catch(() => {});

        if (this.sessionManager.sessionStatus === 'running') {
          await this._assignBatchesToNewSlave(slaveId);
        }

        this.updateControlButtons();
        this.recomputeRoundPlan();
        this.log(`✅ Auto-activated slave: ${slaveId}`);
      }
    } catch (error) {
      console.error('Error auto-activating slave:', error);
    }
  }

  async _assignBatchesToNewSlave(slaveId) {
    try {
      if (!this.detectedBotMode || !this.projectConfig) {
        this.log(`⚠️ No project loaded, cannot assign batches to new slave ${slaveId}`);
        return;
      }

      if (this.sessionManager.currentSession) {
        const currentSelectedSlaves = Array.from(document.querySelectorAll('.slave-toggle:checked')).map(cb => cb.value);
        const updateResponse = await fetch(`${this.apiBase()}/api/sessions/${this.sessionManager.currentSession}/update-slaves`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slave_ids: currentSelectedSlaves })
        });
        if (updateResponse.ok) {
          this.log(`🎯 Updated session with new slave ${slaveId} - batches will be assigned automatically`);
        } else {
          this.log(`⚠️ Failed to update session with new slave ${slaveId}`);
        }
      }
    } catch (error) {
      this.log(`❌ Error assigning batches to new slave ${slaveId}: ${error}`);
    }
  }

  handleSlaveDisconnected(message) {
    this.log(`🔌 Slave disconnected: ${message.slave_id}`);
    this.slaveManager.slaves.delete(message.slave_id);
    this.slaveManager.displaySlaves();
  }

  handleUISelectedSlaves(message) {
    if (Array.isArray(message.slave_ids)) {
      this.slaveManager._selectedSlavesServer = new Set(message.slave_ids);
      if (this.slaveManager.slaves.size > 0) this.slaveManager.applyServerSelection();
      else this.slaveManager.displaySlaves();
    }
  }

  handleTelemetryUpdate(message) {
    this.log(`📈 Telemetry from ${message.slave_id}: charges=${message.telemetry?.remaining_charges || 'N/A'}`);
    this.slaveManager.updateTelemetry(message.slave_id, message.telemetry);

    try {
      if (message.telemetry && message.telemetry.preview_data) {
        try {
          const favId = this.slaveManager.getFavoriteSlaveId();
          if (favId && favId === message.slave_id) this.ageRecentRepairs();
        } catch {}

        const pd = message.telemetry.preview_data;
        if (!this.detectedBotMode) {
          const looksGuard = !!(pd && (pd.protectedArea || pd.area || pd.correctPixelsList || pd.incorrectPixelsList || pd.missingPixelsList || pd.analysis));
          const looksImage = !!(pd && (pd.imageData && (pd.imageData.fullPixelData || (pd.imageData.width && pd.imageData.height))));
          if (looksGuard) this.detectedBotMode = 'Guard';
          else if (looksImage) this.detectedBotMode = 'Image';
          const detectedEl = document.getElementById('detected-mode');
          if (detectedEl) detectedEl.textContent = this.detectedBotMode ? `Detected mode: ${this.detectedBotMode}` : 'No file loaded - mode will be auto-detected';
        }

        this.previewManager.updatePreviewFromSlave(message.slave_id, pd);
        this.recomputeRoundPlan();
        this.updateControlButtons();
      }
    } catch {}
  }

  handleStatusUpdate(message) {
    this.log(`📊 Status update from ${message.slave_id}: ${message.status}`);
    this.slaveManager.updateSlaveStatus(message.slave_id, message.status);
  }

  handleSlaveFavorite(message) {
    this.log(`⭐ Slave ${message.slave_id} marked as favorite`);
    this.slaveManager.slaves.forEach(s => { if (s) s.is_favorite = false; });
    if (this.slaveManager.slaves.has(message.slave_id)) this.slaveManager.slaves.get(message.slave_id).is_favorite = true;
    this.slaveManager.displaySlaves();
  }

  handlePreviewData(message) {
    const now = Date.now();
    if (now - this.previewManager.lastPreviewAt < 5000) {
      this.uiHelpers.logOnce('throttle:preview', '⏱️ Preview update throttled', 3000);
      return;
    }

    this.previewManager.lastPreviewAt = now;
    this.log(`🖼️ Preview data from ${message.slave_id}: ${message.data ? 'Data received' : 'No data'}`);

    if (message.data && message.data.analysis) {
      this.uiHelpers.logOnce('preview:summary', `📊 Preview analysis: ${message.data.analysis.correctPixels || 0} correct, ${message.data.analysis.incorrectPixels || 0} incorrect, ${message.data.analysis.missingPixels || 0} missing`, 3000);
    }

    try {
      const favId = this.slaveManager.getFavoriteSlaveId();
      if (favId && favId === message.slave_id) this.ageRecentRepairs();
    } catch {}

    this.previewManager.updatePreviewFromSlave(message.slave_id, message.data);
    this.recomputeRoundPlan();
    try { this.updateControlButtons(); } catch {}
  }

  handleRepairMessages(message) {
    switch (message.type) {
      case 'repair_ack':
        this.uiHelpers.logOnce(`ack:${message.slave_id}:${message.total_repairs}`, `🔧 Slave ${message.slave_id} acknowledged repair order: ${message.total_repairs} pixels`, 5000);
        break;
      case 'repair_progress':
        this.uiHelpers.logOnce(`prog:${message.slave_id}:${message.completed}/${message.total}`, `🎨 Slave ${message.slave_id} repair progress: ${message.completed}/${message.total} pixels`, 3500);
        break;
      case 'repair_complete':
        this.uiHelpers.logOnce(`done:${message.slave_id}:${message.completed}`, `✅ Slave ${message.slave_id} completed repairs: ${message.completed} pixels`, 8000);
        try { this.slaveManager.highlightSlaveCard(String(message.slave_id), true); } catch {}
        this.previewManager.requestPreviewRefreshThrottle();
        break;
      case 'repair_error':
        this.uiHelpers.logOnce(`err:${message.slave_id}:${message.error}`, `❌ Slave ${message.slave_id} repair error: ${message.error}`, 8000);
        try { this.slaveManager.highlightSlaveCard(String(message.slave_id), false); } catch {}
        break;
    }
  }

  handlePaintMessages(message) {
    switch (message.type) {
      case 'paint_progress':
        this.uiHelpers.logOnce(`paint:prog:${message.slave_id}:${message.tileX},${message.tileY}:${message.completed}/${message.total}`, `🎯 Paint progress ${message.completed}/${message.total} en tile ${message.tileX},${message.tileY} [${message.slave_id}]`, 3000);
        break;
      case 'paint_result':
        const ok = message.ok ?? message.success ?? (message.status === 'ok');
        const msg = ok ? `✅ Pintado correcto (${message.painted || message.completed || 0})` : `❌ Pintado fallido: ${message.error || message.status || 'unknown'}`;
        this.uiHelpers.logOnce(`paint:res:${message.slave_id}:${ok}:${message.painted || message.completed || 0}:${message.tileX},${message.tileY}`, `[${message.slave_id}] ${msg}`, 6000);
        try { this.slaveManager.highlightSlaveCard(String(message.slave_id), !!ok); } catch {}
        try { if (ok && Array.isArray(message.coords) && message.coords.length) this.markRecentRepairs(message.coords); } catch {}
        this.previewManager.requestPreviewRefreshThrottle();
        break;
    }
  }

  handleGuardConfig(message) {
    this.log(`⚙️ Guard config received from server`);
    if (message.config) {
      this.configManager.guardConfig = message.config;
      if (message.config.autoDistribute !== undefined) this.configManager.autoDistribute = message.config.autoDistribute;

      try {
        this.configManager._preferredColorIds = new Set(Array.isArray(this.configManager.guardConfig?.preferredColorIds) ? this.configManager.guardConfig.preferredColorIds : []);
        this.configManager._excludedColorIds = new Set(Array.isArray(this.configManager.guardConfig?.excludedColorIds) ? this.configManager.guardConfig.excludedColorIds : []);
        this.configManager.applyGuardConfigToForm();
        this.configManager.ensureInlineSectionsVisibility();
        this.configManager.renderAllInlineChips();
      } catch {}

      try { this.recomputeRoundPlan(); } catch {}
    }
  }

  handleGuardCleared(message) {
    this.log(`🧹 Guard state cleared by server`);
    try {
      const panel = document.getElementById('preview-panel');
      if (panel) panel.style.display = 'none';

      const fileInput = document.getElementById('project-file');
      if (fileInput) fileInput.value = '';

      const statusEl = document.getElementById('file-status');
      if (statusEl) statusEl.textContent = 'No file selected';

      const detectedEl = document.getElementById('detected-mode');
      if (detectedEl) detectedEl.textContent = 'No file loaded - mode will be auto-detected';

      this.projectConfig = null;
      this.detectedBotMode = null;
      this.previewManager.lastPreviewData = null;
      this.previewManager.guardPreview = {
        analysis: null,
        togglesInitialized: false,
        show: { correct: true, incorrect: true, missing: true },
        area: null
      };

      ['repaired-pixels', 'incorrect-pixels', 'missing-pixels'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '0'; });
    } catch {}
  }

  handleGuardUploadSent(message) {
    this.log(`📤 Guard upload ACK → fav=${message.sent_to || message.slave_id || 'n/a'} size=${message.originalLength || message.size || 'n/a'} compressed=${message.compressedLength || 'n/a'}`);
  }

  updateControlButtons() {
    const selectedSlaves = document.querySelectorAll('.slave-toggle:checked');

    if (!this.detectedBotMode) {
      const looksGuard = !!(this.previewManager?.guardPreview?.analysis || (this.previewManager?.lastPreviewData && (this.previewManager.lastPreviewData.correctPixelsList || this.previewManager.lastPreviewData.incorrectPixelsList || this.previewManager.lastPreviewData.missingPixelsList || this.previewManager.lastPreviewData.analysis || this.previewManager.lastPreviewData.protectedArea || this.previewManager.lastPreviewData.area)));
      const looksImage = !!(this.projectConfig?.imageData || (this.previewManager?.lastPreviewData && this.previewManager.lastPreviewData.imageData));
      if (looksGuard) this.detectedBotMode = 'Guard';
      else if (looksImage) this.detectedBotMode = 'Image';
      if (this.detectedBotMode) { const dm = document.getElementById('detected-mode'); if (dm) dm.textContent = `Detected mode: ${this.detectedBotMode}`; }
    }

    const hasMode = this.detectedBotMode !== null;
    const hasSelected = selectedSlaves.length > 0;

    let guardReady = true;
    if (this.detectedBotMode === 'Guard') {
      const favId = this.slaveManager.getFavoriteSlaveId();
      const hasFav = !!favId;
      const hasProject = !!this.projectConfig;
      const hasGuardData = !!(this.previewManager?.guardPreview?.analysis || (this.previewManager?.lastPreviewData && (this.previewManager.lastPreviewData.originalPixels || this.previewManager.lastPreviewData.analysis)));
      guardReady = hasFav && (hasProject || hasGuardData);
    }

    const isRunning = this.sessionManager.sessionStatus === 'running';
    const baseCanStart = hasSelected && hasMode && guardReady;
    const canStart = !isRunning && baseCanStart;

    const startBtn = document.getElementById('start-btn');
    if (startBtn) startBtn.disabled = !canStart;

    const hasSlaves = this.slaveManager.hasConnectedSlaves();
    const oneBatchBtn = document.getElementById('one-batch-btn');
    const oneBatchBtnPreview = document.getElementById('one-batch-btn-preview');
    if (oneBatchBtn) oneBatchBtn.disabled = !hasSlaves;
    if (oneBatchBtnPreview) oneBatchBtnPreview.disabled = !hasSlaves;
  }

  recomputeRoundPlan() {
    this.currentRoundPlan = {};
    
    // Obtener configuración actual desde ConfigManager
    const guardConfig = this.configManager?.guardConfig || {};
    const pixelsPerBatch = parseInt(guardConfig.pixelsPerBatch) || 10;
    const minChargesToWait = parseInt(guardConfig.minChargesToWait) || 20;
    const spendAll = guardConfig.spendAllPixelsOnStart === true;
    
    const selectedSlaves = Array.from(document.querySelectorAll('.slave-toggle:checked'));
    selectedSlaves.forEach(cb => {
      const slaveId = cb.value;
      const slave = this.slaveManager.slaves.get(slaveId);
      if (slave && slave.telemetry) {
        const charges = slave.telemetry.remaining_charges || 0;
        
        // Calcular cuota según lógica de Guard:
        let quota = 0;
        
        if (spendAll) {
          // Modo spend all: gastar todo menos un mínimo de seguridad
          const safetyMin = Math.min(5, minChargesToWait);
          quota = Math.max(0, charges - safetyMin);
        } else {
          // Modo normal: un slave es elegible si tiene minChargesToWait + pixelsPerBatch
          const required = minChargesToWait + pixelsPerBatch;
          const isEligible = charges >= required;
          
          if (isEligible) {
            // Calcular capacidad: cargas disponibles - mínimo a mantener, limitado al tamaño de lote
            const spendable = Math.max(0, charges - minChargesToWait);
            quota = Math.min(spendable, pixelsPerBatch);
          }
        }
        
        this.currentRoundPlan[slaveId] = quota;
        this.slaveManager.updateSlaveCardQuota(slaveId, quota, charges > 0 ? (quota / charges) : 0);
      }
    });
  }

  markRecentRepairs(coords) {
    const now = Date.now();
    coords.forEach(coord => { const key = `${coord.x},${coord.y}`; this._recentRepairs.set(key, now); });
  }

  ageRecentRepairs() {
    const now = Date.now();
    const ttl = this._recentTTL * 30000;
    for (const [key, timestamp] of this._recentRepairs.entries()) {
      if ((now - timestamp) > ttl) this._recentRepairs.delete(key);
    }
  }

  apiBase() {
    try {
      const serverUrl = this.webSocketManager.getServerUrl();
      if (typeof serverUrl === 'string' && serverUrl.length) {
        if (serverUrl.startsWith('ws://')) return serverUrl.replace(/^ws:\/\//, 'http://');
        if (serverUrl.startsWith('wss://')) return serverUrl.replace(/^wss:\/\//, 'https://');
        if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) return serverUrl;
      }
    } catch {}
    const protocol = window.location.protocol === 'https:' ? 'https://' : 'http://';
    return `${protocol}${window.location.hostname}:8008`;
  }

  // Delegados
  log(message) { return this.uiHelpers.log(message); }
  logOnce(key, message, ttl) { return this.uiHelpers.logOnce(key, message, ttl); }
  updateToggleState(id, checked) { return this.uiHelpers.updateToggleState(id, checked); }
  createCompactToggle(id, label, checked) { return this.uiHelpers.createCompactToggle(id, label, checked); }
  updateOverallProgressBar(percentage) { return this.uiHelpers.updateOverallProgressBar(percentage); }
  updateConfigPanelEnabledState() { return this.configManager.updateConfigPanelEnabledState(); }
  requestPreviewRefreshThrottle() { return this.previewManager.requestPreviewRefreshThrottle(); }
}

// Exponer en window e inicializar
window.dashboard = new WPlaceDashboard();

export default WPlaceDashboard;
