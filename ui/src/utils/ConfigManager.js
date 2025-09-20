/**
 * Gestor de Configuración para el WPlace Master Dashboard
 * 
 * Este módulo maneja toda la lógica relacionada con la configuración Guard:
 * - Carga y guardado de configuración Guard
 * - Gestión de colores preferidos y excluidos
 * - Configuración de patrones de protección
 * - Manejo de toggles y controles de configuración
 * - Sincronización con el servidor
 */

export class ConfigManager {
  constructor(dashboard) {
    this.dashboard = dashboard;
    this.guardConfig = {};
    this.autoDistribute = false;
    this._preferredColorIds = new Set();
    this._excludedColorIds = new Set();
    this._configWired = false;
    this._saveTimer = null;
  }

  /**
   * Carga la configuración Guard desde el servidor
   */
  async loadGuardConfig() {
    const st = document.getElementById('guard-config-status');
    try {
      if (st) st.textContent = 'Loading...';
      
      const res = await fetch(`${this.dashboard.apiBase()}/api/guard/config`);
      const js = await res.json();
      this.guardConfig = js.config || {};
      this.autoDistribute = !!this.guardConfig?.autoDistribute;
      
      if (st) st.textContent = 'Config loaded';
      const st2 = document.getElementById('gc-status');
      if (st2) st2.textContent = 'Config loaded';
      
      this.dashboard.log('⚙️ Guard config loaded');
      
      // Inicializar sets y reflejar en el formulario inline
      try {
        this._preferredColorIds = new Set(Array.isArray(this.guardConfig?.preferredColorIds) ? 
          this.guardConfig.preferredColorIds : []);
        this._excludedColorIds = new Set(Array.isArray(this.guardConfig?.excludedColorIds) ? 
          this.guardConfig.excludedColorIds : []);
        this.applyGuardConfigToForm();
        this.ensureInlineSectionsVisibility();
        this.renderAllInlineChips();
      } catch {}
    } catch (e) {
      if (st) st.textContent = 'Error loading config';
      const st2 = document.getElementById('gc-status');
      if (st2) st2.textContent = 'Error loading config';
      this.dashboard.log('❌ Error loading guard config: ' + e?.message);
    }
  }

  /**
   * Aplica la configuración Guard al formulario
   */
  applyGuardConfigToForm() {
    const cfg = this.guardConfig || {};
    const map = [
      ['gc-protectionPattern', 'protectionPattern'],
      ['gc-preferColor', 'preferColor', 'checkbox'],
      ['gc-excludeColor', 'excludeColor', 'checkbox'],
      ['gc-spendAllPixelsOnStart', 'spendAllPixelsOnStart', 'checkbox'],
      ['gc-randomWaitTime', 'randomWaitTime', 'checkbox'],
      ['gc-minChargesToWait', 'minChargesToWait'],
      ['gc-pixelsPerBatch', 'pixelsPerBatch'],
      ['gc-chargeStrategy', 'chargeStrategy'],
      ['gc-recentLockSeconds', 'recentLockSeconds'],
      ['gc-randomWaitMin', 'randomWaitMin'],
      ['gc-randomWaitMax', 'randomWaitMax'],
      ['gc-colorThreshold', 'colorThreshold']
    ];
    
    map.forEach(([id, key, type]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (type === 'checkbox') {
        el.checked = !!cfg[key];
      } else if (cfg[key] !== undefined) {
        el.value = cfg[key];
      }
    });
    
    // Mostrar/ocultar tiempos aleatorios según toggle
    try {
      const rt = document.getElementById('gc-randomWaitTime');
      const times = document.getElementById('gc-random-times');
      if (times) times.style.display = (rt && rt.checked) ? '' : 'none';
    } catch {}
  }

  /**
   * Guarda la configuración Guard en el servidor
   */
  async saveGuardConfig() {
    const payload = {};
    const fields = [
      ['gc-protectionPattern', 'protectionPattern', 'value'],
      ['gc-preferColor', 'preferColor', 'checked'],
      ['gc-excludeColor', 'excludeColor', 'checked'],
      ['gc-spendAllPixelsOnStart', 'spendAllPixelsOnStart', 'checked'],
      ['gc-randomWaitTime', 'randomWaitTime', 'checked'],
      ['gc-minChargesToWait', 'minChargesToWait', 'value', 'int'],
      ['gc-pixelsPerBatch', 'pixelsPerBatch', 'value', 'int'],
      ['gc-maxRetries', 'maxRetries', 'value', 'int'],
      ['gc-chargeStrategy', 'chargeStrategy', 'value'],
      ['gc-recentLockSeconds', 'recentLockSeconds', 'value', 'int'],
      ['gc-randomWaitMin', 'randomWaitMin', 'value', 'float'],
      ['gc-randomWaitMax', 'randomWaitMax', 'value', 'float'],
      ['gc-colorThreshold', 'colorThreshold', 'value', 'int']
    ];
    
    fields.forEach(([id, key, prop, cast]) => {
      const el = document.getElementById(id);
      if (!el) return;
      let v = el[prop];
      if (cast === 'int') v = parseInt(v, 10);
      else if (cast === 'float') v = parseFloat(v);
      payload[key] = v;
    });
    
    try {
      const res = await fetch(`${this.dashboard.apiBase()}/api/guard/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const js = await res.json();
      
      if (js.ok) {
        this.guardConfig = js.config;
        this.autoDistribute = !!this.guardConfig.autoDistribute;
        this.dashboard.log('💾 Guard config saved');
        try {
          this.dashboard.recomputeRoundPlan();
        } catch {}
      } else {
        this.dashboard.log('⚠️ Guard config save failed');
      }
    } catch (e) {
      this.dashboard.log('❌ Error saving guard config: ' + e.message);
    }
  }

  /**
   * Configura los listeners del panel de configuración
   */
  setupConfigPanelListeners() {
    if (this._configWired) return; // evitar duplicados
    const panel = document.getElementById('config-panel');
    if (!panel) return; // componente no presente
    this._configWired = true;

    // Toggles: sincronizar visual y mostrar/ocultar secciones
    const wireToggle = (id, sectionId, onChange) => {
      const el = document.getElementById(id);
      if (!el) return;
      
      // estado visual inicial
      this.dashboard.updateToggleState(id, el.checked);
      if (sectionId) {
        const sec = document.getElementById(sectionId);
        if (sec) sec.style.display = el.checked ? '' : 'none';
      }
      
      el.addEventListener('change', () => {
        this.dashboard.updateToggleState(id, el.checked);
        if (sectionId) {
          const sec = document.getElementById(sectionId);
          if (sec) sec.style.display = el.checked ? '' : 'none';
        }
        if (onChange) onChange();
        this.scheduleConfigSave();
      });
    };

    // Configurar toggles principales
    wireToggle('gc-preferColor', 'gc-preferred-section', () => {
      this.ensureInlineSectionsVisibility();
    });
    wireToggle('gc-excludeColor', 'gc-excluded-section', () => {
      this.ensureInlineSectionsVisibility();
    });
    wireToggle('gc-randomWaitTime', 'gc-random-times');
    wireToggle('gc-spendAllPixelsOnStart');

    // Inputs numéricos y selects
    const numericIds = [
      'gc-minChargesToWait', 'gc-pixelsPerBatch', 'gc-recentLockSeconds',
      'gc-randomWaitMin', 'gc-randomWaitMax', 'gc-colorThreshold'
    ];
    numericIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.scheduleConfigSave());
      }
    });

    const selectIds = ['gc-protectionPattern', 'gc-chargeStrategy'];
    selectIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', () => this.scheduleConfigSave());
      }
    });

    // Configurar botones de colores inline
    this.setupInlineColorButtons();
    
    // Estado inicial
    this.ensureInlineSectionsVisibility();
    this.renderAllInlineChips();
  }

  /**
   * Programa el guardado automático de configuración
   */
  scheduleConfigSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this.saveGuardConfig();
    }, 1000); // 1 segundo de delay
  }

  /**
   * Asegura la visibilidad de las secciones inline
   */
  ensureInlineSectionsVisibility() {
    const preferToggle = document.getElementById('gc-preferColor');
    const excludeToggle = document.getElementById('gc-excludeColor');
    const preferSection = document.getElementById('gc-preferred-section');
    const excludeSection = document.getElementById('gc-excluded-section');
    
    if (preferSection) {
      preferSection.style.display = (preferToggle && preferToggle.checked) ? '' : 'none';
    }
    if (excludeSection) {
      excludeSection.style.display = (excludeToggle && excludeToggle.checked) ? '' : 'none';
    }
  }

  /**
   * Configura los botones de colores inline
   */
  setupInlineColorButtons() {
    // Botones para agregar colores
    const addPreferredBtn = document.getElementById('gc-add-preferred-btn');
    const addExcludedBtn = document.getElementById('gc-add-excluded-btn');
    
    if (addPreferredBtn) {
      addPreferredBtn.addEventListener('click', () => {
        this.showColorPicker('preferred');
      });
    }
    
    if (addExcludedBtn) {
      addExcludedBtn.addEventListener('click', () => {
        this.showColorPicker('excluded');
      });
    }
  }

  /**
   * Muestra el selector de color
   */
  showColorPicker(type) {
    // Implementación simplificada - en una implementación real usarías un color picker
    const colorId = prompt(`Ingresa el ID del color para ${type === 'preferred' ? 'preferir' : 'excluir'}:`);
    if (colorId !== null && colorId.trim() !== '') {
      const id = parseInt(colorId.trim(), 10);
      if (!isNaN(id)) {
        if (type === 'preferred') {
          this._preferredColorIds.add(id);
        } else {
          this._excludedColorIds.add(id);
        }
        this.renderAllInlineChips();
        this.scheduleConfigSave();
      }
    }
  }

  /**
   * Renderiza todos los chips de colores inline
   */
  renderAllInlineChips() {
    this.renderInlineChips('preferred', this._preferredColorIds);
    this.renderInlineChips('excluded', this._excludedColorIds);
  }

  /**
   * Renderiza los chips de colores para una categoría específica
   */
  renderInlineChips(type, colorSet) {
    const containerId = `gc-${type}-chips`;
    const container = document.getElementById(containerId);
    if (!container) return;
    
    container.innerHTML = '';
    
    if (colorSet.size === 0) {
      container.innerHTML = `<span class="text-xs text-muted-foreground">Ninguno seleccionado</span>`;
      return;
    }
    
    Array.from(colorSet).forEach(colorId => {
      const chip = document.createElement('span');
      chip.className = 'inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full';
      chip.innerHTML = `
        Color ${colorId}
        <button class="hover:bg-blue-200 rounded-full p-0.5" onclick="dashboard.configManager.removeColor('${type}', ${colorId})">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      `;
      container.appendChild(chip);
    });
  }

  /**
   * Remueve un color de la configuración
   */
  removeColor(type, colorId) {
    if (type === 'preferred') {
      this._preferredColorIds.delete(colorId);
    } else {
      this._excludedColorIds.delete(colorId);
    }
    this.renderAllInlineChips();
    this.scheduleConfigSave();
  }

  /**
   * Actualiza el estado habilitado del panel de configuración
   */
  updateConfigPanelEnabledState() {
    const hasSlaves = this.dashboard.slaveManager.hasConnectedSlaves();
    const hint = document.getElementById('config-disabled-hint');
    const panel = document.getElementById('config-panel');
    
    if (hint) {
      hint.style.display = hasSlaves ? 'none' : '';
    }
    
    if (panel) {
      const inputs = panel.querySelectorAll('input, select, button');
      inputs.forEach(input => {
        if (input.id !== 'clear-project-btn') { // Excluir botón de limpiar proyecto
          input.disabled = !hasSlaves;
        }
      });
    }
  }

  /**
   * Obtiene la configuración actual
   */
  getConfig() {
    return { ...this.guardConfig };
  }

  /**
   * Establece la configuración
   */
  setConfig(config) {
    this.guardConfig = { ...config };
    this.applyGuardConfigToForm();
  }

  /**
   * Verifica si la configuración está cargada
   */
  isConfigLoaded() {
    return Object.keys(this.guardConfig).length > 0;
  }

  /**
   * Obtiene los colores preferidos
   */
  getPreferredColors() {
    return Array.from(this._preferredColorIds);
  }

  /**
   * Obtiene los colores excluidos
   */
  getExcludedColors() {
    return Array.from(this._excludedColorIds);
  }

  /**
   * Establece los colores preferidos
   */
  setPreferredColors(colors) {
    this._preferredColorIds = new Set(colors);
    this.renderAllInlineChips();
  }

  /**
   * Establece los colores excluidos
   */
  setExcludedColors(colors) {
    this._excludedColorIds = new Set(colors);
    this.renderAllInlineChips();
  }
}