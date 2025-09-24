"""Módulo de endpoints HTTP y WebSocket.

Este módulo define todos los endpoints de la API REST y WebSocket del servidor maestro.
Incluye endpoints para gestión de slaves, proyectos, sesiones, configuración Guard,
y funcionalidades de reparación y pintado.

Funcionalidades:
- Endpoints REST para CRUD de proyectos y sesiones
- Endpoints de configuración Guard y control
- Endpoints de gestión de slaves y favoritos
- WebSocket endpoints para comunicación en tiempo real
- Endpoints de reparación y distribución de trabajo
- Health check y utilidades
"""

import json
import uuid
import asyncio
from datetime import datetime
from typing import Dict, List, Any
from collections import defaultdict
from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.exc import SQLAlchemyError
import logging

try:
    # Importaciones relativas
    from .models import (
        ProjectConfig, SessionConfig, GuardUpload, SelectedSlavesUpdate,
        GuardConfigUpdate, GuardRepairRequest, PixelBatch,
        ProjectModel, SessionModel, SessionLocal, init_db
    )
    from .storage import (
        connected_slaves, active_projects, active_sessions, guard_config,
        last_guard_upload, ui_selected_slaves, active_protect_loops,
        batch_tracker, _last_preview_timestamp, _last_preview_lock,
        mark_recent_repairs, is_locked_change, age_recent_repairs
    )
    from .connection_manager import manager
    from .compression import _compress_if_needed, _try_decompress, _compress_with_metadata
    from .pixel_patterns import select_pixels_by_pattern
    from .session_orchestrator import setup_session_endpoints
    from .repair_endpoints import setup_repair_endpoints
except ImportError:
    # Importaciones absolutas
    from models import (
        ProjectConfig, SessionConfig, GuardUpload, SelectedSlavesUpdate,
        GuardConfigUpdate, GuardRepairRequest, PixelBatch,
        ProjectModel, SessionModel, SessionLocal, init_db
    )
    from storage import (
        connected_slaves, active_projects, active_sessions, guard_config,
        last_guard_upload, ui_selected_slaves, active_protect_loops,
        batch_tracker, _last_preview_timestamp, _last_preview_lock,
        mark_recent_repairs, is_locked_change, age_recent_repairs
    )
    from connection_manager import manager
    from compression import _compress_if_needed, _try_decompress, _compress_with_metadata
    from pixel_patterns import select_pixels_by_pattern
    from session_orchestrator import setup_session_endpoints
    from repair_endpoints import setup_repair_endpoints

logger = logging.getLogger(__name__)


def setup_endpoints(app):
    """Configurar todos los endpoints en la aplicación FastAPI."""
    
    # Configurar endpoints de módulos especializados
    setup_session_endpoints(app)
    setup_repair_endpoints(app)
    
    # === Eventos de aplicación ===
    
    @app.on_event("startup")
    async def on_startup():
        """Inicializar la base de datos y cargar proyectos/sesiones persistidos."""
        init_db()
        db = SessionLocal()
        try:
            # Cargar proyectos
            for p in db.query(ProjectModel).all():
                active_projects[p.id] = ProjectConfig(
                    name=p.name, 
                    mode=p.mode, 
                    config=p.config, 
                    chunks=[]
                )
            # Cargar sesiones (mantener created, running, paused)
            persisted = db.query(SessionModel).all()
            for s in persisted:
                active_sessions[s.id] = SessionConfig(
                    project_id=s.project_id, 
                    slave_ids=list(s.slave_ids or []), 
                    strategy=s.strategy
                )
            logger.info(f"Loaded {len(active_projects)} projects and {len(active_sessions)} sessions from DB")
        except SQLAlchemyError as e:
            logger.error(f"Startup DB load error: {e}")
        finally:
            db.close()
    
    # === Endpoints de slaves ===
    
    @app.get("/api/slaves")
    async def get_slaves():
        """Obtener lista de slaves conectados."""
        return {"slaves": list(connected_slaves.values())}
    
    @app.post("/api/slaves/{slave_id}/favorite")
    async def set_favorite_slave(slave_id: str):
        """Marcar un slave como favorito (solo uno a la vez)."""
        if slave_id not in connected_slaves:
            raise HTTPException(status_code=404, detail="Slave not found")
        
        # Si ya es el favorito actual, reenviar config y devolver rápido
        already_fav = bool(getattr(connected_slaves[slave_id], 'is_favorite', False))
        if already_fav:
            # Refresco opcional de guardConfig / guardData
            try:
                await manager.send_to_slave(slave_id, {
                    "type": "guardConfig",
                    "config": guard_config,
                    "timestamp": datetime.utcnow().isoformat()
                })
                if last_guard_upload:
                    # Usar datos procesados si están disponibles, sino usar datos originales
                    guard_data_to_send = last_guard_upload.get("processed_data", last_guard_upload.get("data", {}))
                    
                    await manager.send_to_slave(slave_id, {
                        "type": "guardData",
                        "filename": last_guard_upload.get("filename", "uploaded_guard.json"),
                        "guardData": guard_data_to_send,
                        "timestamp": datetime.utcnow().isoformat()
                    })
            except Exception as e:
                logger.error(f"Error re-sending data to existing favorite {slave_id}: {e}")
            return {"ok": True, "favorite": slave_id, "unchanged": True}
        
        # Snapshot de favoritos previos para evitar RuntimeError
        previous_favorites = [
            sid for sid, s in list(connected_slaves.items()) 
            if getattr(s, 'is_favorite', False) and sid != slave_id
        ]
        
        # Desmarcar antiguos favoritos
        for prev_id in previous_favorites:
            if prev_id in connected_slaves:
                try:
                    connected_slaves[prev_id].is_favorite = False
                    await manager.send_to_slave(prev_id, {"type": "setFavorite", "isFavorite": False})
                except Exception as e:
                    logger.warning(f"Failed notifying old favorite {prev_id}: {e}")
        
        # Establecer nuevo favorito
        connected_slaves[slave_id].is_favorite = True
        try:
            await manager.send_to_slave(slave_id, {"type": "setFavorite", "isFavorite": True})
        except Exception as e:
            logger.error(f"Error notifying new favorite flag to {slave_id}: {e}")
        
        # Enviar configuración Guard y guardData
        try:
            await manager.send_to_slave(slave_id, {
                "type": "guardConfig",
                "config": guard_config,
                "timestamp": datetime.utcnow().isoformat()
            })
        except Exception as e:
            logger.error(f"Error sending guard config to new favorite {slave_id}: {e}")
            
        try:
            if last_guard_upload:
                # Usar datos procesados si están disponibles, sino usar datos originales
                guard_data_to_send = last_guard_upload.get("processed_data", last_guard_upload.get("data", {}))
                
                await manager.send_to_slave(slave_id, {
                    "type": "guardData",
                    "filename": last_guard_upload.get("filename", "uploaded_guard.json"),
                    "guardData": guard_data_to_send,
                    "timestamp": datetime.utcnow().isoformat()
                })
        except Exception as e:
            logger.error(f"Error sending guardData to new favorite {slave_id}: {e}")
        
        # Notificar UIs
        await manager.broadcast_to_ui({"type": "slave_favorite", "slave_id": slave_id})
        return {"ok": True, "favorite": slave_id, "demoted": previous_favorites}
    
    @app.post("/api/slaves/{slave_id}/paint")
    async def paint_with_slave(slave_id: str, cmd: PixelBatch):
        """Enviar comando de pintado a un slave específico."""
        if slave_id not in connected_slaves:
            raise HTTPException(status_code=404, detail="Slave not found")
        if len(cmd.coords) != len(cmd.colors) or len(cmd.coords) == 0:
            raise HTTPException(status_code=400, detail="coords/colors length mismatch or empty")
            
        await manager.send_to_slave(slave_id, {
            "type": "paintBatch",
            "tileX": cmd.tileX,
            "tileY": cmd.tileY,
            "coords": cmd.coords,
            "colors": cmd.colors,
            "batchSize": len(cmd.coords)
        })
        return {"ok": True, "queued": len(cmd.coords)}
    
    # === Endpoints de configuración Guard ===
    
    @app.get("/api/guard/config")
    async def get_guard_config():
        """Obtener configuración global Guard."""
        return {"config": guard_config}
    
    @app.post("/api/guard/config")
    async def update_guard_config(cfg: GuardConfigUpdate):
        """Actualizar configuración Guard y broadcast al slave favorito."""
        changed = {}
        for field, value in cfg.dict(exclude_unset=True).items():
            guard_config[field] = value
            changed[field] = value
        
        # Localizar slave favorito
        fav_id = None
        for sid, sinfo in connected_slaves.items():
            if getattr(sinfo, 'is_favorite', False):
                fav_id = sid
                break
                
        if fav_id:
            await manager.send_to_slave(fav_id, {
                "type": "guardConfig",
                "config": guard_config,
                "changed": changed,
                "timestamp": datetime.utcnow().isoformat()
            })
            
        # Notificar a UIs
        await manager.broadcast_to_ui({
            "type": "guard_config",
            "config": guard_config,
            "changed": changed
        })
        
        return {"ok": True, "config": guard_config, "changed": changed}
    
    @app.post("/api/guard/check")
    async def guard_force_check():
        """Forzar análisis inmediato en el slave favorito."""
        fav_id = next((sid for sid, s in connected_slaves.items() if getattr(s, 'is_favorite', False)), None)
        if not fav_id:
            if connected_slaves:
                fav_id = next(iter(connected_slaves.keys()))
                logger.warning(f"[GUARD CHECK] No favorite slave; usando fallback {fav_id}")
            else:
                raise HTTPException(status_code=400, detail="No favorite slave connected")
                
        await manager.send_to_slave(fav_id, {"type": "guardControl", "action": "check"})
        return {"ok": True, "requested": fav_id}
    
    @app.post("/api/guard/repair")
    async def guard_force_repair(req: GuardRepairRequest):
        """Solicitar reparación inmediata en el slave favorito."""
        fav_id = next((sid for sid, s in connected_slaves.items() if getattr(s, 'is_favorite', False)), None)
        if not fav_id:
            raise HTTPException(status_code=400, detail="No favorite slave connected")
            
        payload = {"type": "guardControl", "action": "repair", "params": req.dict(exclude_unset=True)}
        await manager.send_to_slave(fav_id, payload)
        return {"ok": True, "requested": fav_id, "params": payload.get("params")}
    
    @app.post("/api/guard/stop")
    async def guard_stop():
        """Detener actividad de pintura/guard en el slave favorito."""
        fav_id = next((sid for sid, s in connected_slaves.items() if getattr(s, 'is_favorite', False)), None)
        target_id = fav_id
        
        if not target_id:
            if connected_slaves:
                target_id = next(iter(connected_slaves.keys()))
                logger.warning(f"[GUARD STOP] No favorite slave; usando fallback {target_id}")
            else:
                return {"ok": True, "requested": None, "skipped": "no_slave_connected"}
                
        await manager.send_to_slave(target_id, {"type": "control", "action": "stop"})
        return {"ok": True, "requested": target_id}
    
    @app.post("/api/guard/clear")
    async def guard_clear_state():
        """Limpiar estado Guard en TODOS los slaves conectados y servidor."""
        # CAMBIO: Enviar comando clear a TODOS los slaves conectados, no solo al favorito
        cleared_slaves = []
        
        if connected_slaves:
            # Enviar comando de limpieza a todos los slaves
            for slave_id in list(connected_slaves.keys()):
                try:
                    await manager.send_to_slave(slave_id, {"type": "guardControl", "action": "clear"})
                    cleared_slaves.append(slave_id)
                    logger.info(f"[GUARD CLEAR] Sent clear command to {slave_id}")
                except Exception as e:
                    logger.error(f"[GUARD CLEAR] Failed to send clear to {slave_id}: {e}")
        
        # Limpiar telemetría en servidor para todos los slaves
        try:
            for slave_id, sinfo in connected_slaves.items():
                if isinstance(sinfo.telemetry, dict):
                    sinfo.telemetry.pop('preview_data', None)
                    for k in ['correctPixels', 'incorrectPixels', 'missingPixels']:
                        sinfo.telemetry.pop(k, None)
        except Exception as e:
            logger.error(f"Error clearing telemetry: {e}")
        
        # Limpiar último guardData
        global last_guard_upload
        last_guard_upload = None
        
        # Notificar UIs
        await manager.broadcast_to_ui({
            "type": "guard_cleared",
            "cleared_slaves": cleared_slaves,
            "guardDataCleared": True
        })
        
        return {"ok": True, "cleared_slaves": cleared_slaves, "total_cleared": len(cleared_slaves)}
    
    @app.get("/api/guard/last-upload")
    async def guard_get_last_upload():
        """Obtener el último guardData subido (para rehidratación tras recarga de UI).

        Respuestas:
        - 200 con { filename, data, stored_at } si existe
        - 404 si no hay ningún upload registrado en memoria
        """
        if not last_guard_upload:
            raise HTTPException(status_code=404, detail="No guard upload available")
        try:
            return {
                "ok": True,
                "filename": last_guard_upload.get("filename"),
                "data": last_guard_upload.get("data"),
                "stored_at": last_guard_upload.get("stored_at")
            }
        except Exception:
            # Fallback defensivo
            return {"ok": True, **(last_guard_upload or {})}

    @app.get("/api/guard/preview")
    async def guard_get_preview():
        """Obtener último preview_data del slave favorito."""
        fav = next(((sid, s) for sid, s in connected_slaves.items() if getattr(s, 'is_favorite', False)), None)
        if not fav:
            raise HTTPException(status_code=404, detail="No favorite slave connected")
            
        fav_id, fav_state = fav
        pdata = fav_state.telemetry.get('preview_data') if fav_state.telemetry else None
        if not pdata:
            raise HTTPException(status_code=404, detail="No preview_data yet")
            
        return {"ok": True, "slave_id": fav_id, "data": pdata}
    
    @app.post("/api/guard/upload")
    async def upload_guard(guard: GuardUpload, persist: bool = True):
        """Subir configuración Guard y enviar al slave favorito.

        Query params:
        - persist: si False, no crea un nuevo proyecto ni emite project_created (para activar un proyecto existente)
        """
        # Importar el procesador de datos Guard
        try:
            from .guard_data_processor import process_guard_data, validate_guard_data, get_guard_data_info
        except ImportError:
            from guard_data_processor import process_guard_data, validate_guard_data, get_guard_data_info
        
        # Validar datos Guard antes de procesar
        is_valid, error_msg = validate_guard_data(guard.data)
        if not is_valid:
            raise HTTPException(status_code=400, detail=f"Datos Guard inválidos: {error_msg}")
        
        # Obtener información de los datos
        guard_info = get_guard_data_info(guard.data)
        logger.info(f"[GUARD UPLOAD] Datos recibidos - Versión: {guard_info.get('version')}, "
                   f"Píxeles: {guard_info.get('pixelCount')}, "
                   f"Comprimido: {guard_info.get('isCompressed')}")
        
        # Procesar datos Guard (descomprimir si es necesario)
        processed_data = process_guard_data(guard.data)
        
        # Localizar slave favorito
        fav_id = None
        for sid, sinfo in connected_slaves.items():
            if getattr(sinfo, 'is_favorite', False):
                fav_id = sid
                break
        if not fav_id:
            raise HTTPException(status_code=400, detail="No favorite slave connected")

        logger.info(
            f"[GUARD UPLOAD] Enviando guardData procesado a slave favorito {fav_id} "
            f"(pixels={len(processed_data.get('originalPixels', []))})"
        )

        # Empaquetar datos a enviar al favorito
        payload = {
            "type": "guardData",
            "filename": guard.filename or "uploaded_guard.json",
            "guardData": processed_data,  # Usar datos procesados
            "timestamp": datetime.utcnow().isoformat(),
        }

        # Persistir último guardData (datos originales para rehidratación)
        global last_guard_upload
        last_guard_upload = {
            "filename": guard.filename or "uploaded_guard.json",
            "data": guard.data,  # Mantener datos originales
            "processed_data": processed_data,  # Agregar datos procesados
            "stored_at": datetime.utcnow().isoformat(),
        }

        project_id = None
        if persist:
            # Persistir como proyecto (para rehidratación visible en UI)
            project_id = str(uuid.uuid4())
            try:
                active_projects[project_id] = ProjectConfig(
                    name=guard.filename or "Guard Upload", mode="Guard", config=processed_data
                )
            except Exception:
                active_projects[project_id] = ProjectConfig(name="Guard Upload", mode="Guard", config=processed_data)
            db = SessionLocal()
            try:
                db.add(
                    ProjectModel(
                        id=project_id,
                        name=active_projects[project_id].name,
                        mode="Guard",
                        config=processed_data,  # Guardar datos procesados en DB
                    )
                )
                db.commit()
            except SQLAlchemyError as e:
                logger.error(f"DB save guard-upload project error: {e}")
                db.rollback()
            finally:
                db.close()

        # Usar compresión mejorada para archivos grandes
        try:
            compressed_json, compression_metadata = _compress_with_metadata(payload)
            
            # Enviar al slave favorito con compresión
            await manager.slave_connections[fav_id].send_text(compressed_json)
            
            logger.info(f"[GUARD UPLOAD] Datos enviados con compresión: "
                       f"{compression_metadata['originalLength']} → {compression_metadata['compressedLength']} bytes "
                       f"({'comprimido' if compression_metadata['compressed'] else 'sin comprimir'})")
            
            # Respuesta con metadatos de compresión
            response_data = {
                "ok": True,
                "sent_to": fav_id,
                "pixels": len(processed_data.get('originalPixels', [])),
                "filename": guard.filename or "uploaded_guard.json",
                "project_id": project_id,
                "persisted": bool(project_id),
                "originalLength": compression_metadata["originalLength"],
                "compressedLength": compression_metadata["compressedLength"],
                "compressed": compression_metadata["compressed"],
                "timestamp": datetime.utcnow().isoformat()
            }
            
        except Exception as send_error:
            logger.error(f"Error enviando guardData comprimido: {send_error}")
            # Fallback: envío directo sin compresión
            try:
                await manager.send_to_slave(fav_id, payload)
                response_data = {
                     "ok": True,
                     "sent_to": fav_id,
                     "pixels": len(processed_data.get('originalPixels', [])),
                     "filename": guard.filename or "uploaded_guard.json",
                     "project_id": project_id,
                     "persisted": bool(project_id),
                     "fallback": True,
                     "timestamp": datetime.utcnow().isoformat()
                 }
            except Exception as fallback_error:
                logger.error(f"Error en fallback guardData: {fallback_error}")
                raise HTTPException(status_code=500, detail="Error enviando datos al slave")

            # Notificar a UIs que se creó un proyecto
            try:
                await manager.broadcast_to_ui(
                    {
                        "type": "project_created",
                        "project": {
                            "id": project_id,
                            "name": active_projects[project_id].name,
                            "mode": "Guard",
                            "config": processed_data,  # Usar datos procesados, no originales
                        },
                    }
                )
            except Exception as e:
                logger.error(f"Error broadcasting project_created: {e}")

        # Limpiar preview_data previo en servidor (para evitar que persista el anterior)
        try:
            for sid, sinfo in connected_slaves.items():
                if isinstance(sinfo.telemetry, dict):
                    sinfo.telemetry.pop('preview_data', None)
        except Exception as e:
            logger.warning(f"[GUARD UPLOAD] Failed clearing previous preview_data: {e}")

        # Pedir al favorito limpiar su estado antes de cargar nuevo guard
        try:
            await manager.send_to_slave(fav_id, {"type": "guardControl", "action": "clear"})
        except Exception as e:
            logger.warning(f"[GUARD UPLOAD] Failed sending clear to favorite {fav_id}: {e}")

        # Usar función con metadatos para obtener información de compresión
        compressed_json, compression_metadata = _compress_with_metadata(payload)

        # Enviar al slave
        await manager.slave_connections[fav_id].send_text(compressed_json)

        # Notificar a UI con información de compresión
        await manager.broadcast_to_ui(
            {
                "type": "guard_upload_sent",
                "slave_id": fav_id,
                "filename": payload["filename"],
                "pixels": len(guard.data.get("originalPixels", [])),
                "originalLength": compression_metadata["originalLength"],
                "compressedLength": compression_metadata["compressedLength"],
                "compressed": compression_metadata["compressed"],
            }
        )

        return response_data
    
    # === Endpoints de UI ===
    
    @app.get("/api/ui/selected-slaves")
    async def get_ui_selected_slaves():
        """Obtener slaves seleccionados en UI."""
        return {"slave_ids": list(ui_selected_slaves)}
    
    @app.post("/api/ui/selected-slaves")
    async def set_ui_selected_slaves(sel: SelectedSlavesUpdate):
        """Establecer slaves seleccionados en UI."""
        global ui_selected_slaves
        try:
            ui_selected_slaves = list(dict.fromkeys(sel.slave_ids))
        except Exception:
            ui_selected_slaves = sel.slave_ids or []
            
        await manager.broadcast_to_ui({"type": "ui_selected_slaves", "slave_ids": ui_selected_slaves})
        return {"ok": True, "slave_ids": ui_selected_slaves}
    
    # === Endpoints de proyectos ===
    
    @app.get("/api/projects")
    async def get_projects():
        """Obtener lista de proyectos activos."""
        return {"projects": list(active_projects.values())}
    
    @app.post("/api/projects")
    async def create_project(project: ProjectConfig):
        """Crear nuevo proyecto."""
        project_id = str(uuid.uuid4())
        active_projects[project_id] = project
        
        # Persistir en DB
        db = SessionLocal()
        try:
            db.add(ProjectModel(
                id=project_id, 
                name=project.name, 
                mode=project.mode, 
                config=project.config
            ))
            db.commit()
        except SQLAlchemyError as e:
            logger.error(f"DB save project error: {e}")
            db.rollback()
        finally:
            db.close()
            
        # Notificar a UIs
        try:
            await manager.broadcast_to_ui({
                "type": "project_created",
                "project": {
                    "id": project_id,
                    "name": project.name,
                    "mode": project.mode,
                    "config": project.config,
                },
            })
        except Exception:
            pass

        return {"project_id": project_id, "project": project}
    
    @app.get("/api/projects/{project_id}")
    async def get_project(project_id: str):
        """Obtener proyecto específico."""
        if project_id not in active_projects:
            raise HTTPException(status_code=404, detail="Project not found")
        return active_projects[project_id]

    @app.delete("/api/projects/{project_id}")
    async def delete_project(project_id: str):
        """Eliminar un proyecto y sus sesiones asociadas."""
        # Eliminar de memoria
        removed = bool(active_projects.pop(project_id, None))

        # Eliminar sesiones asociadas en memoria
        try:
            to_delete = [sid for sid, s in active_sessions.items() if s.project_id == project_id]
            for sid in to_delete:
                active_sessions.pop(sid, None)
        except Exception:
            pass

        # Eliminar en DB
        db = SessionLocal()
        try:
            # Borrar sesiones primero
            try:
                db.query(SessionModel).filter(SessionModel.project_id == project_id).delete()
            except Exception:
                pass
            # Borrar proyecto
            proj = db.query(ProjectModel).filter(ProjectModel.id == project_id).first()
            if proj:
                db.delete(proj)
            db.commit()
        except SQLAlchemyError as e:
            logger.error(f"DB delete project error: {e}")
            db.rollback()
        finally:
            db.close()

        # Notificar a UIs
        try:
            await manager.broadcast_to_ui({"type": "project_deleted", "project_id": project_id})
        except Exception:
            pass

        if not removed:
            # Si no estaba en memoria, igualmente devolvemos ok pues se eliminó en DB si existía
            return {"ok": True, "project_id": project_id, "existed": False}
        return {"ok": True, "project_id": project_id, "existed": True}
    
    @app.post("/api/projects/clear-all")
    async def clear_all_projects_and_sessions():
        """Eliminar todos los proyectos y sesiones."""
        # Detener bucles activos
        try:
            for sid, loop in list(active_protect_loops.items()):
                try:
                    loop["running"] = False
                except Exception:
                    pass
            active_protect_loops.clear()
        except Exception as e:
            logger.error(f"Error stopping active loops: {e}")
        
        # Limpiar memoria
        active_projects.clear()
        active_sessions.clear()
        
        # Borrar de DB
        db = SessionLocal()
        proj_deleted = sess_deleted = 0
        try:
            sess_deleted = db.query(SessionModel).delete()
            proj_deleted = db.query(ProjectModel).delete()
            db.commit()
        except SQLAlchemyError as e:
            logger.error(f"DB clear-all error: {e}")
            db.rollback()
        finally:
            db.close()
        
        # Limpiar último guardData
        global last_guard_upload
        last_guard_upload = None
        
        # Notificar UI
        await manager.broadcast_to_ui({
            "type": "projects_cleared",
            "sessions_deleted": sess_deleted,
            "projects_deleted": proj_deleted
        })
        
        return {"ok": True, "projects_deleted": proj_deleted, "sessions_deleted": sess_deleted}
    
    # === Endpoints de sesiones ===
    
    @app.post("/api/sessions")
    async def create_session(session: SessionConfig):
        """Crear nueva sesión de trabajo."""
        session_id = str(uuid.uuid4())
        active_sessions[session_id] = session
        
        # Persistir en DB
        db = SessionLocal()
        try:
            db.add(SessionModel(
                id=session_id, 
                project_id=session.project_id, 
                slave_ids=session.slave_ids, 
                strategy=session.strategy, 
                status='created'
            ))
            db.commit()
        except SQLAlchemyError as e:
            logger.error(f"DB save session error: {e}")
            db.rollback()
        finally:
            db.close()
            
        return {"session_id": session_id, "session": session}
    
    @app.post("/api/sessions/{session_id}/update-slaves")
    async def update_session_slaves(session_id: str, update: SelectedSlavesUpdate):
        """Actualizar slaves en una sesión existente."""
        if session_id not in active_sessions:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # Actualizar slaves en memoria
        active_sessions[session_id].slave_ids = update.slave_ids
        
        # Actualizar en DB
        db = SessionLocal()
        try:
            s = db.query(SessionModel).filter(SessionModel.id == session_id).first()
            if s:
                s.slave_ids = update.slave_ids
                s.updated_at = datetime.utcnow()
                db.commit()
        except SQLAlchemyError as e:
            logger.error(f"DB update session slaves error: {e}")
            db.rollback()
        finally:
            db.close()
        
        # Si la sesión está corriendo, configurar nuevos slaves
        session = active_sessions[session_id]
        project = active_projects.get(session.project_id)
        
        if project:
            # Configurar todos los slaves con el proyecto actual
            for slave_id in update.slave_ids:
                if slave_id in connected_slaves:
                    try:
                        await manager.send_to_slave(slave_id, {"type": "setMode", "mode": project.mode})
                        await manager.send_to_slave(slave_id, {"type": "loadProject", "config": project.config})
                    except Exception as e:
                        logger.error(f"Error configuring slave {slave_id}: {e}")
        
        return {"ok": True, "session_id": session_id, "slave_ids": update.slave_ids}
    
    # === Health check ===
    
    @app.get("/health")
    async def health_check():
        """Health check endpoint."""
        return {"status": "healthy", "timestamp": datetime.now()}
    
    # === WebSocket endpoints ===
    
    @app.websocket("/ws/slave")
    async def websocket_slave_endpoint(websocket: WebSocket):
        """WebSocket endpoint para conexiones de slaves."""
        # Usar ID proporcionado por cliente o generar uno aleatorio
        requested_id = websocket.query_params.get('id') if hasattr(websocket, 'query_params') else None
        slave_id = requested_id or f"SLV_{uuid.uuid4().hex[:8].upper()}"
        
        await manager.connect_slave(websocket, slave_id)
        
        try:
            # Enviar confirmación de conexión
            await websocket.send_text(_compress_if_needed({
                "type": "connected",
                "slave_id": slave_id
            }))
            
            # Notificar si es favorito
            if connected_slaves[slave_id].is_favorite:
                await websocket.send_text(_compress_if_needed({
                    "type": "favorite_status",
                    "is_favorite": True
                }))
            
            while True:
                data = await websocket.receive_text()
                message = json.loads(data)
                message = _try_decompress(message)
                
                # Actualizar info del slave
                if slave_id in connected_slaves:
                    connected_slaves[slave_id].last_seen = datetime.now()
                    
                    await _handle_slave_message(slave_id, message)
                    
        except WebSocketDisconnect:
            await manager.disconnect_slave(slave_id)
        except Exception as e:
            logger.error(f"Error in slave websocket {slave_id}: {e}")
            await manager.disconnect_slave(slave_id)
    
    @app.websocket("/ws/ui")
    async def websocket_ui_endpoint(websocket: WebSocket):
        """WebSocket endpoint para interfaces de usuario."""
        await manager.connect_ui(websocket)
        
        try:
            # Enviar estado inicial
            await _send_initial_ui_state(websocket)
            
            while True:
                # Mantener conexión viva
                await websocket.receive_text()
                
        except WebSocketDisconnect:
            await manager.disconnect_ui(websocket)
        except Exception as e:
            logger.error(f"Error in UI websocket: {e}")
            await manager.disconnect_ui(websocket)


async def _handle_slave_message(slave_id: str, message: Dict[str, Any]):
    """Manejar mensaje recibido de un slave."""
    msg_type = message.get("type")
    
    if msg_type == "telemetry":
        await _handle_telemetry_message(slave_id, message)
    elif msg_type == "status":
        await _handle_status_message(slave_id, message)
    elif msg_type == "preview_data":
        await _handle_preview_data_message(slave_id, message)
    elif msg_type == "repair_suggestion":
        await _handle_repair_suggestion_message(slave_id, message)
    elif msg_type == "repair_ack":
        await _handle_repair_ack_message(slave_id, message)
    elif msg_type == "repair_progress":
        await _handle_repair_progress_message(slave_id, message)
    elif msg_type == "repair_complete":
        await _handle_repair_complete_message(slave_id, message)
    elif msg_type == "repair_error":
        await _handle_repair_error_message(slave_id, message)
    elif msg_type == "paint_progress":
        await _handle_paint_progress_message(slave_id, message)
    elif msg_type == "paint_result":
        await _handle_paint_result_message(slave_id, message)


async def _handle_telemetry_message(slave_id: str, message: Dict[str, Any]):
    """Manejar mensaje de telemetría."""
    telem = message.get("data", {})
    
    # Normalizar alias previewData -> preview_data
    if 'previewData' in telem and 'preview_data' not in telem:
        telem['preview_data'] = telem['previewData']
    
    # Fusionar con telemetría existente
    existing = connected_slaves[slave_id].telemetry if isinstance(connected_slaves[slave_id].telemetry, dict) else {}
    
    # Si llega preview_data, asegurar que tenga área (fallback desde último guard upload)
    if 'preview_data' in telem:
        try:
            pd = telem.get('preview_data') or {}
            if isinstance(pd, dict):
                area = (
                    pd.get('protectedArea') or
                    pd.get('area') or
                    (last_guard_upload and isinstance(last_guard_upload.get('data'), dict) and (
                        (last_guard_upload['data'].get('protectionData') or {}).get('area') or
                        last_guard_upload['data'].get('protectionArea')
                    ))
                )
                if area and not (pd.get('protectedArea') or pd.get('area')):
                    pd['protectedArea'] = area
                # Normalizar nombres alternativos por si llegan en snake_case
                if not pd.get('protectedArea') and isinstance(pd.get('protected_area'), dict):
                    pd['protectedArea'] = pd.get('protected_area')
                telem['preview_data'] = pd
        except Exception:
            pass
    
    def _changes_are_detailed(changes):
        try:
            return (isinstance(changes, list) and len(changes) > 0 and 
                   isinstance(changes[0], dict) and ('x' in changes[0]))
        except Exception:
            return False
    
    # Decidir si reemplazar preview_data
    if 'preview_data' in telem:
        new_pd = telem.get('preview_data') or {}
        old_pd = existing.get('preview_data') or {}
        new_changes = new_pd.get('changes', []) if isinstance(new_pd, dict) else []
        old_changes = old_pd.get('changes', []) if isinstance(old_pd, dict) else []
        new_good = _changes_are_detailed(new_changes)
        old_good = _changes_are_detailed(old_changes)
        
        if new_good or (not old_good):
            existing['preview_data'] = new_pd
        
        telem = {k: v for k, v in telem.items() if k != 'preview_data'}
    
    # Actualizar resto de campos
    existing.update(telem)
    connected_slaves[slave_id].telemetry = existing
    
    # Broadcast a UI
    await manager.broadcast_to_ui({
        "type": "telemetry_update",
        "slave_id": slave_id,
        "telemetry": connected_slaves[slave_id].telemetry
    })


async def _handle_status_message(slave_id: str, message: Dict[str, Any]):
    """Manejar mensaje de estado."""
    connected_slaves[slave_id].status = message.get("status", "idle")
    await manager.broadcast_to_ui({
        "type": "status_update",
        "slave_id": slave_id,
        "status": message.get("status", "idle")
    })


async def _handle_preview_data_message(slave_id: str, message: Dict[str, Any]):
    """Manejar mensaje de preview_data del favorito."""
    if connected_slaves[slave_id].is_favorite:
        preview_payload = message.get("data", {})
        
        # Asegurar que la preview tenga área (fallback a último guard upload)
        try:
            if isinstance(preview_payload, dict):
                area = (
                    preview_payload.get('protectedArea') or
                    preview_payload.get('area') or
                    (last_guard_upload and isinstance(last_guard_upload.get('data'), dict) and (
                        (last_guard_upload['data'].get('protectionData') or {}).get('area') or
                        last_guard_upload['data'].get('protectionArea')
                    ))
                )
                if area and not (preview_payload.get('protectedArea') or preview_payload.get('area')):
                    preview_payload['protectedArea'] = area
                if not preview_payload.get('protectedArea') and isinstance(preview_payload.get('protected_area'), dict):
                    preview_payload['protectedArea'] = preview_payload.get('protected_area')
        except Exception:
            pass
        
        # Envejecer bloqueos
        try:
            age_recent_repairs()
        except Exception:
            pass
        
        try:
            connected_slaves[slave_id].telemetry["preview_data"] = preview_payload
            with _last_preview_lock:
                _last_preview_timestamp[slave_id] = datetime.utcnow().timestamp()
        except Exception as e:
            logger.error(f"Failed to persist preview_data for {slave_id}: {e}")
        
        await manager.broadcast_to_ui({
            "type": "preview_data",
            "slave_id": slave_id,
            "data": preview_payload
        })


async def _handle_repair_suggestion_message(slave_id: str, message: Dict[str, Any]):
    """Manejar sugerencia de reparación."""
    await manager.broadcast_to_ui({
        "type": "repair_suggestion",
        "slave_id": slave_id,
        "pixels": message.get("pixels", []),
        "totalDiffs": message.get("totalDiffs", 0)
    })


async def _handle_repair_ack_message(slave_id: str, message: Dict[str, Any]):
    """Manejar acknowledgment de reparación."""
    await manager.broadcast_to_ui({
        "type": "repair_ack",
        "slave_id": slave_id,
        "total_repairs": message.get("total_repairs", 0),
        "source": message.get("source", "unknown")
    })


async def _handle_repair_progress_message(slave_id: str, message: Dict[str, Any]):
    """Manejar progreso de reparación."""
    await manager.broadcast_to_ui({
        "type": "repair_progress",
        "slave_id": slave_id,
        "completed": message.get("completed", 0),
        "total": message.get("total", 0),
        "source": message.get("source", "unknown")
    })


async def _handle_repair_complete_message(slave_id: str, message: Dict[str, Any]):
    """Manejar finalización de reparación."""
    await manager.broadcast_to_ui({
        "type": "repair_complete",
        "slave_id": slave_id,
        "completed": message.get("completed", 0),
        "source": message.get("source", "unknown")
    })


async def _handle_repair_error_message(slave_id: str, message: Dict[str, Any]):
    """Manejar error de reparación."""
    await manager.broadcast_to_ui({
        "type": "repair_error",
        "slave_id": slave_id,
        "error": message.get("error", "Unknown error"),
        "source": message.get("source", "unknown")
    })


async def _handle_paint_progress_message(slave_id: str, message: Dict[str, Any]):
    """Manejar progreso de pintado."""
    # Asegurar que completed y total tengan valores válidos
    completed = message.get('completed', 0)
    total = message.get('total', 0)
    
    # Si no hay valores válidos, usar batchSize como fallback
    if completed is None or total is None:
        batch_size = message.get('batchSize', 1)
        completed = completed if completed is not None else 0
        total = total if total is not None else batch_size
    
    await manager.broadcast_to_ui({
        "type": "paint_progress",
        "slave_id": slave_id,
        "is_favorite": bool(connected_slaves[slave_id].is_favorite),
        "completed": completed,
        "total": total,
        **{k: v for k, v in message.items() if k not in ['type', 'completed', 'total']}
    })


async def _handle_paint_result_message(slave_id: str, message: Dict[str, Any]):
    """Manejar resultado de pintado."""
    # Tracking de reintentos
    req_id = message.get('requestId')
    try:
        tX = int(message.get('tileX'))
        tY = int(message.get('tileY'))
    except Exception:
        tX = tY = 0
        
    coords = message.get('coords') or []
    
    if req_id:
        batch_tracker.mark(req_id, slave_id, tX, tY, coords, bool(message.get('ok')))
    
    # Si la pintura fue OK, marcar coords como reparadas recientemente
    try:
        if bool(message.get('ok')) and coords:
            mark_recent_repairs(coords)
    except Exception:
        pass
    
    await manager.broadcast_to_ui({
        "type": "paint_result",
        "slave_id": slave_id,
        "is_favorite": bool(connected_slaves[slave_id].is_favorite),
        **{k: v for k, v in message.items() if k != 'type'}
    })


async def _send_initial_ui_state(websocket: WebSocket):
    """Enviar estado inicial a una conexión UI."""
    slaves_data = []
    for slave in connected_slaves.values():
        slave_dict = slave.dict()
        slave_dict['connected_at'] = slave_dict['connected_at'].isoformat()
        slave_dict['last_seen'] = slave_dict['last_seen'].isoformat()
        slaves_data.append(slave_dict)
    
    # Cargar sesiones y proyectos de DB
    db = SessionLocal()
    try:
        projects_list = []
        for p in db.query(ProjectModel).all():
            projects_list.append({
                "id": p.id,
                "name": p.name,
                "mode": p.mode,
                "config": p.config
            })
            
        sessions_list = []
        for s in db.query(SessionModel).all():
            sessions_list.append({
                "id": s.id,
                "project_id": s.project_id,
                "slave_ids": list(s.slave_ids or []),
                "strategy": s.strategy,
                "status": s.status,
            })
    finally:
        db.close()
    
    # Hidratar colores disponibles
    def _normalize_colors(arr):
        out = []
        try:
            for i, c in enumerate(arr or []):
                if isinstance(c, dict):
                    cid = c.get('id', i)
                    r = int(c.get('r', 0))
                    g = int(c.get('g', 0))
                    b = int(c.get('b', 0))
                    out.append({'id': cid, 'r': r, 'g': g, 'b': b})
        except Exception:
            pass
        return out
    
    initial_available_colors = []
    
    # 1) Preferir colores del favorito
    try:
        fav_id = next((sid for sid, s in connected_slaves.items() if getattr(s, 'is_favorite', False)), None)
        if fav_id:
            fav = connected_slaves.get(fav_id)
            if fav and isinstance(fav.telemetry, dict):
                pd = fav.telemetry.get('preview_data') or {}
                initial_available_colors = _normalize_colors(pd.get('availableColors') or [])
    except Exception:
        initial_available_colors = []
    
    # 2) Si vacío, buscar en cualquier slave
    if not initial_available_colors:
        try:
            for s in connected_slaves.values():
                if isinstance(s.telemetry, dict):
                    pd = s.telemetry.get('preview_data') or {}
                    colors = _normalize_colors(pd.get('availableColors') or [])
                    if colors:
                        initial_available_colors = colors
                        break
        except Exception:
            pass
    
    # 3) Si aún vacío, usar último guard upload
    if not initial_available_colors:
        try:
            if last_guard_upload and isinstance(last_guard_upload.get('data'), dict):
                initial_available_colors = _normalize_colors(last_guard_upload['data'].get('colors') or [])
        except Exception:
            pass
    
    await websocket.send_text(json.dumps({
        "type": "initial_state",
        "slaves": slaves_data,
        "projects": projects_list,
        "sessions": sessions_list,
        "selected_slaves": list(ui_selected_slaves),
        "available_colors": initial_available_colors
    }, default=str))