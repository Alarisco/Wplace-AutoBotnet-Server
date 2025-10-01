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
        // Forzar actualización visual de todos los toggles después de aplicar config
        this.refreshAllToggles();
      } catch {}
    } catch (e) {
      if (st) st.textContent = 'Error loading config';
      const st2 = document.getElementById('gc-status');
      if (st2) st2.textContent = 'Error loading config';
      this.dashboard.log('❌ Error loading guard config: ' + e?.message);
    }
  }

  /**
   * Refresca el estado visual de todos los toggles
   */
  refreshAllToggles() {
    const toggleIds = [
      'gc-preferColor',
      'gc-excludeColor',
      'gc-randomWaitTime',
      'gc-spendAllPixelsOnStart',
      'gc-protectTransparentPixels',
      'gc-protectPerimeter'
    ];
    
    toggleIds.forEach(id => {
      const input = document.getElementById(id);
      if (input && input.type === 'checkbox') {
        this.updateToggleVisual(id, input.checked);
      }
    });
  }

  /**
   * Aplica la configuración Guard al formulario
   */
  applyGuardConfigToForm() {
    const cfg = this.guardConfig || {};
    
    // Valores por defecto (deben coincidir con server/storage.py)
    const defaults = {
      operationMode: 'protect',
      protectionPattern: 'random',
      preferColor: false,
      excludeColor: false,
      spendAllPixelsOnStart: false,
      randomWaitTime: false,
      protectTransparentPixels: true,
      protectPerimeter: false,
      minChargesToWait: 20,
      pixelsPerBatch: 10,
      maxRetries: 3,
      chargeStrategy: 'greedy',
      recentLockSeconds: 60,
      randomWaitMin: 5,
      randomWaitMax: 15,
      colorThreshold: 10,
      perimeterWidth: 1
    };
    
    const map = [
      ['gc-operationMode', 'operationMode'],
      ['gc-protectionPattern', 'protectionPattern'],
      ['gc-preferColor', 'preferColor', 'checkbox'],
      ['gc-excludeColor', 'excludeColor', 'checkbox'],
      ['gc-spendAllPixelsOnStart', 'spendAllPixelsOnStart', 'checkbox'],
      ['gc-randomWaitTime', 'randomWaitTime', 'checkbox'],
      ['gc-protectTransparentPixels', 'protectTransparentPixels', 'checkbox'],
      ['gc-protectPerimeter', 'protectPerimeter', 'checkbox'],
      ['gc-minChargesToWait', 'minChargesToWait'],
      ['gc-pixelsPerBatch', 'pixelsPerBatch'],
      ['gc-maxRetries', 'maxRetries'],
      ['gc-chargeStrategy', 'chargeStrategy'],
      ['gc-recentLockSeconds', 'recentLockSeconds'],
      ['gc-randomWaitMin', 'randomWaitMin'],
      ['gc-randomWaitMax', 'randomWaitMax'],
      ['gc-colorThreshold', 'colorThreshold'],
      ['gc-perimeterWidth', 'perimeterWidth']
    ];
    
    for (const [elemId, cfgKey, type] of map) {
      const elem = document.getElementById(elemId);
      if (!elem) continue;
      
      // Usar valor del servidor, o valor por defecto si no existe
      const val = cfg[cfgKey] !== undefined ? cfg[cfgKey] : defaults[cfgKey];
      
      if (type === 'checkbox') {
        elem.checked = !!val;
        // Actualizar estado visual del toggle
        this.updateToggleVisual(elemId, !!val);
      } else {
        elem.value = val ?? '';
      }
    }
    
    // Manejar visibilidad de secciones condicionales
    this.ensureInlineSectionsVisibility();
    
    // Manejar visibilidad del contenedor de ancho de perímetro
    const protectPerimeter = cfg.protectPerimeter ?? defaults.protectPerimeter;
    const perimeterContainer = document.getElementById('gc-perimeter-width-container');
    if (perimeterContainer) {
      perimeterContainer.style.display = protectPerimeter ? 'block' : 'none';
    }
  }

  /**
   * Actualiza el estado visual de un toggle
   */
  updateToggleVisual(id, checked) {
    const input = document.getElementById(id);
    if (!input) return;
    
    // Actualizar el estado del input
    input.checked = checked;
    
    // Buscar el switch container
    const label = input.closest('label');
    if (!label) return;
    
    // Actualizar track y thumb
    const track = label.querySelector('.switch__track');
    const thumb = label.querySelector('.switch__thumb');
    
    if (track) {
      track.style.backgroundColor = checked 
        ? 'hsl(var(--primary))' 
        : 'hsl(var(--border))';
    }
    
    if (thumb) {
      thumb.style.transform = checked 
        ? 'translateY(-50%) translateX(18px)' 
        : 'translateY(-50%) translateX(0)';
    }
  }

  /**
   * Guarda la configuración Guard en el servidor
   */
  async saveGuardConfig() {
    const payload = {};
    const fields = [
      ['gc-operationMode', 'operationMode', 'value'],
      ['gc-protectionPattern', 'protectionPattern', 'value'],
      ['gc-preferColor', 'preferColor', 'checked'],
      ['gc-excludeColor', 'excludeColor', 'checked'],
      ['gc-spendAllPixelsOnStart', 'spendAllPixelsOnStart', 'checked'],
      ['gc-randomWaitTime', 'randomWaitTime', 'checked'],
      ['gc-protectTransparentPixels', 'protectTransparentPixels', 'checked'],
      ['gc-protectPerimeter', 'protectPerimeter', 'checked'],
      ['gc-minChargesToWait', 'minChargesToWait', 'value', 'int'],
      ['gc-pixelsPerBatch', 'pixelsPerBatch', 'value', 'int'],
      ['gc-maxRetries', 'maxRetries', 'value', 'int'],
      ['gc-chargeStrategy', 'chargeStrategy', 'value'],
      ['gc-recentLockSeconds', 'recentLockSeconds', 'value', 'int'],
      ['gc-randomWaitMin', 'randomWaitMin', 'value', 'float'],
      ['gc-randomWaitMax', 'randomWaitMax', 'value', 'float'],
      ['gc-colorThreshold', 'colorThreshold', 'value', 'int'],
      ['gc-perimeterWidth', 'perimeterWidth', 'value', 'int']
    ];
    
    fields.forEach(([id, key, prop, cast]) => {
      const el = document.getElementById(id);
      if (!el) return;
      let v = el[prop];
      if (cast === 'int') v = parseInt(v, 10);
      else if (cast === 'float') v = parseFloat(v);
      payload[key] = v;
    });
    
    // Agregar arrays de colores seleccionados
    payload.preferredColorIds = Array.from(this._preferredColorIds);
    payload.excludedColorIds = Array.from(this._excludedColorIds);
    
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
      this.updateToggleVisual(id, el.checked);
      if (sectionId) {
        const sec = document.getElementById(sectionId);
        if (sec) sec.style.display = el.checked ? '' : 'none';
      }
      
      el.addEventListener('change', () => {
        this.updateToggleVisual(id, el.checked);
        if (sectionId) {
          const sec = document.getElementById(sectionId);
          if (sec) sec.style.display = el.checked ? '' : 'none';
        }
        if (onChange) onChange();
        this.scheduleConfigSave();
      });
    };

    // Configurar toggles principales
    wireToggle('gc-preferColor', 'gc-preferredColors-section', () => {
      this.ensureInlineSectionsVisibility();
    });
    wireToggle('gc-excludeColor', 'gc-excludedColors-section', () => {
      this.ensureInlineSectionsVisibility();
    });
    wireToggle('gc-randomWaitTime', 'gc-random-times');
    wireToggle('gc-spendAllPixelsOnStart');
    wireToggle('gc-protectTransparentPixels');
    wireToggle('gc-protectPerimeter', null, () => {
      const perimeterContainer = document.getElementById('gc-perimeter-width-container');
      if (perimeterContainer) {
        perimeterContainer.style.display = document.getElementById('gc-protectPerimeter').checked ? 'block' : 'none';
      }
    });

    // Inputs numéricos y selects
    const numericIds = [
      'gc-minChargesToWait', 'gc-pixelsPerBatch', 'gc-recentLockSeconds',
      'gc-randomWaitMin', 'gc-randomWaitMax', 'gc-colorThreshold', 'gc-perimeterWidth'
    ];
    numericIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.scheduleConfigSave());
      }
    });

    const selectIds = ['gc-operationMode', 'gc-protectionPattern', 'gc-chargeStrategy'];
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
    const preferSection = document.getElementById('gc-preferredColors-section');
    const excludeSection = document.getElementById('gc-excludedColors-section');
    
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
    // Los botones ya no son necesarios, la paleta visual permite seleccionar directamente
    // Configurar botones de limpiar
    const clearPreferredBtn = document.getElementById('gc-clearPreferred');
    const clearExcludedBtn = document.getElementById('gc-clearExcluded');
    
    if (clearPreferredBtn) {
      clearPreferredBtn.addEventListener('click', () => {
        this._preferredColorIds.clear();
        this.renderAllInlineChips();
        this.scheduleConfigSave();
      });
    }
    
    if (clearExcludedBtn) {
      clearExcludedBtn.addEventListener('click', () => {
        this._excludedColorIds.clear();
        this.renderAllInlineChips();
        this.scheduleConfigSave();
      });
    }
  }

  /**
   * Renderiza todos los chips de colores inline y la paleta disponible
   */
  renderAllInlineChips() {
    this.renderAvailableColorsPalette();
    this.updateClearButtonsVisibility();
  }

  /**
   * Renderiza la paleta de colores disponibles
   */
  renderAvailableColorsPalette() {
    const availableColors = this.getAvailableColors();
    
    // Renderizar paleta para preferidos
    this.renderColorPalette('preferred', availableColors);
    
    // Renderizar paleta para excluidos  
    this.renderColorPalette('excluded', availableColors);
  }

  /**
   * Obtiene los colores disponibles del slave favorito o preview manager
   */
  getAvailableColors() {
    // Mapeo completo de colores con información RGB
    const COLOR_MAP = {
      0: { id: 0, name: 'Black', rgb: { r: 0, g: 0, b: 0 } },
      1: { id: 1, name: 'Dark Gray', rgb: { r: 60, g: 60, b: 60 } },
      2: { id: 2, name: 'Gray', rgb: { r: 120, g: 120, b: 120 } },
      3: { id: 3, name: 'Light Gray', rgb: { r: 210, g: 210, b: 210 } },
      4: { id: 4, name: 'White', rgb: { r: 255, g: 255, b: 255 } },
      5: { id: 5, name: 'Deep Red', rgb: { r: 96, g: 0, b: 24 } },
      6: { id: 6, name: 'Red', rgb: { r: 237, g: 28, b: 36 } },
      7: { id: 7, name: 'Orange', rgb: { r: 255, g: 127, b: 39 } },
      8: { id: 8, name: 'Gold', rgb: { r: 246, g: 170, b: 9 } },
      9: { id: 9, name: 'Yellow', rgb: { r: 249, g: 221, b: 59 } },
      10: { id: 10, name: 'Light Yellow', rgb: { r: 255, g: 250, b: 188 } },
      11: { id: 11, name: 'Dark Green', rgb: { r: 14, g: 185, b: 104 } },
      12: { id: 12, name: 'Green', rgb: { r: 19, g: 230, b: 123 } },
      13: { id: 13, name: 'Light Green', rgb: { r: 135, g: 255, b: 94 } },
      14: { id: 14, name: 'Dark Teal', rgb: { r: 12, g: 129, b: 110 } },
      15: { id: 15, name: 'Teal', rgb: { r: 16, g: 174, b: 166 } },
      16: { id: 16, name: 'Light Teal', rgb: { r: 19, g: 225, b: 190 } },
      17: { id: 17, name: 'Cyan', rgb: { r: 96, g: 247, b: 242 } },
      18: { id: 18, name: 'Light Cyan', rgb: { r: 187, g: 250, b: 242 } },
      19: { id: 19, name: 'Dark Blue', rgb: { r: 40, g: 80, b: 158 } },
      20: { id: 20, name: 'Blue', rgb: { r: 64, g: 147, b: 228 } },
      21: { id: 21, name: 'Indigo', rgb: { r: 107, g: 80, b: 246 } },
      22: { id: 22, name: 'Light Indigo', rgb: { r: 153, g: 177, b: 251 } },
      23: { id: 23, name: 'Dark Purple', rgb: { r: 120, g: 12, b: 153 } },
      24: { id: 24, name: 'Purple', rgb: { r: 170, g: 56, b: 185 } },
      25: { id: 25, name: 'Light Purple', rgb: { r: 224, g: 159, b: 249 } },
      26: { id: 26, name: 'Dark Pink', rgb: { r: 203, g: 0, b: 122 } },
      27: { id: 27, name: 'Pink', rgb: { r: 236, g: 31, b: 128 } },
      28: { id: 28, name: 'Light Pink', rgb: { r: 243, g: 141, b: 169 } },
      29: { id: 29, name: 'Dark Brown', rgb: { r: 104, g: 70, b: 52 } },
      30: { id: 30, name: 'Brown', rgb: { r: 149, g: 104, b: 42 } },
      31: { id: 31, name: 'Beige', rgb: { r: 248, g: 178, b: 119 } },
      32: { id: 32, name: 'Light Beige', rgb: { r: 255, g: 197, b: 165 } },
      33: { id: 33, name: 'Medium Gray', rgb: { r: 170, g: 170, b: 170 } },
      34: { id: 34, name: 'Dark Red', rgb: { r: 165, g: 14, b: 30 } },
      35: { id: 35, name: 'Light Red', rgb: { r: 250, g: 128, b: 114 } },
      36: { id: 36, name: 'Dark Orange', rgb: { r: 228, g: 92, b: 26 } },
      37: { id: 37, name: 'Dark Goldenrod', rgb: { r: 156, g: 132, b: 49 } },
      38: { id: 38, name: 'Goldenrod', rgb: { r: 197, g: 173, b: 49 } },
      39: { id: 39, name: 'Light Goldenrod', rgb: { r: 232, g: 212, b: 95 } },
      40: { id: 40, name: 'Dark Olive', rgb: { r: 74, g: 107, b: 58 } },
      41: { id: 41, name: 'Olive', rgb: { r: 90, g: 148, b: 74 } },
      42: { id: 42, name: 'Light Olive', rgb: { r: 132, g: 197, b: 115 } },
      43: { id: 43, name: 'Dark Cyan', rgb: { r: 15, g: 121, b: 159 } },
      44: { id: 44, name: 'Light Blue', rgb: { r: 125, g: 199, b: 255 } },
      45: { id: 45, name: 'Dark Indigo', rgb: { r: 77, g: 49, b: 184 } },
      46: { id: 46, name: 'Dark Slate Blue', rgb: { r: 74, g: 66, b: 132 } },
      47: { id: 47, name: 'Slate Blue', rgb: { r: 122, g: 113, b: 196 } },
      48: { id: 48, name: 'Light Slate Blue', rgb: { r: 181, g: 174, b: 241 } },
      49: { id: 49, name: 'Dark Peach', rgb: { r: 155, g: 82, b: 73 } },
      50: { id: 50, name: 'Peach', rgb: { r: 209, g: 128, b: 120 } },
      51: { id: 51, name: 'Light Peach', rgb: { r: 250, g: 182, b: 164 } },
      52: { id: 52, name: 'Light Brown', rgb: { r: 219, g: 164, b: 99 } },
      53: { id: 53, name: 'Dark Tan', rgb: { r: 123, g: 99, b: 82 } },
      54: { id: 54, name: 'Tan', rgb: { r: 156, g: 132, b: 107 } },
      55: { id: 55, name: 'Light Tan', rgb: { r: 214, g: 181, b: 148 } },
      56: { id: 56, name: 'Dark Beige', rgb: { r: 209, g: 128, b: 81 } },
      57: { id: 57, name: 'Dark Stone', rgb: { r: 109, g: 100, b: 63 } },
      58: { id: 58, name: 'Stone', rgb: { r: 148, g: 140, b: 107 } },
      59: { id: 59, name: 'Light Stone', rgb: { r: 205, g: 197, b: 158 } },
      60: { id: 60, name: 'Dark Slate', rgb: { r: 51, g: 57, b: 65 } },
      61: { id: 61, name: 'Slate', rgb: { r: 109, g: 117, b: 141 } },
      62: { id: 62, name: 'Light Slate', rgb: { r: 179, g: 185, b: 209 } },
      63: { id: 63, name: 'Transparent', rgb: null }
    };

    // Obtener lista de colores disponibles del slave (solo IDs)
    let availableColorIds = [];
    if (this.dashboard.previewManager && 
        this.dashboard.previewManager.lastPreviewData &&
        Array.isArray(this.dashboard.previewManager.lastPreviewData.availableColors)) {
      // Extraer solo los IDs de los colores disponibles
      availableColorIds = this.dashboard.previewManager.lastPreviewData.availableColors.map(color => {
        return typeof color === 'object' ? (color.id !== undefined ? color.id : color) : color;
      });
    }

    // Si no hay datos del servidor, mostrar todos los colores disponibles
    if (availableColorIds.length === 0) {
      availableColorIds = Object.keys(COLOR_MAP).slice(0, 32).map(k => parseInt(k));
    }

    // Combinar IDs disponibles con información completa de colores
    return availableColorIds
      .filter(id => COLOR_MAP[id] !== undefined)
      .map(id => COLOR_MAP[id]);
  }

  /**
   * Renderiza la paleta de colores para un tipo específico
   */
  renderColorPalette(type, availableColors) {
    const containerId = `gc-available-colors-${type}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!Array.isArray(availableColors) || availableColors.length === 0) {
      container.innerHTML = `
        <div class="text-xs text-muted-foreground text-center py-4">
          No hay colores disponibles. Conecta un slave favorito con datos de colores.
        </div>
      `;
      return;
    }

    const selectedSet = type === 'preferred' ? this._preferredColorIds : this._excludedColorIds;
    
    container.innerHTML = availableColors.map(color => {
      const colorId = color.id !== undefined ? color.id : color;
      const isSelected = selectedSet.has(colorId);
      const colorHex = this.getColorHex(color);
      const colorName = color.name || `Color ${colorId}`;
      
      return `
        <div class="color-chip ${isSelected ? 'selected' : ''}" 
             data-id="${colorId}"
             data-type="${type}"
             style="background-color: ${colorHex};"
             onclick="dashboard.configManager.toggleColorSelection('${type}', ${colorId})"
             title="${colorName} (ID: ${colorId})">
             ${isSelected ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" style="position: absolute; z-index: 10; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5));"><polyline points="20,6 9,17 4,12"></polyline></svg>' : ''}
        </div>
      `;
    }).join('');
  }

  /**
   * Obtiene el código hex de un color
   */
  getColorHex(color) {
    // Si tiene RGB directo
    if (typeof color === 'object' && color.rgb) {
      const { r, g, b } = color.rgb;
      return `rgb(${r}, ${g}, ${b})`;
    }
    // Si tiene hex
    if (typeof color === 'object' && color.hex) {
      return color.hex.startsWith('#') ? color.hex : `#${color.hex}`;
    }
    // Si es solo un número, generar color basado en ID
    if (typeof color === 'number') {
      const hue = (color * 137.508) % 360;
      return `hsl(${hue}, 70%, 50%)`;
    }
    return '#888888'; // Color por defecto
  }

  /**
   * Actualiza la visibilidad de los botones "Limpiar"
   */
  updateClearButtonsVisibility() {
    const clearPreferredBtn = document.getElementById('gc-clearPreferred');
    const clearExcludedBtn = document.getElementById('gc-clearExcluded');
    
    if (clearPreferredBtn) {
      clearPreferredBtn.style.display = this._preferredColorIds.size > 0 ? '' : 'none';
    }
    if (clearExcludedBtn) {
      clearExcludedBtn.style.display = this._excludedColorIds.size > 0 ? '' : 'none';
    }
  }

  /**
   * Alterna la selección de un color
   */
  toggleColorSelection(type, colorId) {
    const selectedSet = type === 'preferred' ? this._preferredColorIds : this._excludedColorIds;
    const numericId = parseInt(colorId, 10);
    
    if (selectedSet.has(numericId)) {
      selectedSet.delete(numericId);
    } else {
      selectedSet.add(numericId);
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