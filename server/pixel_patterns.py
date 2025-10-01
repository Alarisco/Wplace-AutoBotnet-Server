"""Módulo de patrones de selección de píxeles.

Este módulo implementa diferentes algoritmos para ordenar y seleccionar píxeles
basados en patrones geométricos y estratégicos. Cada patrón optimiza la
selección de píxeles para diferentes casos de uso en el sistema de pintado.

Funcionalidades:
- Múltiples patrones de ordenamiento (líneas, espirales, centros, etc.)
- Cálculo de bounding boxes y métricas geométricas
- Selección inteligente basada en proximidad y distribución
- Algoritmos de clustering y dispersión
"""

import math
import random
from typing import Dict, List, Any, Tuple, Optional
from collections import defaultdict


def _bbox(changes: List[Dict[str, Any]]) -> Tuple[float, float, float, float]:
    """Calcular bounding box de una lista de cambios.
    
    Args:
        changes: Lista de cambios con coordenadas x, y
        
    Returns:
        Tupla (min_x, max_x, min_y, max_y)
    """
    min_x = math.inf
    max_x = -math.inf
    min_y = math.inf
    max_y = -math.inf
    
    for ch in changes:
        try:
            x = int(ch.get('x'))
            y = int(ch.get('y'))
        except Exception:
            continue
            
        if x < min_x: min_x = x
        if x > max_x: max_x = x
        if y < min_y: min_y = y
        if y > max_y: max_y = y
        
    return (min_x, max_x, min_y, max_y)


def _line_up(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por líneas de arriba hacia abajo."""
    rows: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        rows[int(ch['y'])].append(ch)
    
    out = []
    for y in sorted(rows.keys()):
        row = rows[y]
        row.sort(key=lambda c: int(c['x']))
        out.extend(row)
    return out


def _line_down(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por líneas de abajo hacia arriba."""
    rows: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        rows[int(ch['y'])].append(ch)
    
    out = []
    for y in sorted(rows.keys(), reverse=True):
        row = rows[y]
        row.sort(key=lambda c: int(c['x']))
        out.extend(row)
    return out


def _line_left(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por columnas de izquierda a derecha."""
    cols: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        cols[int(ch['x'])].append(ch)
    
    out = []
    for x in sorted(cols.keys()):
        col = cols[x]
        col.sort(key=lambda c: int(c['y']))
        out.extend(col)
    return out


def _line_right(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por columnas de derecha a izquierda."""
    cols: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        cols[int(ch['x'])].append(ch)
    
    out = []
    for x in sorted(cols.keys(), reverse=True):
        col = cols[x]
        col.sort(key=lambda c: int(c['y']))
        out.extend(col)
    return out


def _center(changes: List[Dict[str, Any]], area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordenar píxeles desde el centro hacia afuera.
    
    Args:
        changes: Lista de cambios a ordenar
        area: Área completa del JSON (opcional) para calcular el centro correcto
    """
    import logging
    logger = logging.getLogger(__name__)
    
    # Validar y extraer área
    use_area = False
    start_x = start_y = width = height = 0
    
    if area and isinstance(area, dict):
        # Intentar múltiples variantes de nombres de campos
        start_x = area.get('startX') or area.get('start_x') or area.get('x') or 0
        start_y = area.get('startY') or area.get('start_y') or area.get('y') or 0
        width = area.get('width') or area.get('w') or 0
        height = area.get('height') or area.get('h') or 0
        
        # Validar que width y height sean números positivos
        try:
            start_x = int(start_x)
            start_y = int(start_y)
            width = int(width)
            height = int(height)
            
            if width > 0 and height > 0:
                use_area = True
                logger.info(f"[_center] Using FULL AREA center: area=({start_x},{start_y}) size={width}x{height}")
            else:
                logger.warning(f"[_center] Area invalid (width={width}, height={height}), falling back to bbox")
        except (TypeError, ValueError) as e:
            logger.warning(f"[_center] Error parsing area fields: {e}, falling back to bbox")
    else:
        logger.info(f"[_center] No area provided (area={area}), using CHANGES BBOX")
    
    # Calcular centro
    if use_area:
        # Centro del área completa
        cx = start_x + width / 2.0
        cy = start_y + height / 2.0
        logger.info(f"[_center] Calculated center from area: ({cx}, {cy})")
    else:
        # Fallback al bounding box de los cambios
        min_x, max_x, min_y, max_y = _bbox(changes)
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
        logger.info(f"[_center] Calculated center from bbox: ({cx}, {cy}) from bbox ({min_x},{min_y}) to ({max_x},{max_y})")
    
    # Debug: mostrar algunos píxeles y sus distancias
    if changes:
        sample = changes[:3]
        for ch in sample:
            dist = math.hypot(int(ch['x']) - cx, int(ch['y']) - cy)
            logger.debug(f"[_center] Sample pixel ({ch['x']},{ch['y']}) distance to center: {dist:.2f}")
    
    return sorted(changes, key=lambda c: math.hypot(int(c['x']) - cx, int(c['y']) - cy))


def _borders(changes: List[Dict[str, Any]], area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordenar píxeles desde los bordes hacia el centro."""
    if area and isinstance(area, dict):
        start_x = area.get('startX') or area.get('start_x') or area.get('x') or 0
        start_y = area.get('startY') or area.get('start_y') or area.get('y') or 0
        width = area.get('width') or area.get('w') or 0
        height = area.get('height') or area.get('h') or 0
        
        if width > 0 and height > 0:
            min_x = int(start_x)
            max_x = int(start_x + width - 1)
            min_y = int(start_y)
            max_y = int(start_y + height - 1)
        else:
            min_x, max_x, min_y, max_y = _bbox(changes)
    else:
        min_x, max_x, min_y, max_y = _bbox(changes)
    
    def ring(c):
        x = int(c['x'])
        y = int(c['y'])
        return min(x - min_x, max_x - x, y - min_y, max_y - y)
    
    return sorted(changes, key=ring)


def _zigzag(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles en patrón zigzag (alternando dirección por fila)."""
    rows: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        rows[int(ch['y'])].append({**ch, '_x': int(ch['x'])})
    
    out = []
    for i, y in enumerate(sorted(rows.keys())):
        row = rows[y]
        row.sort(key=lambda c: c['_x'], reverse=(i % 2 == 1))
        out.extend(row)
    
    # Limpiar campo temporal
    for c in out:
        c.pop('_x', None)
    
    return out


def _diagonal(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles en patrón diagonal."""
    return sorted(changes, key=lambda c: (int(c['x']) + int(c['y']), int(c['x'])))


def _snake(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles en patrón serpiente (similar a zigzag)."""
    return _zigzag(changes)


def _diagonal_sweep(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por barrido diagonal."""
    groups: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        s = int(ch['x']) + int(ch['y'])
        groups[s].append(ch)
    
    out = []
    for s in sorted(groups.keys()):
        g = groups[s]
        g.sort(key=lambda c: int(c['x']))
        out.extend(g)
    return out


def _spiral_like(changes: List[Dict[str, Any]], clockwise: Optional[bool] = None, area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordenar píxeles en patrón espiral.
    
    Args:
        changes: Lista de cambios
        clockwise: True para sentido horario, False para antihorario, None para automático
        area: Área completa del JSON (opcional) para calcular el centro correcto
    """
    if area and isinstance(area, dict):
        start_x = area.get('startX') or area.get('start_x') or area.get('x') or 0
        start_y = area.get('startY') or area.get('start_y') or area.get('y') or 0
        width = area.get('width') or area.get('w') or 0
        height = area.get('height') or area.get('h') or 0
        
        if width > 0 and height > 0:
            cx = float(start_x) + float(width) / 2.0
            cy = float(start_y) + float(height) / 2.0
        else:
            min_x, max_x, min_y, max_y = _bbox(changes)
            cx = (min_x + max_x) / 2.0
            cy = (min_y + max_y) / 2.0
    else:
        min_x, max_x, min_y, max_y = _bbox(changes)
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
    
    arr = []
    for ch in changes:
        x = int(ch['x'])
        y = int(ch['y'])
        dx = x - cx
        dy = y - cy
        r = math.hypot(dx, dy)
        ang = math.atan2(dy, dx)
        
        if clockwise is True:
            ang = ang
        elif clockwise is False:
            ang = -ang
            
        arr.append((r, ang, ch))
    
    arr.sort(key=lambda t: (round(t[0], 3), t[1]))
    return [t[2] for t in arr]


def _cluster(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por clustering desde un punto semilla aleatorio."""
    if not changes:
        return []
        
    seed = random.choice(changes)
    sx = int(seed['x'])
    sy = int(seed['y'])
    
    return sorted(changes, key=lambda c: math.hypot(int(c['x']) - sx, int(c['y']) - sy))


def _wave(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles siguiendo un patrón de onda."""
    if not changes:
        return []
        
    min_x, max_x, _min_y, _max_y = _bbox(changes)
    width = max(1, (max_x - min_x))
    
    def metric(c):
        x = int(c['x'])
        y = int(c['y'])
        nx = (x - min_x) / width
        wave_y = math.sin(nx * math.pi * 2) * 10
        return (abs(y - wave_y), x)
    
    return sorted(changes, key=metric)


def _corners(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por proximidad a las esquinas."""
    min_x, max_x, min_y, max_y = _bbox(changes)
    corners = [(min_x, min_y), (max_x, min_y), (min_x, max_y), (max_x, max_y)]
    
    def dist_to_nearest_corner(c):
        x = int(c['x'])
        y = int(c['y'])
        return min(math.hypot(x - cx, y - cy) for (cx, cy) in corners)
    
    return sorted(changes, key=dist_to_nearest_corner)


def _sweep(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por barrido en secciones."""
    sections: Dict[tuple, List[Dict[str, Any]]] = defaultdict(list)
    for ch in changes:
        x = int(ch['x'])
        y = int(ch['y'])
        sections[(x // 8, y // 8)].append(ch)
    
    out = []
    for key in sorted(sections.keys(), key=lambda k: (k[1], k[0])):
        out.extend(sections[key])
    return out


def _priority(changes: List[Dict[str, Any]], area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordenar píxeles por prioridad (centro vs bordes con factor aleatorio)."""
    if area and isinstance(area, dict):
        start_x = area.get('startX') or area.get('start_x') or area.get('x') or 0
        start_y = area.get('startY') or area.get('start_y') or area.get('y') or 0
        width = area.get('width') or area.get('w') or 0
        height = area.get('height') or area.get('h') or 0
        
        if width > 0 and height > 0:
            min_x = int(start_x)
            max_x = int(start_x + width - 1)
            min_y = int(start_y)
            max_y = int(start_y + height - 1)
            cx = float(start_x) + float(width) / 2.0
            cy = float(start_y) + float(height) / 2.0
        else:
            min_x, max_x, min_y, max_y = _bbox(changes)
            cx = (min_x + max_x) / 2.0
            cy = (min_y + max_y) / 2.0
    else:
        min_x, max_x, min_y, max_y = _bbox(changes)
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
    
    def score(c):
        x = int(c['x'])
        y = int(c['y'])
        center_d = math.hypot(x - cx, y - cy)
        edge_d = min(x - min_x, max_x - x, y - min_y, max_y - y)
        rand = random.random() * 0.3
        return center_d * 0.4 - edge_d * 0.3 + rand
    
    return sorted(changes, key=score)


def _proximity(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles por proximidad (algoritmo del vecino más cercano)."""
    if not changes:
        return []
        
    remaining = changes[:]
    start = random.choice(remaining)
    out = [start]
    remaining.remove(start)
    
    def dist(a, b):
        return math.hypot(int(a['x']) - int(b['x']), int(a['y']) - int(b['y']))
    
    while remaining:
        last = out[-1]
        nxt = min(remaining, key=lambda c: dist(c, last))
        out.append(nxt)
        remaining.remove(nxt)
    
    return out


def _quadrant(changes: List[Dict[str, Any]], area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordenar píxeles distribuyendo por cuadrantes."""
    if area and isinstance(area, dict):
        start_x = area.get('startX') or area.get('start_x') or area.get('x') or 0
        start_y = area.get('startY') or area.get('start_y') or area.get('y') or 0
        width = area.get('width') or area.get('w') or 0
        height = area.get('height') or area.get('h') or 0
        
        if width > 0 and height > 0:
            cx = float(start_x) + float(width) / 2.0
            cy = float(start_y) + float(height) / 2.0
        else:
            min_x, max_x, min_y, max_y = _bbox(changes)
            cx = (min_x + max_x) / 2.0
            cy = (min_y + max_y) / 2.0
    else:
        min_x, max_x, min_y, max_y = _bbox(changes)
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
    
    quads = [[], [], [], []]
    for ch in changes:
        x = int(ch['x'])
        y = int(ch['y'])
        
        if x <= cx and y <= cy:
            quads[0].append(ch)
        elif x > cx and y <= cy:
            quads[1].append(ch)
        elif x <= cx and y > cy:
            quads[2].append(ch)
        else:
            quads[3].append(ch)
    
    out = []
    idxs = [0, 0, 0, 0]
    
    while True:
        progressed = False
        for i in range(4):
            if idxs[i] < len(quads[i]):
                out.append(quads[i][idxs[i]])
                idxs[i] += 1
                progressed = True
        if not progressed:
            break
    
    return out


def _scattered(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles maximizando la dispersión."""
    out: List[Dict[str, Any]] = []
    cand = changes[:]
    
    if not cand:
        return out
    
    # Empezar por uno al azar
    out.append(cand.pop(random.randrange(len(cand))))
    
    def min_dist_to_out(c):
        return min(math.hypot(int(c['x']) - int(o['x']), int(c['y']) - int(o['y'])) for o in out)
    
    while cand:
        best_idx = max(range(len(cand)), key=lambda i: min_dist_to_out(cand[i]))
        out.append(cand.pop(best_idx))
    
    return out


def _diagonal_weight(ch, min_x, max_x, min_y, max_y):
    """Calcular peso diagonal para un cambio."""
    x = int(ch['x'])
    y = int(ch['y'])
    dist_to_left = x - min_x
    dist_to_right = max_x - x
    dist_to_top = y - min_y
    dist_to_bottom = max_y - y
    return min(dist_to_left, dist_to_right, dist_to_top, dist_to_bottom)


def _biased_random(changes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ordenar píxeles con sesgo aleatorio hacia los bordes."""
    if not changes:
        return []
        
    min_x, max_x, min_y, max_y = _bbox(changes)
    items = []
    
    for ch in changes:
        w = 1.0 / (_diagonal_weight(ch, min_x, max_x, min_y, max_y) + 1.0) + random.random() * 0.5
        items.append((w, ch))
    
    # Selección ponderada en orden descendente
    items.sort(key=lambda t: t[0], reverse=True)
    return [c for _w, c in items]


def _anchor_points(changes: List[Dict[str, Any]], area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Ordenar píxeles por proximidad a puntos de anclaje estratégicos."""
    if area and isinstance(area, dict):
        start_x = area.get('startX') or area.get('start_x') or area.get('x') or 0
        start_y = area.get('startY') or area.get('start_y') or area.get('y') or 0
        width = area.get('width') or area.get('w') or 0
        height = area.get('height') or area.get('h') or 0
        
        if width > 0 and height > 0:
            min_x = int(start_x)
            max_x = int(start_x + width - 1)
            min_y = int(start_y)
            max_y = int(start_y + height - 1)
            cx = float(start_x) + float(width) / 2.0
            cy = float(start_y) + float(height) / 2.0
        else:
            min_x, max_x, min_y, max_y = _bbox(changes)
            cx = (min_x + max_x) / 2.0
            cy = (min_y + max_y) / 2.0
    else:
        min_x, max_x, min_y, max_y = _bbox(changes)
        cx = (min_x + max_x) / 2.0
        cy = (min_y + max_y) / 2.0
    
    anchors = [
        (min_x, min_y, 1), (max_x, min_y, 1), (min_x, max_y, 1), (max_x, max_y, 1),
        (cx, cy, 2), (cx, min_y, 3), (cx, max_y, 3), (min_x, cy, 3), (max_x, cy, 3)
    ]
    
    def key(c):
        x = int(c['x'])
        y = int(c['y'])
        best_p = 10
        best_d = math.inf
        
        for ax, ay, pr in anchors:
            d = math.hypot(x - ax, y - ay)
            if d < best_d:
                best_d = d
                best_p = pr
        
        return (best_p, best_d)
    
    return sorted(changes, key=key)


def select_pixels_by_pattern(pattern: str, changes: List[Dict[str, Any]], count: int, area: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Seleccionar píxeles usando un patrón específico.
    
    Args:
        pattern: Nombre del patrón a usar
        changes: Lista de cambios disponibles
        count: Número máximo de píxeles a seleccionar
        area: Área completa del JSON (opcional) con campos startX, startY, width, height
        
    Returns:
        Lista de píxeles ordenados según el patrón
    """
    # Clonar para no mutar
    pool = [c for c in changes if isinstance(c, dict) and 'x' in c and 'y' in c]
    if not pool or count <= 0:
        return []
    
    p = (pattern or 'random')
    
    try:
        if p == 'lineUp':
            ordered = _line_up(pool)
        elif p == 'lineDown':
            ordered = _line_down(pool)
        elif p == 'lineLeft':
            ordered = _line_left(pool)
        elif p == 'lineRight':
            ordered = _line_right(pool)
        elif p == 'center':
            ordered = _center(pool, area)
        elif p == 'borders':
            ordered = _borders(pool, area)
        elif p == 'spiral':
            ordered = _spiral_like(pool, None, area)
        elif p == 'spiralClockwise':
            ordered = _spiral_like(pool, True, area)
        elif p == 'spiralCounterClockwise':
            ordered = _spiral_like(pool, False, area)
        elif p == 'zigzag':
            ordered = _zigzag(pool)
        elif p == 'diagonal':
            ordered = _diagonal(pool)
        elif p == 'cluster':
            ordered = _cluster(pool)
        elif p == 'wave':
            ordered = _wave(pool)
        elif p == 'corners':
            ordered = _corners(pool)
        elif p == 'sweep':
            ordered = _sweep(pool)
        elif p == 'priority':
            ordered = _priority(pool, area)
        elif p == 'proximity':
            ordered = _proximity(pool)
        elif p == 'quadrant':
            ordered = _quadrant(pool, area)
        elif p == 'scattered':
            ordered = _scattered(pool)
        elif p == 'snake':
            ordered = _snake(pool)
        elif p == 'diagonalSweep':
            ordered = _diagonal_sweep(pool)
        elif p == 'biasedRandom':
            ordered = _biased_random(pool)
        elif p == 'anchorPoints':
            ordered = _anchor_points(pool, area)
        else:
            # random por defecto
            ordered = pool[:]
            random.shuffle(ordered)
    except Exception:
        ordered = pool[:]
        random.shuffle(ordered)
    
    return ordered[:count]