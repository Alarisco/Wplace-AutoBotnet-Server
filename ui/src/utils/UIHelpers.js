/**
 * Utilidades de Interfaz para el WPlace Master Dashboard
 * 
 * Este módulo contiene funciones de utilidad para la interfaz de usuario:
 * - Creación de toggles y componentes UI
 * - Gestión de logs y mensajes
 * - Funciones de formateo y visualización
 * - Utilidades de progreso y barras de estado
 * - Helpers para animaciones y efectos visuales
 */

export class UIHelpers {
  constructor(dashboard) {
    this.dashboard = dashboard;
    this.recentLogKeys = new Map();
  }

  /**
   * Crea un toggle CSS personalizado estilo iOS
   */
  createToggle(id, labelText, checked = false) {
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; padding: 8px 0;">
        <span style="color: #eee; font-size: 14px; flex: 1;">${labelText}</span>
        <label class="toggle-switch" style="position: relative; display: inline-block; width: 50px; height: 26px; margin-left: 10px;">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} style="opacity: 0; width: 0; height: 0;">
          <span class="toggle-slider" style="
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: ${checked ? '#22c55e' : '#ef4444'};
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            border-radius: 13px;
            border: 1px solid ${checked ? '#16a34a' : '#dc2626'};
          "></span>
          <span class="toggle-knob" style="
            position: absolute;
            height: 20px;
            width: 20px;
            left: ${checked ? '27px' : '3px'};
            top: 3px;
            background-color: white;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            border-radius: 50%;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
          "></span>
        </label>
      </div>
    `;
  }

  /**
   * Crea un toggle compacto con estilos Tailwind
   */
  createCompactToggle(id, labelText, checked = false) {
    return `
      <div class="flex items-center justify-between py-1">
        <span class="text-xs text-gray-300">${labelText}</span>
        <label class="relative inline-flex w-9 h-5 items-center cursor-pointer select-none">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} class="opacity-0 absolute w-0 h-0">
          <span data-role="track" class="absolute inset-0 rounded-full transition-colors duration-300 ${checked ? 'bg-green-500' : 'bg-red-500'}"></span>
          <span data-role="knob" class="absolute left-0.5 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full transition-transform duration-300 ${checked ? 'translate-x-4' : 'translate-x-0'}"></span>
        </label>
      </div>
    `;
  }

  /**
   * Actualiza el estado visual de un toggle
   */
  updateToggleState(toggleId, checked) {
    const toggle = document.getElementById(toggleId);
    if (!toggle) return;

    // Buscar el wrapper del toggle
    const wrapper = toggle.parentElement;
    if (!wrapper) return;

    // 1) Preferir versión compacta con data-role
    const compactSlider = wrapper?.querySelector('[data-role="track"]');
    const compactKnob = wrapper?.querySelector('[data-role="knob"]');
    if (compactSlider && compactKnob) {
      compactSlider.className = `absolute inset-0 z-0 rounded-full transition-colors duration-300 ${checked ? 'bg-green-500' : 'bg-red-500'}`;
      compactKnob.className = `absolute z-10 left-0.5 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full transition-transform duration-300 ${checked ? 'translate-x-4' : 'translate-x-0'}`;
      return;
    }

    // 2) Fallback para toggles genéricos (estructura span:first-child/span:last-child)
    const track = wrapper.querySelector('span:first-child');
    const knobElement = wrapper.querySelector('span:last-child');
    if (track && knobElement && !track.hasAttribute('data-role') && !knobElement.hasAttribute('data-role')) {
      track.className = `relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-muted'}`;
      knobElement.className = `inline-block h-4 w-4 rounded-full bg-background shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`;
      return;
    }

    // 3) Último recurso: estilo antiguo inline
    const slider = wrapper?.querySelector('.toggle-slider');
    const knobFallback = wrapper?.querySelector('.toggle-knob');
    if (slider && knobFallback) {
      slider.style.backgroundColor = checked ? '#22c55e' : '#ef4444';
      slider.style.borderColor = checked ? '#16a34a' : '#dc2626';
      knobFallback.style.left = checked ? '27px' : '3px';
    }
  }

  /**
   * Registra un mensaje en el log con timestamp
   */
  log(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    
    // Agregar al contenedor de logs si existe
    const logsContainer = document.getElementById('logs-container');
    if (logsContainer) {
      const logEntry = document.createElement('div');
      logEntry.className = 'text-xs mb-1';
      logEntry.textContent = logMessage;
      logsContainer.appendChild(logEntry);
      
      // Mantener solo los últimos 100 logs
      while (logsContainer.children.length > 100) {
        logsContainer.removeChild(logsContainer.firstChild);
      }
      
      // Scroll automático al final
      logsContainer.scrollTop = logsContainer.scrollHeight;
    }
  }

  /**
   * Registra un mensaje una sola vez dentro de un período de tiempo (deduplicación)
   */
  logOnce(key, message, ttlMs = 5000) {
    const now = Date.now();
    const lastLogged = this.recentLogKeys.get(key);
    
    if (!lastLogged || (now - lastLogged) > ttlMs) {
      this.recentLogKeys.set(key, now);
      this.log(message);
      
      // Limpiar entradas expiradas
      for (const [k, timestamp] of this.recentLogKeys.entries()) {
        if ((now - timestamp) > ttlMs) {
          this.recentLogKeys.delete(k);
        }
      }
    }
  }

  /**
   * Actualiza la barra de progreso general
   */
  updateOverallProgressBar(percentage) {
    const progressBar = document.getElementById('overall-progress-bar');
    const progressLabel = document.getElementById('overall-progress-label');
    
    if (progressBar) {
      progressBar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
    }
    
    if (progressLabel) {
      progressLabel.textContent = `${Math.round(percentage)}%`;
    }
  }

  /**
   * Muestra un toast de notificación
   */
  showToast(message, type = 'info', duration = 3000) {
    // Crear elemento toast
    const toast = document.createElement('div');
    toast.className = `fixed top-4 right-4 px-4 py-2 rounded-md shadow-lg z-50 transition-all duration-300 ${this.getToastClasses(type)}`;
    toast.textContent = message;
    
    // Agregar al DOM
    document.body.appendChild(toast);
    
    // Animación de entrada
    setTimeout(() => {
      toast.style.transform = 'translateX(0)';
      toast.style.opacity = '1';
    }, 10);
    
    // Remover después del tiempo especificado
    setTimeout(() => {
      toast.style.transform = 'translateX(100%)';
      toast.style.opacity = '0';
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, duration);
  }

  /**
   * Obtiene las clases CSS para diferentes tipos de toast
   */
  getToastClasses(type) {
    switch (type) {
      case 'success':
        return 'bg-green-500 text-white';
      case 'error':
        return 'bg-red-500 text-white';
      case 'warning':
        return 'bg-yellow-500 text-black';
      default:
        return 'bg-blue-500 text-white';
    }
  }

  /**
   * Formatea un número con separadores de miles
   */
  formatNumber(num) {
    return new Intl.NumberFormat().format(num);
  }

  /**
   * Formatea un timestamp a formato legible
   */
  formatTimestamp(timestamp) {
    return new Date(timestamp).toLocaleString();
  }

  /**
   * Calcula el tiempo transcurrido desde un timestamp
   */
  timeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    if (diff < 60000) { // menos de 1 minuto
      return 'hace unos segundos';
    } else if (diff < 3600000) { // menos de 1 hora
      const minutes = Math.floor(diff / 60000);
      return `hace ${minutes} minuto${minutes > 1 ? 's' : ''}`;
    } else if (diff < 86400000) { // menos de 1 día
      const hours = Math.floor(diff / 3600000);
      return `hace ${hours} hora${hours > 1 ? 's' : ''}`;
    } else {
      const days = Math.floor(diff / 86400000);
      return `hace ${days} día${days > 1 ? 's' : ''}`;
    }
  }

  /**
   * Trunca un texto a una longitud específica
   */
  truncateText(text, maxLength = 50) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  }

  /**
   * Convierte un color RGB a hexadecimal
   */
  rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /**
   * Convierte un color hexadecimal a RGB
   */
  hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  /**
   * Genera un ID único
   */
  generateId() {
    return Math.random().toString(36).substr(2, 9);
  }

  /**
   * Debounce para funciones que se ejecutan frecuentemente
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * Throttle para funciones que se ejecutan frecuentemente
   */
  throttle(func, limit) {
    let inThrottle;
    return function() {
      const args = arguments;
      const context = this;
      if (!inThrottle) {
        func.apply(context, args);
        inThrottle = true;
        setTimeout(() => inThrottle = false, limit);
      }
    };
  }

  /**
   * Copia texto al portapapeles
   */
  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Copiado al portapapeles', 'success');
    } catch (err) {
      console.error('Error copying to clipboard:', err);
      this.showToast('Error al copiar', 'error');
    }
  }

  /**
   * Descarga un archivo con contenido específico
   */
  downloadFile(content, filename, contentType = 'application/json') {
    const blob = new Blob([content], { type: contentType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Valida si un elemento está visible en el viewport
   */
  isElementInViewport(element) {
    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }

  /**
   * Hace scroll suave a un elemento
   */
  scrollToElement(element, behavior = 'smooth') {
    element.scrollIntoView({ behavior, block: 'center' });
  }

  /**
   * Obtiene las dimensiones de un elemento
   */
  getElementDimensions(element) {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom
    };
  }

  /**
   * Añade una clase CSS con animación
   */
  addClassWithAnimation(element, className, duration = 300) {
    element.classList.add(className);
    setTimeout(() => {
      element.classList.remove(className);
    }, duration);
  }

  /**
   * Formatea bytes a formato legible
   */
  formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  /**
   * Obtiene información del dispositivo
   */
  getDeviceInfo() {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      cookieEnabled: navigator.cookieEnabled,
      onLine: navigator.onLine,
      screenWidth: screen.width,
      screenHeight: screen.height,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight
    };
  }
}