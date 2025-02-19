CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DROP INDEX IF EXISTS "context_embeddings_name_idx";--> statement-breakpoint
CREATE INDEX "context_embeddings_name_idx" ON "context_embeddings" USING gin (to_tsvector('english', name));--> statement-breakpoint