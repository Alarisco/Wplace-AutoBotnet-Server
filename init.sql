-- WPlace Master Server Database Schema

-- Ensure target databases exist (runs only on initial container creation)
-- We are connected to POSTGRES_DB (wplace_master) during init; create legacy 'wplace' if missing.
CREATE EXTENSION IF NOT EXISTS dblink;
DO $$
DECLARE
    db RECORD;
BEGIN
    -- Create wplace_master if not current and missing (safety)
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'wplace_master') THEN
        PERFORM dblink_exec('dbname=' || current_database(), 'CREATE DATABASE wplace_master');
    END IF;
    -- Create legacy database 'wplace' for components expecting that name
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'wplace') THEN
        PERFORM dblink_exec('dbname=' || current_database(), 'CREATE DATABASE wplace');
    END IF;
END$$;

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    mode VARCHAR(50) NOT NULL CHECK (mode IN ('Image', 'Guard')),
    config JSONB NOT NULL DEFAULT '{}',
    chunks JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    slave_ids JSONB NOT NULL DEFAULT '[]',
    strategy VARCHAR(50) NOT NULL DEFAULT 'balanced' CHECK (strategy IN ('balanced', 'drain', 'priority', 'greedy', 'round_robin')),
    status VARCHAR(50) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'running', 'paused', 'stopped', 'completed')),
    started_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Slaves table (for persistent slave information)
CREATE TABLE IF NOT EXISTS slaves (
    id VARCHAR(255) PRIMARY KEY,
    first_connected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    total_sessions INTEGER DEFAULT 0,
    total_pixels_repaired INTEGER DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'
);

-- Telemetry table (for historical data)
CREATE TABLE IF NOT EXISTS telemetry (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slave_id VARCHAR(255) NOT NULL,
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    repaired_pixels INTEGER DEFAULT 0,
    missing_pixels INTEGER DEFAULT 0,
    absent_pixels INTEGER DEFAULT 0,
    remaining_charges INTEGER DEFAULT 0,
    additional_data JSONB NOT NULL DEFAULT '{}',
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Logs table
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slave_id VARCHAR(255),
    session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
    level VARCHAR(20) NOT NULL DEFAULT 'INFO' CHECK (level IN ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL')),
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_telemetry_slave_id ON telemetry(slave_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_session_id ON telemetry(session_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_recorded_at ON telemetry(recorded_at);
CREATE INDEX IF NOT EXISTS idx_logs_slave_id ON logs(slave_id);
CREATE INDEX IF NOT EXISTS idx_logs_session_id ON logs(session_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_slaves_last_seen_at ON slaves(last_seen_at);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sessions_updated_at BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data for testing
INSERT INTO projects (name, mode, config) VALUES 
('Sample Image Project', 'Image', '{"image_url": "https://example.com/image.png", "start_x": 0, "start_y": 0}'),
('Sample Guard Project', 'Guard', '{"protected_area": {"x1": 100, "y1": 100, "x2": 200, "y2": 200}}');

-- Grant permissions (if needed)
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO wplace;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO wplace;