# Bugfix: Preview Flicker and Data Loss

## 🐛 Problema identificado

El sistema de preview presentaba parpadeo (flickering) y pérdida de datos, manifestándose en:

1. **Preview parpadea**: El canvas mostraba intermitentemente datos correctos y después se borraba
2. **Preview se pierde**: El área de protección (`area`) desaparecía mostrando advertencia "⚠️ No area data found in preview"
3. **Datos obsoletos**: A veces se mostraban datos antiguos en lugar de los más recientes

## 🔍 Causa raíz

### Problema 1: Race condition entre dos fuentes de preview

Existían **DOS** handlers procesando preview data:

1. **`handlePreviewData`**: Recibe mensajes `preview_data` del orchestrator cuando pide check al favorito
   - Estos son los datos **más frescos y prioritarios**
   - Venían directamente del slave favorito tras ejecutar `guardControl check`
   
2. **`handleTelemetryUpdate`**: Recibe mensajes `telemetry_update` cada pocos segundos
   - Incluyen `preview_data` embebido pero pueden ser **obsoletos**
   - Se envían constantemente como heartbeat

**El problema**: `telemetry_update` se ejecutaba después de `preview_data` y sobreescribía los datos frescos con datos viejos.

### Problema 2: Throttle agresivo bloqueaba actualizaciones

`handlePreviewData` tenía un **throttle de 5 segundos** que bloqueaba actualizaciones legítimas:

```javascript
if (now - this.previewManager.lastPreviewAt < 5000) {
  return; // ❌ Bloqueaba updates válidos
}
```

### Problema 3: Servidor no preservaba área

El servidor tenía lógica condicional en `_handle_telemetry_update_message()`:

```python
if new_good or (not old_good):
    existing['preview_data'] = new_pd
# ❌ Si old era good pero new no, NO actualizaba -> área se perdía
```

Esto causaba que cuando llegaba un telemetry con preview_data sin cambios detallados, el servidor no actualizaba y enviaba datos antiguos sin área.

## ✅ Solución implementada

### 1. Sistema de prioridad para preview updates

**Archivo**: `ui/public/js/dashboard.js`

- **`handlePreviewData`** (priority: true): Preview directo del orchestrator
  ```javascript
  this.previewManager.updatePreviewFromSlave(message.slave_id, message.data, { priority: true });
  ```

- **`handleTelemetryUpdate`** (priority: false): Preview embebido en telemetría
  ```javascript
  this.previewManager.updatePreviewFromSlave(message.slave_id, pd, { priority: false });
  ```

### 2. Timestamp tracking para evitar overwrites

**Archivo**: `ui/src/utils/PreviewManager.js`

```javascript
updatePreviewFromSlave(slaveId, data, options = {}) {
  const isPriority = options.priority !== false;
  
  // Si no es priority, verificar si tenemos datos frescos recientes
  if (!isPriority) {
    if (this._lastPriorityPreviewAt && (now - this._lastPriorityPreviewAt) < 2000) {
      this.dashboard.uiHelpers.logOnce('preview:skip-stale', 
        '⏭️ Skipping stale telemetry preview (have fresh preview_data)', 2000);
      return; // ✅ No sobreescribir datos frescos
    }
  } else {
    this._lastPriorityPreviewAt = now; // Marcar timestamp de datos frescos
  }
  
  // ... procesar preview
}
```

**Ventana de protección**: 2 segundos después de recibir `preview_data`, los `telemetry_update` son ignorados.

### 3. Eliminación de throttle agresivo

**Antes**:
```javascript
const now = Date.now();
if (now - this.previewManager.lastPreviewAt < 5000) {
  return; // ❌ Bloqueaba 5 segundos
}
```

**Después**: Eliminado. El sistema de prioridad y timestamps ya previene actualizaciones innecesarias sin bloquear las legítimas.

### 4. Preservación de área en servidor

**Archivo**: `server/endpoints.py`

```python
if new_good or (not old_good):
    existing['preview_data'] = new_pd
else:
    # ✅ Si no actualizamos changes, al menos preservar área del nuevo preview
    if isinstance(new_pd, dict) and isinstance(old_pd, dict):
        new_area = new_pd.get('protectedArea') or new_pd.get('area')
        if new_area:
            old_pd['protectedArea'] = new_area
            old_pd['area'] = new_area
```

Ahora, incluso si el servidor decide no actualizar los cambios (porque los viejos eran "good"), **siempre preserva el área** del preview nuevo.

## 🎯 Resultado

- ✅ **Preview estable**: No más parpadeo
- ✅ **Área persistente**: El campo `area` nunca se pierde
- ✅ **Datos frescos prioritarios**: Los `preview_data` directos del orchestrator tienen prioridad
- ✅ **Sin bloqueos innecesarios**: Eliminado throttle de 5 segundos
- ✅ **Logging mejorado**: Ahora indica si preview es "priority" o "telemetry"

## 🔬 Logs de diagnóstico

Con el fix, ahora verás logs como:

```
🔄 Processing priority preview data from slave-001
⏭️ Skipping stale telemetry preview (have fresh preview_data)
```

Esto indica que el sistema está correctamente ignorando telemetry obsoleto cuando hay datos frescos.

## 🧪 Cómo verificar

1. Conectar un slave y marcarlo como favorito (⭐)
2. Iniciar una sesión
3. Observar el preview panel - debe mostrar datos estables sin parpadeo
4. Verificar que el área de protección siempre está visible
5. Los logs deben mostrar "Processing priority preview data" cuando el orchestrator pide check
6. Los logs deben mostrar "Skipping stale telemetry preview" cuando llegan telemetry updates obsoletos

## 📋 Archivos modificados

- `ui/public/js/dashboard.js`: Sistema de prioridad en handlers
- `ui/src/utils/PreviewManager.js`: Timestamp tracking y lógica de actualización
- `server/endpoints.py`: Preservación de área en telemetry_update

---

**Fecha**: 2025-01-XX  
**Reportado por**: Usuario  
**Fix por**: GitHub Copilot
