-- Migration: Add 'greedy' and 'round_robin' strategies to sessions table
-- Date: 2025-10-01
-- Description: Update constraint to allow new charge distribution strategies

-- Drop existing constraint
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_strategy_check;

-- Add new constraint with all strategies
ALTER TABLE sessions ADD CONSTRAINT sessions_strategy_check 
    CHECK (strategy IN ('balanced', 'drain', 'priority', 'greedy', 'round_robin'));

-- Verify the change
SELECT constraint_name, check_clause 
FROM information_schema.check_constraints 
WHERE constraint_name = 'sessions_strategy_check';
