"""Procesador de datos Guard comprimidos.

Este módulo maneja la compatibilidad entre los nuevos formatos JSON comprimidos
generados por Guard (v1.2) y el formato esperado por el sistema slave.

Funcionalidades:
- Descompresión de datos Guard v1.2 con paintedMapPacked
- Conversión de formato comprimido a formato legacy compatible
- Manejo de píxeles transparentes con valores RGB null
- Soporte para múltiples versiones de formato Guard
"""

import base64
import json
import logging
from typing import Dict, List, Any, Optional, Tuple

logger = logging.getLogger(__name__)


def unpack_painted_map_from_base64(base64_data: str, width: int, height: int) -> Optional[List[List[bool]]]:
    """Descomprime un mapa de píxeles desde Base64.
    
    Args:
        base64_data: Datos comprimidos en base64
        width: Ancho del área
        height: Alto del área
        
    Returns:
        Matriz 2D de booleanos o None si hay error
    """
    if not base64_data or not width or not height:
        return None
        
    try:
        # Decodificar base64
        binary_data = base64.b64decode(base64_data)
        
        # Crear matriz de píxeles
        painted_map = [[False for _ in range(width)] for _ in range(height)]
        bit_index = 0
        
        for y in range(height):
            for x in range(width):
                byte_index = bit_index >> 3  # bit_index // 8
                bit_offset = bit_index & 7   # bit_index % 8
                
                if byte_index < len(binary_data):
                    painted_map[y][x] = ((binary_data[byte_index] >> bit_offset) & 1) == 1
                
                bit_index += 1
        
        return painted_map
        
    except Exception as e:
        logger.error(f"Error descomprimiendo mapa pintado: {e}")
        return None


def expand_compressed_pixels(compressed_pixels: List[Dict], colors: List[Dict], area: Dict) -> List[Dict]:
    """Expande píxeles comprimidos al formato legacy completo.
    
    Args:
        compressed_pixels: Array de píxeles comprimidos {x, y, color}
        colors: Array de colores disponibles {id, r, g, b}
        area: Área de protección {x1, y1, x2, y2}
        
    Returns:
        Array de píxeles en formato legacy compatible con slave
    """
    expanded_pixels = []
    
    # Crear mapa de colores para búsqueda rápida
    color_map = {color['id']: color for color in colors if color.get('id') is not None}
    
    # Constante de tamaño de tile (debe coincidir con GUARD_DEFAULTS.TILE_SIZE)
    TILE_SIZE = 1000
    
    for pixel in compressed_pixels:
        try:
            x = pixel.get('x', 0)
            y = pixel.get('y', 0)
            color_id = pixel.get('color', 0)
            
            # Buscar información del color
            color_info = color_map.get(color_id, {})
            
            # Manejar píxeles transparentes (color_id = 0)
            if color_id == 0:
                r, g, b = None, None, None
            else:
                r = color_info.get('r', 0)
                g = color_info.get('g', 0) 
                b = color_info.get('b', 0)
            
            # Calcular coordenadas de tile y locales
            tile_x = x // TILE_SIZE
            tile_y = y // TILE_SIZE
            local_x_raw = x - (tile_x * TILE_SIZE)
            local_y_raw = y - (tile_y * TILE_SIZE)
            local_x = ((local_x_raw % 1000) + 1000) % 1000
            local_y = ((local_y_raw % 1000) + 1000) % 1000
            
            # Crear píxel expandido en formato legacy
            expanded_pixel = {
                'key': f"{x},{y}",
                'x': x,
                'y': y,
                'globalX': x,
                'globalY': y,
                'localX': local_x,
                'localY': local_y,
                'tileX': tile_x,
                'tileY': tile_y,
                'colorId': color_id,
                'r': r,
                'g': g,
                'b': b,
                'timestamp': pixel.get('timestamp', None)
            }
            
            expanded_pixels.append(expanded_pixel)
            
        except Exception as e:
            logger.warning(f"Error expandiendo píxel {pixel}: {e}")
            continue
    
    return expanded_pixels


def process_guard_data(guard_data: Dict[str, Any]) -> Dict[str, Any]:
    """Procesa datos Guard y los convierte al formato compatible con slave.
    
    Args:
        guard_data: Datos Guard en cualquier formato (v1.0, v1.1, v1.2)
        
    Returns:
        Datos Guard en formato compatible con slave
    """
    try:
        # Detectar versión del formato
        version = guard_data.get('version', '1.0')
        logger.info(f"Procesando datos Guard versión {version}")
        
        # Obtener área de protección
        area = (guard_data.get('protectionData', {}).get('area') or 
                guard_data.get('protectionArea') or 
                guard_data.get('area'))
        
        if not area:
            raise ValueError("No se encontró área de protección en los datos")
        
        # Obtener colores disponibles
        colors = guard_data.get('colors', [])
        
        # Procesar píxeles según la versión
        if version == '1.2' and 'originalPixels' in guard_data:
            # Formato comprimido v1.2
            logger.info("Procesando formato comprimido v1.2")
            
            compressed_pixels = guard_data['originalPixels']
            expanded_pixels = expand_compressed_pixels(compressed_pixels, colors, area)
            
            # Procesar mapa pintado si existe
            painted_map = None
            if guard_data.get('paintedMapPacked') and guard_data.get('protectionData', {}).get('areaSize'):
                area_size = guard_data['protectionData']['areaSize']
                width = area_size.get('width', 0)
                height = area_size.get('height', 0)
                
                if width > 0 and height > 0:
                    painted_map = unpack_painted_map_from_base64(
                        guard_data['paintedMapPacked'], width, height
                    )
                    if painted_map:
                        logger.info(f"Mapa pintado descomprimido: {width}x{height}")
            
            # Crear datos compatibles
            processed_data = {
                'version': version,
                'timestamp': guard_data.get('timestamp'),
                'protectionData': guard_data.get('protectionData', {}),
                'protectionArea': area,  # Compatibilidad con versiones anteriores
                'area': area,           # Compatibilidad adicional
                'originalPixels': expanded_pixels,
                'colors': colors,
                'progress': guard_data.get('progress', {}),
                'config': guard_data.get('config', {}),
                # Metadatos adicionales
                'processed': True,
                'originalFormat': 'compressed_v1.2',
                'expandedPixels': len(expanded_pixels),
                'paintedMapProcessed': painted_map is not None
            }
            
        elif version in ['1.1', '1.0'] or 'originalPixels' in guard_data:
            # Formato legacy v1.1/v1.0 - ya compatible
            logger.info(f"Procesando formato legacy {version}")
            
            original_pixels = guard_data.get('originalPixels', [])
            
            # Asegurar que los píxeles tengan el formato correcto
            processed_pixels = []
            for pixel in original_pixels:
                if isinstance(pixel, dict):
                    # Si tiene 'key', usar formato directo
                    if 'key' in pixel:
                        processed_pixels.append(pixel)
                    else:
                        # Crear key si no existe
                        x = pixel.get('globalX', pixel.get('x', 0))
                        y = pixel.get('globalY', pixel.get('y', 0))
                        pixel_copy = dict(pixel)
                        pixel_copy['key'] = f"{x},{y}"
                        processed_pixels.append(pixel_copy)
            
            processed_data = dict(guard_data)
            processed_data['originalPixels'] = processed_pixels
            processed_data['processed'] = True
            processed_data['originalFormat'] = f'legacy_{version}'
            
        else:
            # Formato desconocido - intentar procesamiento básico
            logger.warning(f"Formato Guard desconocido: {version}")
            processed_data = dict(guard_data)
            processed_data['processed'] = True
            processed_data['originalFormat'] = 'unknown'
        
        logger.info(f"Datos Guard procesados exitosamente: {len(processed_data.get('originalPixels', []))} píxeles")
        return processed_data
        
    except Exception as e:
        logger.error(f"Error procesando datos Guard: {e}")
        # Retornar datos originales en caso de error
        fallback_data = dict(guard_data)
        fallback_data['processed'] = False
        fallback_data['processingError'] = str(e)
        return fallback_data


def validate_guard_data(guard_data: Dict[str, Any]) -> Tuple[bool, str]:
    """Valida que los datos Guard tengan la estructura mínima requerida.
    
    Args:
        guard_data: Datos Guard a validar
        
    Returns:
        Tupla (es_válido, mensaje_error)
    """
    try:
        # Verificar área de protección
        area = (guard_data.get('protectionData', {}).get('area') or 
                guard_data.get('protectionArea') or 
                guard_data.get('area'))
        
        if not area:
            return False, "Falta área de protección"
        
        required_area_fields = ['x1', 'y1', 'x2', 'y2']
        missing_fields = [field for field in required_area_fields if field not in area]
        if missing_fields:
            return False, f"Faltan campos en área: {missing_fields}"
        
        # Verificar píxeles
        original_pixels = guard_data.get('originalPixels', [])
        if not isinstance(original_pixels, list):
            return False, "originalPixels debe ser un array"
        
        if len(original_pixels) == 0:
            return False, "No hay píxeles para procesar"
        
        # Verificar colores
        colors = guard_data.get('colors', [])
        if not isinstance(colors, list):
            return False, "colors debe ser un array"
        
        return True, "Datos válidos"
        
    except Exception as e:
        return False, f"Error validando datos: {e}"


def get_guard_data_info(guard_data: Dict[str, Any]) -> Dict[str, Any]:
    """Obtiene información resumida de los datos Guard.
    
    Args:
        guard_data: Datos Guard
        
    Returns:
        Diccionario con información resumida
    """
    try:
        version = guard_data.get('version', '1.0')
        
        # Área
        area = (guard_data.get('protectionData', {}).get('area') or 
                guard_data.get('protectionArea') or 
                guard_data.get('area', {}))
        
        area_info = {}
        if area:
            area_info = {
                'x1': area.get('x1', 0),
                'y1': area.get('y1', 0), 
                'x2': area.get('x2', 0),
                'y2': area.get('y2', 0),
                'width': area.get('x2', 0) - area.get('x1', 0),
                'height': area.get('y2', 0) - area.get('y1', 0)
            }
        
        # Píxeles
        original_pixels = guard_data.get('originalPixels', [])
        pixel_count = len(original_pixels) if isinstance(original_pixels, list) else 0
        
        # Colores
        colors = guard_data.get('colors', [])
        color_count = len(colors) if isinstance(colors, list) else 0
        
        # Información de compresión
        is_compressed = version == '1.2' and 'paintedMapPacked' in guard_data
        
        return {
            'version': version,
            'isCompressed': is_compressed,
            'pixelCount': pixel_count,
            'colorCount': color_count,
            'area': area_info,
            'timestamp': guard_data.get('timestamp'),
            'hasProtectionData': 'protectionData' in guard_data,
            'hasPaintedMap': 'paintedMapPacked' in guard_data
        }
        
    except Exception as e:
        logger.error(f"Error obteniendo info de datos Guard: {e}")
        return {'error': str(e)}