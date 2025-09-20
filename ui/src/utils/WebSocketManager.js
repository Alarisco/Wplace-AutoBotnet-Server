/**
 * Gestor de conexiones WebSocket para el WPlace Master Dashboard
 * 
 * Este módulo maneja toda la lógica de conexión WebSocket, incluyendo:
 * - Establecimiento y mantenimiento de conexiones
 * - Manejo de mensajes entrantes y salientes
 * - Reconexión automática en caso de desconexión
 * - Compresión/descompresión de mensajes
 */

import serverConfigManager from './ServerConfigManager.js';

export class WebSocketManager {
  constructor(dashboard) {
    this.dashboard = dashboard;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 3000;
    
    // Escuchar cambios de configuración del servidor
    this.setupConfigListeners();
  }

  /**
   * Obtiene la URL del servidor base desde la configuración del usuario
   */
  getServerUrl() {
    const configuredUrl = serverConfigManager.getServerUrl();
    console.log(`🔧 Using configured SERVER_URL: "${configuredUrl}"`);
    return configuredUrl;
  }

  /**
   * Configura los listeners para cambios de configuración
   */
  setupConfigListeners() {
    // Escuchar cambios en la configuración del servidor
    window.addEventListener('serverConfigChanged', (e) => {
      console.log('🔧 Server config changed, reconnecting...');
      this.handleConfigChange(e.detail.config);
    });

    // Escuchar solicitudes de reconexión forzada
    window.addEventListener('forceReconnect', () => {
      console.log('🔧 Force reconnect requested');
      this.forceReconnect();
    });

    // Escuchar solicitudes de prueba de conexión
    window.addEventListener('testConnection', () => {
      console.log('🔧 Test connection requested');
      this.testConnection();
    });

    // Escuchar cambios de URL del servidor
    window.addEventListener('serverUrlChanged', (e) => {
      console.log(`🔧 Server URL changed to: ${e.detail.url}`);
      this.forceReconnect();
    });
  }

  /**
   * Maneja cambios en la configuración del servidor
   */
  handleConfigChange(config) {
    // Actualizar configuración de reconexión
    this.maxReconnectAttempts = config.reconnectAttempts || 5;
    this.reconnectDelay = config.reconnectDelay || 3000;
    
    // Si autoConnect está habilitado y no estamos conectados, reconectar
    if (config.autoConnect && !this.isConnected()) {
      this.connect();
    }
  }

  /**
   * Fuerza una reconexión inmediata
   */
  forceReconnect() {
    this.disconnect();
    this.reconnectAttempts = 0;
    setTimeout(() => {
      this.connect();
    }, 500);
  }

  /**
   * Prueba la conexión sin afectar la conexión actual
   */
  async testConnection() {
    const testUrl = this.getWebSocketUrl();
    console.log(`🔧 Testing connection to: ${testUrl}`);
    
    this.notifyConnectionState('connecting');
    
    try {
      const testWs = new WebSocket(testUrl);
      
      const testPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          testWs.close();
          reject(new Error('Connection timeout'));
        }, 5000);
        
        testWs.onopen = () => {
          clearTimeout(timeout);
          testWs.close();
          resolve(true);
        };
        
        testWs.onerror = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
      });
      
      await testPromise;
      console.log('✅ Connection test successful');
      this.notifyConnectionState('connected');
      
    } catch (error) {
      console.error('❌ Connection test failed:', error);
      this.notifyConnectionState('disconnected', error.message);
    }
  }

  /**
   * Notifica cambios en el estado de conexión
   */
  notifyConnectionState(state, error = null) {
    window.dispatchEvent(new CustomEvent('websocketStateChanged', {
      detail: { state, error }
    }));
  }

  /**
   * Normaliza la URL del servidor
   */
  normalizeServerUrl(url) {
    // Si no tiene protocolo, detectar automáticamente
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      // Detectar protocolo basado en el actual o usar https por defecto para dominios remotos
      const protocol = window.location.protocol === 'https:' ? 'https://' : 'http://';
      url = protocol + url;
    }
    
    // Si no tiene puerto y es un dominio remoto detrás de nginx, asumimos puerto estándar
    if (!url.match(/:\d+$/) && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      // Para dominios remotos sin puerto, nginx maneja la redirección automáticamente
      return url;
    }
    
    // Para localhost sin puerto específico, agregar :8008
      if ((url.includes('localhost') || url.includes('127.0.0.1')) && !url.match(/:\d+$/)) {
        url = url + ':8008';
    }
    
    return url;
  }

  /**
   * Obtiene la URL del WebSocket basada en la configuración del servidor
   */
  getWebSocketUrl() {
    const serverUrl = this.getServerUrl();
    
    // Si ya es una URL de WebSocket, solo agregar el endpoint
    if (serverUrl.startsWith('ws://') || serverUrl.startsWith('wss://')) {
      const wsUrl = `${serverUrl}/ws/ui`;
      console.log(`🔧 WebSocket URL: "${wsUrl}"`);
      return wsUrl;
    }
    
    // Si es HTTP/HTTPS, convertir a WebSocket
    const protocol = serverUrl.startsWith('https://') ? 'wss://' : 'ws://';
    const cleanUrl = serverUrl.replace(/^https?:\/\//, '');
    const wsUrl = `${protocol}${cleanUrl}/ws/ui`;
    console.log(`🔧 WebSocket URL: "${wsUrl}"`);
    return wsUrl;
  }

  /**
   * Establece la conexión WebSocket
   */
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.dashboard.log('⚠️ WebSocket already connected');
      this.notifyConnectionState('connected');
      return;
    }
    
    const wsUrl = this.getWebSocketUrl();
    this.dashboard.log(`🔌 Connecting to WebSocket: ${wsUrl}`);
    this.notifyConnectionState('connecting');
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.dashboard.log('✅ Connected to Master server via WebSocket');
      this.reconnectAttempts = 0;
      this.notifyConnectionState('connected');
      // Solicitar un refresh de preview tras conectar
      try { 
        setTimeout(() => this.dashboard.previewManager.requestPreviewRefreshThrottle(), 250); 
      } catch {}
    };
    
    this.ws.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const unwrapResult = this._maybeUnwrapCompressed(raw);
        const processMessages = (val) => {
          if (!val) return;
          const list = Array.isArray(val) ? val : [val];
          for (const m of list) {
            if (!m) continue;
            this.dashboard.logOnce(`ws:${m.type}`, `📨 Received WebSocket message: ${m.type}`, 1200);
            this.dashboard.handleWebSocketMessage(m);
          }
        };
        if (unwrapResult && typeof unwrapResult.then === 'function') {
          unwrapResult.then(processed => processMessages(processed));
        } else {
          processMessages(unwrapResult);
        }
      } catch (error) {
        this.dashboard.log(`❌ Error parsing WebSocket message: ${error.message}`);
      }
    };
    
    this.ws.onclose = (event) => {
      this.dashboard.log(`🔌 WebSocket disconnected (code: ${event.code}, reason: ${event.reason || 'Unknown'})`);
      this.notifyConnectionState('disconnected', event.reason || 'Connection closed');
      this._handleReconnect();
    };
    
    this.ws.onerror = (error) => {
      this.dashboard.log(`❌ WebSocket error: ${error}`);
      this.notifyConnectionState('disconnected', 'Connection error');
    };
  }

  /**
   * Maneja la reconexión automática
   */
  _handleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.dashboard.log(`🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay/1000} seconds...`);
      setTimeout(() => this.connect(), this.reconnectDelay);
      // Incrementar el delay para reconexiones subsecuentes
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
    } else {
      this.dashboard.log('❌ Max reconnection attempts reached. Please refresh the page.');
    }
  }

  /**
   * Descomprime mensajes si es necesario
   */
  _maybeUnwrapCompressed(obj) {
    try {
      if (!obj || typeof obj !== 'object') return obj;
      if (obj.type !== '__compressed__') return obj;
      if (!obj.encoding || obj.encoding !== 'gzip+base64') return obj;
      
      // Lazy load pako solo cuando se necesita (parcel/astro soporta dynamic import)
      const b64 = obj.payload ?? obj.data;
      if (typeof b64 !== 'string') return obj; // corrupto
      const binStr = atob(b64);
      const len = binStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
      
      // Utilizamos pako ungzip
      // Nota: import dinámico; si falla, retornamos wrapper original para no romper flujo
      return this._gunzip(bytes).then(js => {
        // Si el wrapper traía originalType, y el contenido es objeto sin type, reinyectar
        if (obj.originalType && js && typeof js === 'object' && !js.type) {
          js.type = obj.originalType;
        }
        return js;
      }).catch(err => {
        this.dashboard.log('⚠️ Decompression failed: ' + (err?.message || err));
        return obj; // fallback
      });
    } catch (e) {
      this.dashboard.log('⚠️ _maybeUnwrapCompressed error: ' + (e?.message || e));
      return obj;
    }
  }

  async _gunzip(bytes) {
    // Cargar pako desde CDN si no está disponible
    if (typeof window.pako === 'undefined') {
      await this._loadPako();
    }
    const decompressed = window.pako.ungzip(bytes, { to: 'string' });
    const parsed = JSON.parse(decompressed);
    // Para mantener compat, si viene single object lo devolvemos; si es wrapper with originalType, homogenizar
    if (parsed && typeof parsed === 'object' && parsed.type && parsed.type !== '__compressed__') return parsed;
    return parsed;
  }

  async _loadPako() {
    return new Promise((resolve, reject) => {
      if (typeof window.pako !== 'undefined') {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load pako'));
      document.head.appendChild(script);
    });
  }

  /**
   * Envía un mensaje a través del WebSocket
   */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.dashboard.log(`❌ Error sending WebSocket message: ${error.message}`);
      }
    } else {
      this.dashboard.log('⚠️ WebSocket not connected. Message not sent.');
    }
  }

  /**
   * Cierra la conexión WebSocket
   */
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Verifica si la conexión está activa
   */
  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}