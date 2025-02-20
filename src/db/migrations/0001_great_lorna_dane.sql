CREATE TABLE if not exists "context_labels" (
	"context_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_context_label" UNIQUE("context_id","label")
);
--> statement-breakpoint
ALTER TABLE "context_embeddings" RENAME COLUMN "company_id" TO "team_name";--> statement-breakpoint
DROP INDEX if exists "idx_context_embeddings_type";--> statement-breakpoint
DROP INDEX if exists "context_embeddings_name_idx";--> statement-breakpoint
DROP INDEX if exists "idx_context_embeddings_company";--> statement-breakpoint
DROP INDEX if exists "idx_context_embeddings_company_embedding";--> statement-breakpoint
CREATE INDEX if not exists "idx_context_labels_context_id" ON "context_labels" USING btree ("context_id" text_ops);--> statement-breakpoint
CREATE INDEX if not exists "idx_context_labels_label" ON "context_labels" USING btree ("label" text_ops);--> statement-breakpoint
CREATE INDEX if not exists "context_embeddings_name_idx" ON "context_embeddings" USING gin (to_tsvector('english'::regconfig));--> statement-breakpoint
CREATE INDEX if not exists "idx_context_embeddings_company" ON "context_embeddings" USING btree ("team_name" text_ops);--> statement-breakpoint
CREATE INDEX if not exists "idx_context_embeddings_company_embedding" ON "context_embeddings" USING btree ("team_name" text_ops,"embedding" text_ops);--> statement-breakpoint
ALTER TABLE "context_embeddings" DROP COLUMN if exists "type";--> statement-breakpoint
ALTER TABLE "context_embeddings" DROP CONSTRAINT if exists "context_embeddings_pkey";--> statement-breakpoint
ALTER TABLE "context_embeddings" ADD CONSTRAINT "context_embeddings_pkey" PRIMARY KEY("id","location");