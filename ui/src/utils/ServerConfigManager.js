/**
 * ServerConfigManager - Gestiona la configuración persistente del servidor WebSocket
 * Maneja el almacenamiento local de configuraciones de conexión
 */

class ServerConfigManager {
    constructor() {
        this.storageKey = 'wplace_server_config';
        this.defaultConfig = {
            serverUrl: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:8008`, // Servidor local por defecto
            autoConnect: true,
            reconnectAttempts: 5,
            reconnectDelay: 3000
        };
    }

    /**
     * Obtiene la configuración completa
     * @returns {Object} Configuración actual
     */
    getConfig() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (stored) {
                const config = JSON.parse(stored);
                // Merge con configuración por defecto para nuevas propiedades
                return { ...this.defaultConfig, ...config };
            }
        } catch (error) {
            console.warn('Error loading server config from localStorage:', error);
        }
        return { ...this.defaultConfig };
    }

    /**
     * Guarda la configuración completa
     * @param {Object} config - Nueva configuración
     */
    setConfig(config) {
        try {
            const mergedConfig = { ...this.getConfig(), ...config };
            localStorage.setItem(this.storageKey, JSON.stringify(mergedConfig));
            this.notifyConfigChange(mergedConfig);
        } catch (error) {
            console.error('Error saving server config to localStorage:', error);
        }
    }

    /**
     * Obtiene la URL del servidor WebSocket
     * @returns {string} URL del servidor
     */
    getServerUrl() {
        return this.getConfig().serverUrl;
    }

    /**
     * Establece la URL del servidor WebSocket
     * @param {string} url - Nueva URL del servidor
     */
    setServerUrl(url) {
        // Normalizar URL
        const normalizedUrl = this.normalizeServerUrl(url);
        this.setConfig({ serverUrl: normalizedUrl });
    }

    /**
     * Normaliza la URL del servidor para asegurar formato correcto
     * @param {string} url - URL a normalizar
     * @returns {string} URL normalizada
     */
    normalizeServerUrl(url) {
        if (!url || url.trim() === '') {
            return this.defaultConfig.serverUrl;
        }

        url = url.trim();

        // Si ya tiene protocolo WS/S, simplemente devolver
        if (url.startsWith('ws://') || url.startsWith('wss://')) {
            return url;
        }

        // Si tiene protocolo HTTP, convertir a WebSocket
        if (url.startsWith('http://')) {
            return url.replace('http://', 'ws://');
        }
        if (url.startsWith('https://')) {
            return url.replace('https://', 'wss://');
        }

        // Si no tiene protocolo, asumir ws:// para local y wss:// para remotos
        if (url.includes('localhost') || url.startsWith('127.0.0.1') || url.startsWith('192.168.')) {
            return `ws://${url}`;
        } else {
            return `wss://${url}`;
        }
    }

    /**
     * Obtiene configuraciones predefinidas comunes
     * @returns {Array} Lista de configuraciones predefinidas
     */
    getPresetConfigs() {
        return [
            {
                name: 'Servidor Local',
                url: 'ws://localhost:8008',
                description: 'Servidor de desarrollo local'
            },
            {
                name: 'Servidor de Pruebas',
                url: 'wss://testbotnet.alarisco.xyz',
                description: 'Servidor de pruebas remoto'
            },
            {
                name: 'Personalizado',
                url: '',
                description: 'Configuración personalizada'
            }
        ];
    }

    /**
     * Valida si una URL de servidor es válida
     * @param {string} url - URL a validar
     * @returns {Object} Resultado de validación
     */
    validateServerUrl(url) {
        if (!url || url.trim() === '') {
            return false;
        }

        try {
            const normalized = this.normalizeServerUrl(url);
            new URL(normalized);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Notifica cambios de configuración a los listeners
     * @param {Object} config - Nueva configuración
     */
    notifyConfigChange(config) {
        // Disparar evento personalizado para que otros componentes puedan reaccionar
        window.dispatchEvent(new CustomEvent('serverConfigChanged', {
            detail: { config }
        }));
    }

    /**
     * Resetea la configuración a valores por defecto
     */
    resetConfig() {
        try {
            localStorage.removeItem(this.storageKey);
            this.notifyConfigChange(this.defaultConfig);
        } catch (error) {
            console.error('Error resetting server config:', error);
        }
    }
}

// Exportar instancia singleton
const serverConfigManager = new ServerConfigManager();
export default serverConfigManager;