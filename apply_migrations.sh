#!/bin/bash

# Script para aplicar migraciones de base de datos
# Uso: ./apply_migrations.sh

echo "🔧 Aplicando migraciones de base de datos..."

# Detectar si estamos usando PostgreSQL o SQLite desde docker-compose
if docker-compose ps postgres 2>/dev/null | grep -q "Up"; then
    echo "📦 Detectado PostgreSQL en Docker"
    
    # Ejecutar migración en el contenedor de PostgreSQL
    docker-compose exec -T postgres psql -U wplace_user -d wplace_master < migrations/001_add_greedy_strategy.sql
    
    if [ $? -eq 0 ]; then
        echo "✅ Migración aplicada exitosamente"
    else
        echo "❌ Error al aplicar migración"
        exit 1
    fi
else
    echo "⚠️  PostgreSQL no está corriendo en Docker"
    echo "Por favor, ejecuta: docker-compose up -d postgres"
    echo "Luego ejecuta este script nuevamente"
    exit 1
fi

echo ""
echo "🎉 Migraciones completadas"
echo ""
echo "Para verificar, puedes ejecutar:"
echo "docker-compose exec postgres psql -U wplace_user -d wplace_master -c \"SELECT constraint_name, check_clause FROM information_schema.check_constraints WHERE constraint_name = 'sessions_strategy_check';\""
