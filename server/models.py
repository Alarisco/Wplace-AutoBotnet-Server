"""Módulo de modelos de datos para el WPlace Master Server.

Este módulo define todas las estructuras de datos utilizadas en la aplicación,
incluyendo modelos Pydantic para validación de API y modelos SQLAlchemy para
persistencia en base de datos.

Funcionalidades:
- Modelos Pydantic para validación de requests/responses
- Modelos SQLAlchemy para persistencia en base de datos
- Configuración de base de datos configurable por entorno (PostgreSQL por defecto via env)
- Inicialización automática de esquemas
"""

from pydantic import BaseModel
from typing import Dict, List, Optional, Any
from datetime import datetime
from sqlalchemy import create_engine, Column, String, DateTime, JSON, Text
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy.exc import SQLAlchemyError
import logging
import os

logger = logging.getLogger(__name__)

# === Modelos Pydantic para API ===

class SlaveInfo(BaseModel):
    """Información de un slave conectado."""
    id: str
    connected_at: datetime
    last_seen: datetime
    status: str = "idle"  # idle, working, error
    mode: Optional[str] = None  # Image, Guard, Farm
    telemetry: Dict[str, Any] = {}
    is_favorite: bool = False  # NUEVO: marca de Fav-Slave


class PixelBatch(BaseModel):
    """Lote de píxeles para procesar."""
    tileX: int
    tileY: int
    coords: List[Dict[str, int]]  # [{x, y}, ...]
    colors: List[int]


class ProjectConfig(BaseModel):
    """Configuración de un proyecto."""
    name: str
    mode: str  # Image, Guard
    config: Dict[str, Any]
    chunks: List[Dict[str, Any]] = []


class SessionConfig(BaseModel):
    """Configuración de una sesión de trabajo."""
    project_id: str
    slave_ids: List[str]
    strategy: str = "balanced"  # balanced, drain, priority


class GuardUpload(BaseModel):
    """Datos de subida de configuración Guard."""
    filename: Optional[str] = None
    data: Dict[str, Any]
    # data contendrá estructura como la generada por save-load.js (protectionData, originalPixels, colors, etc.)


class SelectedSlavesUpdate(BaseModel):
    """Actualización de slaves seleccionados en UI."""
    slave_ids: List[str]


class GuardConfigUpdate(BaseModel):
    """Actualización de configuración Guard."""
    operationMode: Optional[str] = None  # 'protect' | 'erase'
    protectionPattern: Optional[str] = None
    preferColor: Optional[bool] = None
    preferredColorIds: Optional[List[int]] = None
    excludeColor: Optional[bool] = None
    excludedColorIds: Optional[List[int]] = None
    spendAllPixelsOnStart: Optional[bool] = None
    minChargesToWait: Optional[int] = None
    pixelsPerBatch: Optional[int] = None
    maxRetries: Optional[int] = None  # Máximo de reintentos por lote
    chargeStrategy: Optional[str] = None  # 'greedy' | 'balanced' | 'round_robin'
    randomWaitTime: Optional[bool] = None
    randomWaitMin: Optional[float] = None
    randomWaitMax: Optional[float] = None
    colorThreshold: Optional[int] = None
    colorComparisonMethod: Optional[str] = None  # 'rgb' | 'lab'
    recentLockSeconds: Optional[int] = None  # TTL de bloqueo tras pintar (segundos)
    protectTransparentPixels: Optional[bool] = None  # Proteger píxeles transparentes
    protectPerimeter: Optional[bool] = None  # Proteger perímetro
    perimeterWidth: Optional[int] = None  # Ancho del perímetro en píxeles


class GuardRepairRequest(BaseModel):
    """Solicitud de reparación Guard."""
    limit: Optional[int] = 0  # 0 = usar config
    pattern: Optional[str] = None


# === Modelos SQLAlchemy para Base de Datos ===

# Configuración de base de datos: usar env DATABASE_URL si existe (compose la define para Postgres)
DEFAULT_SQLITE_URL = "sqlite:///./master.db"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_SQLITE_URL)

# Ajustes específicos según el driver
engine_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class ProjectModel(Base):
    """Modelo de proyecto en base de datos."""
    __tablename__ = "projects"
    
    id = Column(String, primary_key=True, index=True)
    name = Column(String, nullable=False)
    mode = Column(String, nullable=False)
    config = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class SessionModel(Base):
    """Modelo de sesión en base de datos."""
    __tablename__ = "sessions"
    
    id = Column(String, primary_key=True, index=True)
    project_id = Column(String, nullable=False)
    slave_ids = Column(JSON, nullable=False)
    strategy = Column(String, default="balanced")
    status = Column(String, default="created")  # created | running | paused | stopped
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)


def init_db():
    """Inicializar la base de datos creando todas las tablas."""
    try:
        Base.metadata.create_all(bind=engine)
        logger.info(f"DB initialized ({'SQLite' if DATABASE_URL.startswith('sqlite') else 'SQL'})")
    except SQLAlchemyError as e:
        logger.error(f"DB init error: {e}")


def get_db():
    """Obtener una sesión de base de datos."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()