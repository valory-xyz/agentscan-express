-- Add status column to characters table


-- Add not null constraint
ALTER TABLE public.characters ALTER COLUMN status SET NOT NULL;

-- Revert changes if needed
-- ALTER TABLE public.characters DROP COLUMN status;
