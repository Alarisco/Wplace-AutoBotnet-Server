"""Módulo de configuración y almacenamiento en memoria.

Este módulo gestiona el estado global de la aplicación, incluyendo slaves conectados,
proyectos activos, sesiones, configuración Guard y sistemas de bloqueo temporal.
También proporciona utilidades para el seguimiento de lotes y control de concurrencia.

Funcionalidades:
- Almacenamiento en memoria de slaves, proyectos y sesiones
- Configuración global Guard con valores por defecto
- Sistema de bloqueo temporal para píxeles recientemente reparados
- Seguimiento de lotes con reintentos automáticos
- Gestión de conexiones UI y selección de slaves
"""

import uuid
import asyncio
from datetime import datetime
from typing import Dict, List, Optional, Any, Set
from threading import Lock
from collections import defaultdict
import logging

try:
    # Importaciones relativas
    from .models import SlaveInfo, ProjectConfig, SessionConfig
except ImportError:
    # Importaciones absolutas
    from models import SlaveInfo, ProjectConfig, SessionConfig

logger = logging.getLogger(__name__)

# === Almacenamiento en memoria ===

# Slaves conectados
connected_slaves: Dict[str, SlaveInfo] = {}

# Proyectos y sesiones activos
active_projects: Dict[str, ProjectConfig] = {}
active_sessions: Dict[str, SessionConfig] = {}

# Configuración Guard global
guard_config: Dict[str, Any] = {
    # Valores básicos iniciales (coinciden con defaults de guardState relevantes)
    "protectionPattern": "random",
    "preferColor": False,
    "preferredColorIds": [],
    "excludeColor": False,
    "excludedColorIds": [],
    "spendAllPixelsOnStart": False,
    "minChargesToWait": 20,
    "pixelsPerBatch": 10,
    "randomWaitTime": False,
    "randomWaitMin": 5,
    "randomWaitMax": 15,
    "colorThreshold": 10,
    "colorComparisonMethod": "rgb",  # nuevo: 'rgb' o 'lab'
    "recentLockSeconds": 60,  # nuevo: TTL de bloqueo tras pintar (segundos)
}

# Conexiones WebSocket
websocket_connections: Dict[str, Any] = {}  # WebSocket objects
ui_connections: List[Any] = []  # Lista de conexiones UI

# Bucles de protección activos
active_protect_loops: Dict[str, Dict[str, Any]] = {}

# Último guardData subido, para reenviarlo a un nuevo favorito si cambia
last_guard_upload: Optional[Dict[str, Any]] = None

# Selección de slaves a nivel UI (persistente en memoria; usado como default cross-device)
ui_selected_slaves: List[str] = []

# === Sistema de bloqueo temporal ===

# Píxeles recientemente reparados (para evitar repintar durante un periodo fijo de tiempo)
# Antes: basado en número de previews (TTL=5). Ahora: basado en tiempo (60 segundos).
RECENT_LOCK_SECONDS = 60  # valor por defecto; se puede sobrescribir con guard_config['recentLockSeconds']
recently_repaired: Dict[str, float] = {}  # almacena epoch de expiración (segundos)
_recent_lock = Lock()


def _mk_key(x: Any, y: Any) -> str:
    """Crear clave única para coordenadas."""
    try:
        return f"{int(x)},{int(y)}"
    except Exception:
        return f"{x},{y}"


def mark_recent_repairs(coords: List[Dict[str, Any]]):
    """Marcar coordenadas como bloqueadas hasta ahora + RECENT_LOCK_SECONDS."""
    if not coords:
        return
        
    now = datetime.utcnow().timestamp()
    # Permitir override por config
    try:
        lock_secs = float(guard_config.get('recentLockSeconds', RECENT_LOCK_SECONDS))
    except Exception:
        lock_secs = float(RECENT_LOCK_SECONDS)
        
    with _recent_lock:
        for p in coords:
            k = _mk_key(p.get('x'), p.get('y'))
            recently_repaired[k] = now + lock_secs


def age_recent_repairs():
    """Limpia entradas expiradas según tiempo actual."""
    now = datetime.utcnow().timestamp()
    with _recent_lock:
        to_del = [k for k, exp in recently_repaired.items() if float(exp) <= now]
        for k in to_del:
            try:
                del recently_repaired[k]
            except Exception:
                pass


def is_locked_change(change: Dict[str, Any]) -> bool:
    """Devuelve True si la coord está bloqueada aún (no ha expirado). Limpia expirados on-the-fly."""
    try:
        x = change.get('x')
        y = change.get('y')
        if x is None or y is None:
            return False
            
        k = _mk_key(x, y)
        now = datetime.utcnow().timestamp()
        
        with _recent_lock:
            exp = recently_repaired.get(k)
            if not exp:
                return False
                
            if float(exp) <= now:
                # Expirado: limpiar y no bloquear
                try:
                    del recently_repaired[k]
                except Exception:
                    pass
                return False
                
            return True
    except Exception:
        return False


# === Seguimiento de lotes y reintentos ===

class BatchTracker:
    """Seguimiento de lotes de píxeles con reintentos automáticos."""
    
    def __init__(self):
        # requestId -> { 'assignments': { (slave_id, batch_key): {tileX,tileY,coords,colors,attempts,status,last_assigned_to} }, 'pending': int }
        self.batches: Dict[str, Dict[str, Any]] = {}
        self.lock = Lock()

    def create(self, request_id: str):
        """Crear un nuevo seguimiento de lote."""
        with self.lock:
            self.batches[request_id] = {'assignments': {}, 'pending': 0}

    def _key(self, slave_id: str, payload: Dict[str, Any]):
        """Generar clave única por tile y primer coord."""
        coords = payload.get('coords') or []
        if coords:
            c0 = coords[0]
            return f"{payload.get('tileX')},{payload.get('tileY')}:{c0.get('x')},{c0.get('y')}"
        return f"{payload.get('tileX')},{payload.get('tileY')}:empty"

    def assign(self, request_id: str, slave_id: str, payload: Dict[str, Any], attempt: int):
        """Asignar un lote a un slave."""
        with self.lock:
            if request_id not in self.batches:
                self.batches[request_id] = {'assignments': {}, 'pending': 0}
                
            key = self._key(slave_id, payload)
            self.batches[request_id]['assignments'][(slave_id, key)] = {
                **payload,
                'attempts': attempt,
                'status': 'pending',
                'last_assigned_to': slave_id
            }
            self._recount(request_id)

    def mark(self, request_id: str, slave_id: str, tileX: int, tileY: int, coords: List[Dict[str, int]], ok: bool):
        """Marcar un lote como completado o fallido."""
        with self.lock:
            b = self.batches.get(request_id)
            if not b:
                return
                
            tmp_payload = {'tileX': tileX, 'tileY': tileY, 'coords': coords}
            key = self._key(slave_id, tmp_payload)
            k = (slave_id, key)
            
            if k in b['assignments']:
                b['assignments'][k]['status'] = 'ok' if ok else 'failed'
            self._recount(request_id)

    def failed_assignments(self, request_id: str):
        """Obtener asignaciones fallidas para reintento."""
        with self.lock:
            b = self.batches.get(request_id, {})
            return [((sid, key), data) for (sid, key), data in b.get('assignments', {}).items() 
                   if data.get('status') == 'failed']

    def inc_attempts(self, request_id: str, sid: str, key: str) -> int:
        """Incrementar contador de intentos para una asignación."""
        with self.lock:
            b = self.batches.get(request_id)
            if not b: 
                return 0
            if (sid, key) not in b['assignments']: 
                return 0
                
            b['assignments'][(sid, key)]['attempts'] = int(b['assignments'][(sid, key)].get('attempts', 0)) + 1
            b['assignments'][(sid, key)]['status'] = 'pending'
            return b['assignments'][(sid, key)]['attempts']

    def get_pending(self, request_id: str) -> int:
        """Obtener número de asignaciones pendientes."""
        with self.lock:
            b = self.batches.get(request_id, {})
            return int(b.get('pending', 0))

    def _recount(self, request_id: str):
        """Recontear asignaciones pendientes."""
        b = self.batches.get(request_id, {})
        b['pending'] = sum(1 for _k, a in b.get('assignments', {}).items() 
                          if a.get('status') == 'pending')
    
    def cleanup_abandoned_batches(self, request_id: str, max_retries: int = 3):
        """Limpiar lotes abandonados que han superado el máximo de reintentos."""
        with self.lock:
            b = self.batches.get(request_id)
            if not b:
                return 0
                
            abandoned_count = 0
            assignments_to_remove = []
            
            for (sid, key), data in b['assignments'].items():
                attempts = data.get('attempts', 0)
                status = data.get('status', 'pending')
                
                # Marcar para eliminación si ha superado max_retries y está fallido
                if attempts > max_retries and status == 'failed':
                    assignments_to_remove.append((sid, key))
                    abandoned_count += 1
            
            # Eliminar lotes abandonados
            for key_to_remove in assignments_to_remove:
                del b['assignments'][key_to_remove]
            
            # Recontear después de la limpieza
            self._recount(request_id)
            
            return abandoned_count


# Instancia global del tracker
batch_tracker = BatchTracker()

# === Control de preview ===

# Control simple para esperas de preview tras un check manual
_last_preview_lock = Lock()
_last_preview_timestamp: Dict[str, float] = {}


def update_last_preview_timestamp(slave_id: str):
    """Actualizar timestamp del último preview para un slave."""
    with _last_preview_lock:
        _last_preview_timestamp[slave_id] = datetime.utcnow().timestamp()


def get_last_preview_timestamp(slave_id: str) -> Optional[float]:
    """Obtener timestamp del último preview para un slave."""
    with _last_preview_lock:
        return _last_preview_timestamp.get(slave_id)


# === Utilidades de estado ===

def get_favorite_slave() -> Optional[str]:
    """Obtener el ID del slave favorito actual."""
    for sid, sinfo in connected_slaves.items():
        if getattr(sinfo, 'is_favorite', False):
            return sid
    return None


def set_favorite_slave(slave_id: str) -> bool:
    """Establecer un slave como favorito."""
    if slave_id not in connected_slaves:
        return False
        
    # Desmarcar todos los favoritos actuales
    for sid, sinfo in connected_slaves.items():
        sinfo.is_favorite = False
        
    # Marcar el nuevo favorito
    connected_slaves[slave_id].is_favorite = True
    return True


def get_connected_slave_ids() -> List[str]:
    """Obtener lista de IDs de slaves conectados."""
    return list(connected_slaves.keys())


def cleanup_disconnected_slave(slave_id: str):
    """Limpiar datos de un slave desconectado."""
    # Remover de slaves conectados
    if slave_id in connected_slaves:
        del connected_slaves[slave_id]
        
    # Remover de conexiones WebSocket
    if slave_id in websocket_connections:
        del websocket_connections[slave_id]
        
    # Remover de selección UI si estaba seleccionado
    if slave_id in ui_selected_slaves:
        ui_selected_slaves.remove(slave_id)
        
    # Limpiar timestamps de preview
    with _last_preview_lock:
        _last_preview_timestamp.pop(slave_id, None)


def clear_all_data():
    """Limpiar todos los datos en memoria (para reset completo)."""
    global last_guard_upload
    
    connected_slaves.clear()
    active_projects.clear()
    active_sessions.clear()
    websocket_connections.clear()
    ui_connections.clear()
    active_protect_loops.clear()
    ui_selected_slaves.clear()
    
    last_guard_upload = None
    
    # Limpiar bloqueos temporales
    with _recent_lock:
        recently_repaired.clear()
        
    # Limpiar timestamps de preview
    with _last_preview_lock:
        _last_preview_timestamp.clear()
        
    # Limpiar tracker de lotes
    with batch_tracker.lock:
        batch_tracker.batches.clear()