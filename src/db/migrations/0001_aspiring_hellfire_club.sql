DROP INDEX "context_embeddings_name_idx";--> statement-breakpoint
CREATE INDEX "context_embeddings_name_idx" ON "context_embeddings" USING gin (to_tsvector('english'::regconfig);