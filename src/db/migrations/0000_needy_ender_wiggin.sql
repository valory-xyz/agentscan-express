-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TYPE "public"."user_type" AS ENUM('developer', 'consumer', 'business');--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"system_prompt_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"deleted_at" timestamp with time zone,
	"user_type" "user_type" DEFAULT 'consumer' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_labels" (
	"context_id" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "unique_context_label" UNIQUE("context_id","label")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_did" text NOT NULL,
	"username" text NOT NULL,
	"email" text,
	"eth_wallets" text[],
	"sol_wallets" text[],
	"pfp" text,
	"bio" text,
	"fid" integer,
	"wallet_address" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_privy_did_key" UNIQUE("privy_did"),
	CONSTRAINT "users_username_key" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "discord_servers" (
	"id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "discord_allowed_channels" (
	"channel_id" bigint PRIMARY KEY NOT NULL,
	"server_id" bigint NOT NULL,
	"enabled_by" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "telegram_allowed_supergroups" (
	"chat_id" bigint NOT NULL,
	"enabled_by" bigint NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"thread_id" bigint,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "unique_chat_thread" UNIQUE("chat_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "component_processing_status" (
	"component_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "contract_abis" (
	"address" text PRIMARY KEY NOT NULL,
	"abi" jsonb,
	"abi_text" text,
	"abi_embedding" vector(512),
	"chain_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	"implementation_address" text,
	"error_message" text,
	CONSTRAINT "contract_abis_address_chain_id_key" UNIQUE("address","chain_id")
);
--> statement-breakpoint
CREATE TABLE "metadata_embeddings" (
	"id" text PRIMARY KEY NOT NULL,
	"embedding" vector(512),
	"service_id" text,
	"agent_id" text,
	"component_id" text,
	"metadata_content" text,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "one_id_required" CHECK (((((service_id IS NOT NULL))::integer + ((agent_id IS NOT NULL))::integer) + ((component_id IS NOT NULL))::integer) >= 1)
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"session_title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE "processing_contracts" (
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT "processing_contracts_pkey" PRIMARY KEY("address","chain_id")
);
--> statement-breakpoint
CREATE TABLE "code_embeddings" (
	"component_id" text NOT NULL,
	"file_path" text NOT NULL,
	"code_content" text NOT NULL,
	"embedding" vector(512) NOT NULL,
	"is_chunk" boolean DEFAULT false,
	"original_file_path" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "code_embeddings_pkey" PRIMARY KEY("component_id","file_path")
);
--> statement-breakpoint
CREATE TABLE "context_processing_status" (
	"id" text NOT NULL,
	"type" text NOT NULL,
	"location" text,
	"team_id" text NOT NULL,
	"name" text,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"metadata" jsonb,
	CONSTRAINT "context_processing_status_pkey" PRIMARY KEY("id","type")
);
--> statement-breakpoint
CREATE TABLE "context_embeddings" (
	"id" text NOT NULL,
	"team_name" text NOT NULL,
	"type" text,
	"location" text NOT NULL,
	"content" text NOT NULL,
	"name" text,
	"embedding" vector(512) NOT NULL,
	"is_chunk" boolean DEFAULT false,
	"original_location" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone,
	CONSTRAINT "context_embeddings_pkey" PRIMARY KEY("id","location")
);
--> statement-breakpoint
ALTER TABLE "discord_allowed_channels" ADD CONSTRAINT "discord_allowed_channels_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "public"."discord_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_privy_did" ON "users" USING btree ("privy_did" text_ops);--> statement-breakpoint
CREATE INDEX "idx_component_status" ON "component_processing_status" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "idx_metadata_embeddings_agent_id" ON "metadata_embeddings" USING btree ("agent_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_metadata_embeddings_component_id" ON "metadata_embeddings" USING btree ("component_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_metadata_embeddings_hnsw" ON "metadata_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=200);--> statement-breakpoint
CREATE INDEX "idx_metadata_embeddings_service_id" ON "metadata_embeddings" USING btree ("service_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_metadata_id" ON "metadata_embeddings" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_processing_contracts_address" ON "processing_contracts" USING btree ("address" text_ops);--> statement-breakpoint
CREATE INDEX "idx_code_embeddings_component_id" ON "code_embeddings" USING btree ("component_id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_code_embeddings_hnsw_embedding" ON "code_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=200);--> statement-breakpoint
CREATE INDEX "context_embeddings_embedding_idx" ON "context_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "context_embeddings_embedding_idx1" ON "context_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "context_embeddings_name_idx" ON "context_embeddings" USING gin (to_tsvector('english'::regconfig tsvector_ops);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_active" ON "context_embeddings" USING btree ("deleted_at" timestamptz_ops) WHERE (deleted_at IS NULL);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_company" ON "context_embeddings" USING btree ("team_name" text_ops,"type" text_ops);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_hnsw_embedding" ON "context_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=200);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_id" ON "context_embeddings" USING btree ("id" text_ops);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_location" ON "context_embeddings" USING btree ("location" text_ops);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_name" ON "context_embeddings" USING btree ("name" text_ops);--> statement-breakpoint
CREATE INDEX "idx_context_embeddings_type" ON "context_embeddings" USING btree ("type" text_ops);
*/