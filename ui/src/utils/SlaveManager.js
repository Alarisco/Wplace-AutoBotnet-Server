/**
 * Gestor de Slaves para el WPlace Master Dashboard
 * 
 * Este módulo maneja toda la lógica relacionada con los slaves conectados:
 * - Gestión del estado de slaves (conectados, desconectados, favoritos)
 * - Renderizado de la lista de slaves en la UI
 * - Manejo de selección y toggles de slaves
 * - Actualización de telemetría y estado de slaves
 * - Gestión de slaves favoritos
 */

export class SlaveManager {
  constructor(dashboard) {
    this.dashboard = dashboard;
    this.slaves = new Map();
    this._selectedSlavesLocal = new Set();
    this._selectedSlavesServer = new Set();
    this._flashTimers = new Map();
    
    // Cargar estado persistido desde localStorage
    this.loadPersistedSlaveSelection();
  }

  /**
   * Carga la selección de slaves desde localStorage
   */
  loadPersistedSlaveSelection() {
    try {
      const stored = localStorage.getItem('selectedSlaves');
      if (stored) {
        const slaveIds = JSON.parse(stored);
        if (Array.isArray(slaveIds)) {
          this._selectedSlavesLocal = new Set(slaveIds);
        }
      }
    } catch (error) {
      console.warn('Error loading persisted slave selection:', error);
      this._selectedSlavesLocal = new Set();
    }
  }

  /**
   * Actualiza la lista completa de slaves
   */
  updateSlavesList(slaves) {
    this.slaves.clear();
    slaves.forEach(slave => {
      this.slaves.set(slave.id, slave);
    });
    this.displaySlaves();
  }

  /**
   * Renderiza la lista de slaves en la UI
   */
  displaySlaves() {
    const container = document.getElementById('slaves-list');
    if (!container) return;

    if (this.slaves.size === 0) {
      container.innerHTML = `<div class="text-sm text-muted-foreground text-center py-8">No slaves connected. Inject Auto-Slave.js in your browser.</div>`;
      return;
    }

    const preselected = (id) => {
      if (this._selectedSlavesLocal && this._selectedSlavesLocal.size > 0) return this._selectedSlavesLocal.has(id);
      if (this._selectedSlavesServer && this._selectedSlavesServer.size > 0) return this._selectedSlavesServer.has(id);
      return false;
    };

    const allSlaves = Array.from(this.slaves.values());

    container.innerHTML = allSlaves.map(slave => `
      <div id="slave-${slave.id}" class="flex items-center justify-between p-3 border rounded-md">
        <div class="flex-1">
          <div class="flex items-center gap-2">
            <span class="font-medium">${slave.id}</span>
            <button class="fav-btn" data-id="${slave.id}" title="Marcar como favorito">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="${slave.is_favorite ? '#f59e0b' : 'none'}" stroke="${slave.is_favorite ? '#f59e0b' : 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="12 2 15 8.5 22 9 17 14 18.5 21 12 17.5 5.5 21 7 14 2 9 9 8.5 12 2" />
              </svg>
            </button>
          </div>
          <div class="text-xs text-muted-foreground">${slave.status || ''}</div>
          <div class="text-xs text-muted-foreground">Charges: <span id="slave-${slave.id}-charges">${this._formatCharges(slave)}</span></div>
          <div class="text-[11px] text-muted-foreground mt-1">
            <span id="slave-${slave.id}-quota-label">Next batch:</span> 
            <span id="slave-${slave.id}-quota" class="font-medium">--</span>
          </div>
          <div class="w-40 h-1.5 bg-muted rounded mt-1">
            <div id="slave-${slave.id}-quota-bar" class="h-1.5 bg-blue-500 rounded transition-all" style="width:0%"></div>
          </div>
          <div class="text-[10px] mt-0.5" id="slave-${slave.id}-status" style="opacity: 0.6;"></div>
        </div>
        <div class="flex items-center">
          <label class="relative inline-flex w-9 h-5 items-center cursor-pointer select-none">
            <input type="checkbox" class="slave-toggle opacity-0 absolute w-0 h-0" id="slave-toggle-${slave.id}" value="${slave.id}" ${preselected(slave.id) ? 'checked' : ''}>
            <span data-role="track" class="absolute inset-0 rounded-full transition-colors duration-300 ${preselected(slave.id) ? 'bg-green-500' : 'bg-red-500'}"></span>
            <span data-role="knob" class="absolute left-0.5 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full transition-transform duration-300 ${preselected(slave.id) ? 'translate-x-4' : 'translate-x-0'}"></span>
          </label>
        </div>
      </div>
    `).join('');

    // Si hay un favorito, resaltarlo
    const fav = allSlaves.find(s => s.is_favorite);
    if (fav) {
      const card = document.getElementById(`slave-${fav.id}`);
      if (card) card.classList.add('ring-1','ring-amber-400');
    }

    this._setupSlaveEventListeners(container);
    
    // Mantener botones y estado de controles consistentes
    try {
      this.dashboard.updateControlButtons();
      this.dashboard.recomputeRoundPlan();
      this.dashboard.updateConfigPanelEnabledState();
    } catch {}

    // Aplicar selección del servidor si existe
    if (this._selectedSlavesServer && this._selectedSlavesServer.size > 0) {
      this.applyServerSelection();
    }
  }

  /**
   * Configura los event listeners para los slaves
   */
  _setupSlaveEventListeners(container) {
    // Listeners para estrella de favorito
    container.querySelectorAll('.fav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget;
        const id = target.getAttribute('data-id');
        if (id) this.setFavoriteSlave(id);
      });
    });

    const persistSelection = () => {
      try {
        const selected = Array.from(container.querySelectorAll('.slave-toggle'))
          .filter(cb => cb.checked).map(cb => cb.value);
        localStorage.setItem('selectedSlaves', JSON.stringify(selected));
        fetch(`${this.dashboard.apiBase()}/api/ui/selected-slaves`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slave_ids: selected })
        }).catch(() => {});
      } catch {}
    };

    container.querySelectorAll('.slave-toggle').forEach((input) => {
      // Sincronizar estilos visuales
      this.dashboard.updateToggleState(input.id, input.checked);
      input.addEventListener('change', () => {
        this.dashboard.updateToggleState(input.id, input.checked);
        this.dashboard.updateControlButtons();
        this.dashboard.recomputeRoundPlan();
        persistSelection();
        
        // Sincronizar toggle maestro
        const allToggles = Array.from(container.querySelectorAll('.slave-toggle'));
        const allOn = allToggles.length > 0 && allToggles.every(t => t.checked);
        const master = document.getElementById('toggle-all-slaves');
        if (master) {
          master.checked = allOn;
          this.dashboard.updateToggleState('toggle-all-slaves', allOn);
        }
      });
    });

    // Configurar toggle maestro
    this._setupMasterToggle(container);
  }

  /**
   * Configura el toggle maestro para seleccionar/deseleccionar todos los slaves
   */
  _setupMasterToggle(container) {
    const master = document.getElementById('toggle-all-slaves');
    if (master) {
      const allToggles = Array.from(container.querySelectorAll('.slave-toggle'));
      const allOn = allToggles.length > 0 && allToggles.every(t => t.checked);
      master.checked = allOn;
      this.dashboard.updateToggleState('toggle-all-slaves', allOn);
      
      const masterWrapper = master.parentElement;
      if (masterWrapper && !masterWrapper.getAttribute('data-wired')) {
        masterWrapper.setAttribute('data-wired', '1');
        master.addEventListener('change', () => {
          const desired = master.checked;
          allToggles.forEach(t => {
            t.checked = desired;
            this.dashboard.updateToggleState(t.id, desired);
          });
          this.dashboard.updateToggleState('toggle-all-slaves', desired);
          this.dashboard.updateControlButtons();
          this.dashboard.recomputeRoundPlan();
          
          try {
            const selected = desired ? allToggles.map(t => t.value) : [];
            localStorage.setItem('selectedSlaves', JSON.stringify(selected));
            fetch(`${this.dashboard.apiBase()}/api/ui/selected-slaves`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slave_ids: selected })
            }).catch(() => {});
          } catch {}
        });
      }
    }
  }

  /**
   * Formatea la información de cargas de un slave
   */
  _formatCharges(slave) {
    const rc = slave?.telemetry?.remaining_charges;
    const mc = slave?.telemetry?.max_charges;
    if (typeof rc === 'number') {
      return (typeof mc === 'number' && mc > 0) ? `${rc}/${mc}` : `${rc}`;
    }
    return '...';
  }

  /**
   * Establece un slave como favorito
   */
  async setFavoriteSlave(slaveId) {
    try {
      await fetch(`${this.dashboard.apiBase()}/api/slaves/${encodeURIComponent(slaveId)}/favorite`, { 
        method: 'POST' 
      });
      this.dashboard.log(`⭐ ${slaveId} marcado como favorito`);
      await this.refreshSlaves();
    } catch (e) {
      this.dashboard.log(`Error marcando favorito: ${e}`);
    }
  }

  /**
   * Actualiza la telemetría de un slave específico
   */
  updateTelemetry(slaveId, telemetry) {
    if (this.slaves.has(slaveId)) {
      this.slaves.get(slaveId).telemetry = telemetry;
    }

    // Actualizar métricas agregadas
    this._updateAggregatedMetrics();
    this.updateSlaveCardCharges(slaveId);
    
    try { 
      this.dashboard.recomputeRoundPlan(); 
    } catch {}
  }

  /**
   * Actualiza las métricas agregadas de todos los slaves
   */
  _updateAggregatedMetrics() {
    let totalRepaired = 0, totalMissing = 0, totalAbsent = 0, totalCharges = 0;
    let guardCorrect = 0, guardIncorrect = 0, guardMissing = 0;

    // Calcular también capacidad máxima total
    let totalMaxCharges = 0;
    
    this.slaves.forEach(slave => {
      if (!slave.telemetry) return;
      totalRepaired += slave.telemetry.repaired_pixels || 0;
      totalMissing += slave.telemetry.missing_pixels || 0;
      totalAbsent += slave.telemetry.absent_pixels || 0;
      totalCharges += slave.telemetry.remaining_charges || 0;
      totalMaxCharges += slave.telemetry.max_charges || 50; // Default 50 si no está disponible
      
      // Métricas Guard si disponibles (del favorito)
      guardCorrect += slave.telemetry.correctPixels || 0;
      guardIncorrect += slave.telemetry.incorrectPixels || 0;
      guardMissing += slave.telemetry.missingPixels || 0;
      
      // Si preview_data trae análisis más reciente, sobreescribir acumulados
      if (slave.telemetry.preview_data && slave.telemetry.preview_data.analysis) {
        const a = slave.telemetry.preview_data.analysis;
        const c = a.correctPixels ?? a.correct;
        const i = a.incorrectPixels ?? a.incorrect;
        const m = a.missingPixels ?? a.missing;
        if (typeof c === 'number' && typeof i === 'number' && typeof m === 'number') {
          guardCorrect = c;
          guardIncorrect = i;
          guardMissing = m;
        }
      }
    });

    // Actualizar panel de telemetría
    const rp = document.getElementById('repaired-pixels');
    const inc = document.getElementById('incorrect-pixels');
    const miss = document.getElementById('missing-pixels');
    const rc = document.getElementById('remaining-charges');
    
    if (rp) rp.textContent = String(guardCorrect);
    if (inc) inc.textContent = String(guardIncorrect);
    if (miss) miss.textContent = String(guardMissing);
    // Formato X/Y para mostrar disponible/capacidad total
    if (rc) rc.textContent = `${totalCharges}/${totalMaxCharges}`;
  }

  /**
   * Actualiza la información de cargas de un slave específico
   */
  updateSlaveCardCharges(slaveId) {
    if (!this.slaves.has(slaveId)) return;
    
    const slave = this.slaves.get(slaveId);
    const el = document.getElementById(`slave-${slaveId}-charges`);
    if (!el) return;
    
    el.textContent = this._formatCharges(slave);
    
    // Actualizar barra de cuota si existe plan
    try {
      const val = this.dashboard.currentRoundPlan?.[slaveId] || 0;
      const cap = Math.max(1, Number(slave?.telemetry?.remaining_charges) || 0);
      this.updateSlaveCardQuota(slaveId, val, cap ? (val / cap) : 0);
    } catch {}
  }

  /**
   * Actualiza la cuota visual de un slave con información contextual
   */
  updateSlaveCardQuota(slaveId, quota, percentage) {
    const quotaEl = document.getElementById(`slave-${slaveId}-quota`);
    const labelEl = document.getElementById(`slave-${slaveId}-quota-label`);
    const barEl = document.getElementById(`slave-${slaveId}-quota-bar`);
    const statusEl = document.getElementById(`slave-${slaveId}-status`);
    
    const slave = this.slaves.get(slaveId);
    if (!slave) return;
    
    const currentCharges = slave?.telemetry?.remaining_charges || 0;
    
    // Obtener configuración real desde dashboard
    const guardConfig = this.dashboard?.configManager?.guardConfig || {};
    const pixelsPerBatch = parseInt(guardConfig.pixelsPerBatch) || 10;
    const minCharges = parseInt(guardConfig.minChargesToWait) || 20;
    const spendAll = guardConfig.spendAllPixelsOnStart === true;
    
    // Determinar si el slave es elegible para el próximo lote
    let required, isEligible;
    
    if (spendAll) {
      // En modo spend all, solo necesita tener algunas cargas
      required = Math.min(5, minCharges);
      isEligible = currentCharges >= required;
    } else {
      // Modo normal: necesita minCharges + pixelsPerBatch
      required = minCharges + pixelsPerBatch;
      isEligible = currentCharges >= required;
    }
    
    if (quotaEl) {
      if (quota > 0) {
        // Tiene trabajo asignado
        quotaEl.textContent = `${quota} px`;
        quotaEl.style.color = '#10b981'; // verde
      } else if (isEligible) {
        // Elegible pero sin trabajo asignado
        const spendable = Math.max(0, currentCharges - minCharges);
        const canPaint = Math.min(spendable, pixelsPerBatch);
        quotaEl.textContent = canPaint > 0 ? `${canPaint} px` : 'Ready';
        quotaEl.style.color = canPaint > 0 ? '#10b981' : '#3b82f6';
      } else {
        // No elegible - esperando cargas
        quotaEl.textContent = 'Waiting';
        quotaEl.style.color = '#f59e0b';
      }
    }
    
    if (labelEl) {
      if (quota > 0) {
        labelEl.textContent = 'Assigned:';
      } else if (isEligible) {
        labelEl.textContent = 'Capacity:';
      } else {
        labelEl.textContent = 'Status:';
      }
    }
    
    if (barEl) {
      const width = Math.min(100, Math.max(0, percentage * 100));
      barEl.style.width = `${width}%`;
      
      // Color de la barra según estado
      if (quota > 0) {
        barEl.style.backgroundColor = '#3b82f6'; // azul - trabajando
      } else if (isEligible) {
        barEl.style.backgroundColor = '#10b981'; // verde - listo
      } else {
        barEl.style.backgroundColor = '#f59e0b'; // naranja - esperando
      }
    }
    
    if (statusEl) {
      if (quota > 0) {
        statusEl.textContent = `${Math.round(percentage * 100)}% of available`;
        statusEl.style.color = '#3b82f6';
      } else if (!isEligible) {
        const needed = Math.ceil(required - currentCharges);
        if (spendAll) {
          statusEl.textContent = `Need ${needed}+ charges (safety min: ${required})`;
        } else {
          statusEl.textContent = `⏳ Need ${required} total (has ${currentCharges})`;
        }
        statusEl.style.color = '#f59e0b';
      } else {
        // Elegible pero sin trabajo asignado aún
        const spendable = Math.max(0, currentCharges - minCharges);
        const canPaint = Math.min(spendable, pixelsPerBatch);
        statusEl.textContent = `Can paint ${canPaint} px`;
        statusEl.style.color = '#10b981';
      }
    }
  }

  /**
   * Actualiza el estado de un slave
   */
  updateSlaveStatus(slaveId, status) {
    if (this.slaves.has(slaveId)) {
      this.slaves.get(slaveId).status = status;
      this.displaySlaves();
    }
  }

  /**
   * Aplica la selección de slaves desde el servidor
   */
  applyServerSelection() {
    if (!this._selectedSlavesServer || !(this._selectedSlavesServer instanceof Set)) return;
    
    const checkboxes = document.querySelectorAll('.slave-toggle');
    checkboxes.forEach(cb => {
      const should = this._selectedSlavesServer.has(cb.value);
      cb.checked = should;
      this.dashboard.updateToggleState(cb.id, should);
    });
    
    // Actualizar master toggle
    const all = Array.from(checkboxes);
    const master = document.getElementById('toggle-all-slaves');
    if (master) {
      const allOn = all.length > 0 && all.every(c => c.checked);
      master.checked = allOn;
      this.dashboard.updateToggleState('toggle-all-slaves', allOn);
    }
    
    this.dashboard.updateControlButtons();
    this.dashboard.recomputeRoundPlan();
  }

  /**
   * Resalta visualmente una tarjeta de slave
   */
  highlightSlaveCard(slaveId, success) {
    try {
      const card = document.getElementById(`slave-${slaveId}`);
      if (!card) return;
      
      // Limpiar animación anterior si existe
      if (this._flashTimers.has(slaveId)) {
        clearTimeout(this._flashTimers.get(slaveId));
        card.classList.remove('flash-green', 'flash-red');
      }
      
      // Aplicar nueva animación
      const flashClass = success ? 'flash-green' : 'flash-red';
      card.classList.add(flashClass);
      
      // Limpiar después de la animación
      const timer = setTimeout(() => {
        card.classList.remove(flashClass);
        this._flashTimers.delete(slaveId);
      }, 1200);
      
      this._flashTimers.set(slaveId, timer);
    } catch (error) {
      console.error('Error highlighting slave card:', error);
    }
  }

  /**
   * Refresca la lista de slaves desde el servidor
   */
  async refreshSlaves(retries = 3) {
    try {
      const response = await fetch(`${this.dashboard.apiBase()}/api/slaves`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();
      this.updateSlavesList(data.slaves || []);
    } catch (error) {
      this.dashboard.log(`Error fetching slaves: ${error}`);
      if (retries > 0) {
        setTimeout(() => {
          this.refreshSlaves(retries - 1);
        }, 500);
      }
    }
  }

  /**
   * Obtiene el ID del slave favorito
   */
  getFavoriteSlaveId() {
    for (const [id, slave] of this.slaves) {
      if (slave.is_favorite) return id;
    }
    return null;
  }

  /**
   * Obtiene la lista de slaves seleccionados
   */
  getSelectedSlaves() {
    return Array.from(document.querySelectorAll('.slave-toggle:checked')).map(cb => cb.value);
  }

  /**
   * Verifica si hay slaves conectados
   */
  hasConnectedSlaves() {
    return this.slaves.size > 0;
  }
}