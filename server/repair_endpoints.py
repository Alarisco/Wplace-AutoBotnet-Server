"""Módulo de endpoints de reparación.

Este módulo maneja todos los endpoints relacionados con la distribución
y gestión de órdenes de reparación de píxeles entre los slaves conectados.

Funcionalidades:
- Creación y distribución de órdenes de reparación
- Distribución automática basada en análisis del slave favorito
- Filtrado por configuración Guard (colores excluidos/preferidos)
- Balanceado de carga entre slaves disponibles
- Priorización de píxeles por tipo y preferencias
"""

import asyncio
from typing import Dict, List, Any
from fastapi import HTTPException
from pydantic import BaseModel
import logging

try:
    # Importaciones relativas
    from .storage import (
        connected_slaves, guard_config, _last_preview_timestamp,
        is_locked_change
    )
    from .connection_manager import manager
except ImportError:
    # Importaciones absolutas
    from storage import (
        connected_slaves, guard_config, _last_preview_timestamp,
        is_locked_change
    )
    from connection_manager import manager

logger = logging.getLogger(__name__)


class RepairOrder(BaseModel):
    """Modelo para órdenes de reparación."""
    pixels: List[Dict[str, Any]]
    source: str
    timestamp: int


def setup_repair_endpoints(app):
    """Configurar endpoints de reparación en la aplicación FastAPI."""
    
    @app.post("/api/repair/orders")
    async def create_repair_orders(order: RepairOrder):
        """Crear y distribuir órdenes de reparación a slaves disponibles."""
        if not order.pixels:
            return {"ok": True, "message": "No pixels to repair", "distributed": 0}
        
        # Obtener todos los slaves conectados (incluyendo favorito)
        available_slaves = list(connected_slaves.items())
        
        if not available_slaves:
            raise HTTPException(status_code=400, detail="No available slaves for repair work")
        
        # Ordenar píxeles por prioridad (alta prioridad primero)
        # Además, filtrar píxeles recientemente reparados
        def _not_locked(p):
            try:
                return not is_locked_change({'x': p.get('x'), 'y': p.get('y')})
            except Exception:
                return True
                
        incoming = [p for p in order.pixels if _not_locked(p)]
        high_priority = [p for p in incoming if p.get('priority') == 'high']
        medium_priority = [p for p in incoming if p.get('priority') == 'medium']
        low_priority = [p for p in incoming if p.get('priority') not in ['high', 'medium']]
        
        sorted_pixels = high_priority + medium_priority + low_priority
        
        # Distribuir píxeles entre slaves disponibles
        pixels_per_slave = len(sorted_pixels) // len(available_slaves)
        remainder = len(sorted_pixels) % len(available_slaves)
        
        distributed_count = 0
        start_idx = 0
        
        for i, (slave_id, slave_info) in enumerate(available_slaves):
            # Calcular cuántos píxeles debe manejar este slave
            slave_pixels_count = pixels_per_slave + (1 if i < remainder else 0)
            
            if slave_pixels_count == 0:
                continue
            
            # Obtener los píxeles para este slave
            slave_pixels = sorted_pixels[start_idx:start_idx + slave_pixels_count]
            start_idx += slave_pixels_count
            
            # Convertir píxeles a formato de orden de reparación
            coords = [{'x': pixel['x'], 'y': pixel['y']} for pixel in slave_pixels]
            # IMPORTANTE: No convertir None a int (transparente = colorId 0)
            def safe_color(pixel):
                # Soportar múltiples formatos:
                # 1. Guard nuevo: {original: {colorId: X}}
                # 2. Guard slave: {expectedColor: X}
                # 3. Directo: {color: X} o {colorId: X}
                # 4. Especial: {targetColorId: X}
                
                # Intentar targetColorId primero
                if 'targetColorId' in pixel:
                    col = pixel.get('targetColorId')
                    return 0 if col is None else int(col)
                
                # Intentar formato nuevo con nested original.colorId
                if 'original' in pixel and isinstance(pixel.get('original'), dict):
                    col = pixel['original'].get('colorId')
                    if col is not None:
                        return int(col)
                
                # Fallback a formatos antiguos
                col = pixel.get('expectedColor', pixel.get('color', pixel.get('colorId', 0)))
                return 0 if col is None else int(col)
            colors = [safe_color(pixel) for pixel in slave_pixels]
            
            # Enviar orden de reparación al slave
            await manager.send_to_slave(slave_id, {
                "type": "repairOrder",
                "coords": coords,
                "colors": colors,
                "source": order.source,
                "total_repairs": len(slave_pixels)
            })
            
            distributed_count += len(slave_pixels)
            
            # Log de la distribución
            logger.info(f"Sent {len(slave_pixels)} repair orders to slave {slave_id} from {order.source}")
        
        return {
            "ok": True, 
            "message": f"Distributed {distributed_count} repair orders to {len(available_slaves)} slaves",
            "distributed": distributed_count,
            "slaves_used": len(available_slaves)
        }
    
    @app.post("/api/repair/distribute")
    async def distribute_repair_orders():
        """Distribuir órdenes de reparación basadas en análisis del slave favorito."""
        # Encontrar el slave favorito
        fav_slave = None
        for slave_id, slave_info in connected_slaves.items():
            if slave_info.is_favorite:
                fav_slave = (slave_id, slave_info)
                break
        
        if not fav_slave:
            raise HTTPException(status_code=404, detail="No favorite slave found")
        
        fav_slave_id, fav_slave_info = fav_slave
        
        # Obtener datos de análisis de la telemetría del slave favorito
        telemetry = fav_slave_info.telemetry
        if not telemetry or 'preview_data' not in telemetry:
            raise HTTPException(status_code=400, detail="No analysis data available from favorite slave")
        
        preview_data = telemetry['preview_data']
        
        def _changes_are_detailed(changes):
            try:
                return (isinstance(changes, list) and len(changes) > 0 and 
                       isinstance(changes[0], dict) and ('x' in changes[0]))
            except Exception:
                return False
        
        changes = preview_data.get('changes', []) if isinstance(preview_data, dict) else []
        
        # Si los cambios están vacíos o no son detallados, forzar un check y esperar preview nuevo
        if (not changes) or (not _changes_are_detailed(changes)):
            try:
                old_ts = _last_preview_timestamp.get(fav_slave_id, 0)
                await manager.send_to_slave(fav_slave_id, {"type": "guardControl", "action": "check"})
                # Esperar hasta 3s a que llegue un preview_data actualizado
                for _ in range(10):
                    await asyncio.sleep(0.3)
                    new_ts = _last_preview_timestamp.get(fav_slave_id, 0)
                    if new_ts > old_ts:
                        # Recargar preview desde la telemetría persistida
                        telemetry = connected_slaves[fav_slave_id].telemetry
                        preview_data = telemetry.get('preview_data') if isinstance(telemetry, dict) else None
                        changes = preview_data.get('changes', []) if isinstance(preview_data, dict) else []
                        break
            except Exception as e:
                logger.error(f"Error forcing guard check before distribute: {e}")
        
        if (not changes) or (not _changes_are_detailed(changes)):
            return {"ok": True, "message": "No detailed changes available for repair (try again)", "distributed": 0}
        
        # Aplicar configuración Guard: excluir colores si corresponde y priorizar preferidos
        excluded_ids = set(guard_config.get('excludedColorIds') or []) if guard_config.get('excludeColor') else set()
        preferred_ids = set(guard_config.get('preferredColorIds') or []) if guard_config.get('preferColor') else set()
        
        def _expected_color(ch):
            # Soportar múltiples formatos:
            # 1. Guard nuevo: {original: {colorId: X}}
            # 2. Guard slave: {expectedColor: X}
            # 3. Directo: {color: X} o {colorId: X}
            # 4. Especial: {targetColorId: X}
            
            # Intentar targetColorId primero
            if 'targetColorId' in ch:
                col = ch.get('targetColorId')
                return 0 if col is None else int(col)
            
            # Intentar formato nuevo con nested original.colorId
            if 'original' in ch and isinstance(ch.get('original'), dict):
                col = ch['original'].get('colorId')
                if col is not None:
                    return int(col)
            
            # Fallback a formatos antiguos
            col = ch.get('expectedColor', ch.get('color', ch.get('colorId', 0)))
            return 0 if col is None else col
        
        # Filtrar excluidos
        filtered_changes = [ch for ch in changes if _expected_color(ch) not in excluded_ids]
        
        # Ordenar: primero missing, luego preferidos, luego resto
        def _priority_key(ch):
            color = _expected_color(ch)
            # 'incorrect' cuenta como missing a efectos de prioridad
            is_missing_or_incorrect = 0 if ch.get('type') in ('missing', 'incorrect') else 1
            is_preferred = 0 if color in preferred_ids else 1
            return (is_missing_or_incorrect, is_preferred)
        
        filtered_changes.sort(key=_priority_key)
        
        # Obtener todos los slaves conectados (incluyendo favorito)
        available_slaves = list(connected_slaves.items())
        
        if not available_slaves:
            raise HTTPException(status_code=400, detail="No available slaves for repair work")
        
        # Distribuir cambios entre slaves disponibles (usar lista filtrada) con reparto round-robin
        work_list = filtered_changes
        if not work_list:
            return {"ok": True, "message": "No eligible pixels to repair after filters", "distributed": 0}
        
        # Crear buckets por slave y repartir round-robin para minimizar mensajes y balancear carga
        buckets: Dict[str, List[Dict[str, Any]]] = {sid: [] for sid, _ in available_slaves}
        for i, ch in enumerate(work_list):
            sid, _sinfo = available_slaves[i % len(available_slaves)]
            buckets[sid].append(ch)
        
        distributed_count = 0
        for sid, _sinfo in available_slaves:
            slave_changes = buckets.get(sid, [])
            if not slave_changes:
                continue
                
            coords = [{'x': c['x'], 'y': c['y']} for c in slave_changes]
            # IMPORTANTE: No convertir None a int (transparente = colorId 0)
            def safe_color(c):
                # Soportar múltiples formatos:
                # 1. Guard nuevo: {original: {colorId: X}}
                # 2. Guard slave: {expectedColor: X}
                # 3. Directo: {color: X} o {colorId: X}
                # 4. Especial: {targetColorId: X}
                
                # Intentar targetColorId primero
                if 'targetColorId' in c:
                    col = c.get('targetColorId')
                    return 0 if col is None else int(col)
                
                # Intentar formato nuevo con nested original.colorId
                if 'original' in c and isinstance(c.get('original'), dict):
                    col = c['original'].get('colorId')
                    if col is not None:
                        return int(col)
                
                # Fallback a formatos antiguos
                col = c.get('expectedColor', c.get('color', c.get('colorId', 0)))
                return 0 if col is None else int(col)
            colors = [safe_color(c) for c in slave_changes]
            
            await manager.send_to_slave(sid, {
                "type": "repairOrder",
                "coords": coords,
                "colors": colors,
                "source": "guard_analysis",
                "total_repairs": len(slave_changes)
            })
            
            distributed_count += len(slave_changes)
            logger.info(f"Sent {len(slave_changes)} repair orders to slave {sid}")
        
        return {
            "ok": True, 
            "message": f"Distributed {distributed_count} repair orders to {len(available_slaves)} slaves",
            "distributed": distributed_count,
            "slaves_used": len(available_slaves)
        }