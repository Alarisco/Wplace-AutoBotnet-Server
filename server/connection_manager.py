"""Módulo de gestión de conexiones WebSocket.

Este módulo maneja todas las conexiones WebSocket entre el servidor maestro,
los slaves y las interfaces de usuario. Proporciona funcionalidades para
conectar, desconectar y enviar mensajes de forma robusta.

Funcionalidades:
- Gestión de conexiones WebSocket para slaves y UI
- Envío de mensajes con compresión automática
- Manejo automático de reconexiones y desconexiones
- Gestión de slaves favoritos con configuración automática
- Broadcasting a múltiples conexiones UI
- Manejo robusto de errores de conexión
"""

import logging
from typing import Dict, List, Any
from datetime import datetime
from fastapi import WebSocket

try:
    # Importaciones relativas
    from .compression import _compress_if_needed
    from .storage import (
        connected_slaves, guard_config, last_guard_upload,
        websocket_connections, ui_connections, cleanup_disconnected_slave
    )
    from .models import SlaveInfo
except ImportError:
    # Importaciones absolutas
    from compression import _compress_if_needed
    from storage import (
        connected_slaves, guard_config, last_guard_upload,
        websocket_connections, ui_connections, cleanup_disconnected_slave
    )
    from models import SlaveInfo

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Gestor de conexiones WebSocket para slaves y UI."""
    
    def __init__(self):
        self.slave_connections: Dict[str, WebSocket] = websocket_connections
        self.ui_connections: List[WebSocket] = ui_connections

    async def connect_slave(self, websocket: WebSocket, slave_id: str):
        """Conectar un nuevo slave o reconectar uno existente."""
        await websocket.accept()
        
        # Si ya existe una conexión con el mismo ID, cerrarla y reemplazarla
        if slave_id in self.slave_connections:
            try:
                await self.slave_connections[slave_id].close()
            except Exception:
                pass
                
        self.slave_connections[slave_id] = websocket
        
        if slave_id not in connected_slaves:
            # Verificar si es el primer slave conectado para marcarlo como favorito
            is_first_slave = len(connected_slaves) == 0
            
            connected_slaves[slave_id] = SlaveInfo(
                id=slave_id,
                connected_at=datetime.now(),
                last_seen=datetime.now(),
                is_favorite=is_first_slave
            )
            
            await self.broadcast_to_ui({"type": "slave_connected", "slave_id": slave_id})
            
            if is_first_slave:
                await self.broadcast_to_ui({"type": "slave_favorite", "slave_id": slave_id})
                logger.info(f"Slave {slave_id} connected and set as favorite (first slave)")
                
                # Enviar configuración guard actual al favorito
                try:
                    payload = {
                        "type": "guardConfig", 
                        "config": guard_config, 
                        "timestamp": datetime.utcnow().isoformat()
                    }
                    await self.slave_connections[slave_id].send_text(_compress_if_needed(payload))
                except Exception as e:
                    logger.error(f"Error sending guard config to first favorite {slave_id}: {e}")
                    
                # Enviar guardData si existe para continuar preview
                try:
                    if last_guard_upload:
                        # Usar datos procesados si están disponibles, sino usar datos originales
                        guard_data_to_send = last_guard_upload.get("processed_data", last_guard_upload.get("data", {}))
                        
                        payload = {
                            "type": "guardData",
                            "filename": last_guard_upload.get("filename", "uploaded_guard.json"),
                            "guardData": guard_data_to_send,
                            "timestamp": datetime.utcnow().isoformat()
                        }
                        await self.slave_connections[slave_id].send_text(_compress_if_needed(payload))
                        logger.info(f"GuardData enviado a primer favorito {slave_id}")
                except Exception as e:
                    logger.error(f"Error sending guardData to first favorite {slave_id}: {e}")
            else:
                logger.info(f"Slave {slave_id} connected")
        else:
            # Re-conexión: actualizar last_seen y notificar opcionalmente
            connected_slaves[slave_id].last_seen = datetime.now()
            await self.broadcast_to_ui({"type": "slave_reconnected", "slave_id": slave_id})
            logger.info(f"Slave {slave_id} reconnected")
            
            # Si es favorito al reconectar, reenviar config guard
            if connected_slaves[slave_id].is_favorite:
                try:
                    payload = {
                        "type": "guardConfig", 
                        "config": guard_config, 
                        "timestamp": datetime.utcnow().isoformat()
                    }
                    await self.slave_connections[slave_id].send_text(_compress_if_needed(payload))
                except Exception as e:
                    logger.error(f"Error re-sending guard config to favorite {slave_id}: {e}")
                    
                # También re-enviar guardData si existe
                try:
                    if last_guard_upload:
                        # Usar datos procesados si están disponibles, sino usar datos originales
                        guard_data_to_send = last_guard_upload.get("processed_data", last_guard_upload.get("data", {}))
                        
                        payload = {
                            "type": "guardData",
                            "filename": last_guard_upload.get("filename", "uploaded_guard.json"),
                            "guardData": guard_data_to_send,
                            "timestamp": datetime.utcnow().isoformat()
                        }
                        await self.slave_connections[slave_id].send_text(_compress_if_needed(payload))
                        logger.info(f"GuardData re-enviado a favorito {slave_id}")
                except Exception as e:
                    logger.error(f"Error re-sending guardData to favorite {slave_id}: {e}")

    async def disconnect_slave(self, slave_id: str):
        """Desconectar un slave y manejar la reasignación de favorito si es necesario."""
        if slave_id in self.slave_connections:
            del self.slave_connections[slave_id]
            
        # Detectar si era favorito y eliminar
        was_favorite = False
        if slave_id in connected_slaves:
            try:
                was_favorite = bool(getattr(connected_slaves[slave_id], 'is_favorite', False))
            except Exception:
                was_favorite = False
                
        cleanup_disconnected_slave(slave_id)
        await self.broadcast_to_ui({"type": "slave_disconnected", "slave_id": slave_id})
        logger.info(f"Slave {slave_id} disconnected")
        
        # Si el favorito se desconectó, elegir otro aleatoriamente y notificar
        if was_favorite and connected_slaves:
            try:
                new_id = next(iter(connected_slaves.keys()))
                # Desmarcar todos y marcar nuevo favorito
                for sid, s in connected_slaves.items():
                    s.is_favorite = (sid == new_id)
                    
                # Avisar al nuevo favorito
                await self.send_to_slave(new_id, {"type": "setFavorite", "isFavorite": True})
                
                # Enviar configuración Guard para que siga telemetría coherente
                await self.send_to_slave(new_id, {
                    "type": "guardConfig", 
                    "config": guard_config, 
                    "timestamp": datetime.utcnow().isoformat()
                })
                
                # Enviar guardData si existe para que continúe la preview
                if last_guard_upload:
                    # Usar datos procesados si están disponibles, sino usar datos originales
                    guard_data_to_send = last_guard_upload.get("processed_data", last_guard_upload.get("data", {}))
                    
                    await self.send_to_slave(new_id, {
                        "type": "guardData",
                        "filename": last_guard_upload.get("filename", "uploaded_guard.json"),
                        "guardData": guard_data_to_send,
                        "timestamp": datetime.utcnow().isoformat()
                    })
                    logger.info(f"GuardData enviado a slave reconectado {new_id}")
                    
                # Notificar a UIs
                await self.broadcast_to_ui({"type": "slave_favorite", "slave_id": new_id})
                logger.info(f"Reassigned favorite to {new_id} after {slave_id} disconnect")
            except Exception as e:
                logger.error(f"Failed to auto-assign new favorite after disconnect: {e}")

    async def connect_ui(self, websocket: WebSocket):
        """Conectar una nueva interfaz de usuario."""
        await websocket.accept()
        self.ui_connections.append(websocket)
        logger.info("UI client connected")

    async def disconnect_ui(self, websocket: WebSocket):
        """Desconectar una interfaz de usuario."""
        if websocket in self.ui_connections:
            self.ui_connections.remove(websocket)
        logger.info("UI client disconnected")

    async def send_to_slave(self, slave_id: str, message: Dict[str, Any]):
        """Enviar mensaje a un slave específico."""
        if slave_id in self.slave_connections:
            try:
                await self.slave_connections[slave_id].send_text(_compress_if_needed(message))
            except Exception as e:
                logger.error(f"Error sending to slave {slave_id}: {e}")
                await self.disconnect_slave(slave_id)

    async def broadcast_to_slaves(self, message: Dict[str, Any], slave_ids: List[str] = None):
        """Enviar mensaje a múltiples slaves o a todos si no se especifica lista."""
        target_slaves = slave_ids if slave_ids is not None else list(self.slave_connections.keys())
        
        disconnected = []
        for slave_id in target_slaves:
            if slave_id in self.slave_connections:
                try:
                    await self.slave_connections[slave_id].send_text(_compress_if_needed(message))
                except Exception as e:
                    logger.error(f"Error broadcasting to slave {slave_id}: {e}")
                    disconnected.append(slave_id)
        
        # Limpiar conexiones fallidas
        for slave_id in disconnected:
            await self.disconnect_slave(slave_id)

    async def broadcast_to_ui(self, message: Dict[str, Any]):
        """Enviar mensaje a todas las interfaces de usuario conectadas."""
        disconnected = []
        for connection in self.ui_connections:
            try:
                # Suponemos que la UI no necesita recibir >20MB; aun así aplicamos compresión defensiva
                await connection.send_text(_compress_if_needed(message))
            except Exception as e:
                logger.error(f"Error broadcasting to UI: {e}")
                disconnected.append(connection)
        
        for connection in disconnected:
            await self.disconnect_ui(connection)

    async def send_to_favorite(self, message: Dict[str, Any]) -> bool:
        """Enviar mensaje al slave favorito. Retorna True si se envió exitosamente."""
        favorite_id = None
        for sid, sinfo in connected_slaves.items():
            if getattr(sinfo, 'is_favorite', False):
                favorite_id = sid
                break
                
        if favorite_id:
            await self.send_to_slave(favorite_id, message)
            return True
        return False

    def get_connected_slaves(self) -> List[str]:
        """Obtener lista de slaves conectados."""
        return list(self.slave_connections.keys())

    def get_ui_count(self) -> int:
        """Obtener número de interfaces de usuario conectadas."""
        return len(self.ui_connections)

    def is_slave_connected(self, slave_id: str) -> bool:
        """Verificar si un slave está conectado."""
        return slave_id in self.slave_connections

    async def ping_all_slaves(self):
        """Enviar ping a todos los slaves para verificar conectividad."""
        ping_message = {"type": "ping", "timestamp": datetime.utcnow().isoformat()}
        await self.broadcast_to_slaves(ping_message)

    async def update_slave_status(self, slave_id: str, status: str, telemetry: Dict[str, Any] = None):
        """Actualizar estado y telemetría de un slave."""
        if slave_id in connected_slaves:
            connected_slaves[slave_id].status = status
            connected_slaves[slave_id].last_seen = datetime.now()
            
            if telemetry:
                connected_slaves[slave_id].telemetry.update(telemetry)
                
            # Notificar a UI sobre cambio de estado
            await self.broadcast_to_ui({
                "type": "slave_status_update",
                "slave_id": slave_id,
                "status": status,
                "telemetry": connected_slaves[slave_id].telemetry
            })


# Instancia global del gestor de conexiones
manager = ConnectionManager()