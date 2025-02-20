import { pgTable, uuid, text, timestamp, unique, index, integer, bigint, foreignKey, boolean, jsonb, vector, check, primaryKey, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const user_type = pgEnum("user_type", ['developer', 'consumer', 'business'])


export const teams = pgTable("teams", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	system_prompt_name: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
	user_type: user_type().default('consumer').notNull(),
});

export const context_labels = pgTable("context_labels", {
	context_id: text().notNull(),
	label: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	id: uuid().defaultRandom().primaryKey().notNull(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("unique_context_label").on(table.context_id, table.label),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	privy_did: text().notNull(),
	username: text().notNull(),
	email: text(),
	eth_wallets: text().array(),
	sol_wallets: text().array(),
	pfp: text(),
	bio: text(),
	fid: integer(),
	wallet_address: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_users_privy_did").using("btree", table.privy_did.asc().nullsLast().op("text_ops")),
	unique("users_privy_did_key").on(table.privy_did),
	unique("users_username_key").on(table.username),
]);

export const discord_servers = pgTable("discord_servers", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const discord_allowed_channels = pgTable("discord_allowed_channels", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	channel_id: bigint({ mode: "number" }).primaryKey().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	server_id: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	enabled_by: bigint({ mode: "number" }).notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	foreignKey({
			columns: [table.server_id],
			foreignColumns: [discord_servers.id],
			name: "discord_allowed_channels_server_id_fkey"
		}).onDelete("cascade"),
]);

export const telegram_allowed_supergroups = pgTable("telegram_allowed_supergroups", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	chat_id: bigint({ mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	enabled_by: bigint({ mode: "number" }).notNull(),
	enabled_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	thread_id: bigint({ mode: "number" }),
	enabled: boolean().default(true).notNull(),
}, (table) => [
	unique("unique_chat_thread").on(table.chat_id, table.thread_id),
]);

export const component_processing_status = pgTable("component_processing_status", {
	component_id: text().primaryKey().notNull(),
	status: text().notNull(),
	error_message: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_component_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const contract_abis = pgTable("contract_abis", {
	address: text().primaryKey().notNull(),
	abi: jsonb(),
	abi_text: text(),
	abi_embedding: vector({ dimensions: 512 }),
	chain_id: integer().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
	implementation_address: text(),
	error_message: text(),
}, (table) => [
	unique("contract_abis_address_chain_id_key").on(table.address, table.chain_id),
]);

export const metadata_embeddings = pgTable("metadata_embeddings", {
	id: text().primaryKey().notNull(),
	embedding: vector({ dimensions: 512 }),
	service_id: text(),
	agent_id: text(),
	component_id: text(),
	metadata_content: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_metadata_embeddings_agent_id").using("btree", table.agent_id.asc().nullsLast().op("text_ops")),
	index("idx_metadata_embeddings_component_id").using("btree", table.component_id.asc().nullsLast().op("text_ops")),
	index("idx_metadata_embeddings_hnsw").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")).with({m: "16",ef_construction: "200"}),
	index("idx_metadata_embeddings_service_id").using("btree", table.service_id.asc().nullsLast().op("text_ops")),
	index("idx_metadata_id").using("btree", table.id.asc().nullsLast().op("text_ops")),
	check("one_id_required", sql`((((service_id IS NOT NULL))::integer + ((agent_id IS NOT NULL))::integer) + ((component_id IS NOT NULL))::integer) >= 1`),
]);

export const chat_sessions = pgTable("chat_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	user_id: text().notNull(),
	session_title: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
});

export const chat_messages = pgTable("chat_messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	session_id: uuid(),
	role: text().notNull(),
	content: text().notNull(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	foreignKey({
			columns: [table.session_id],
			foreignColumns: [chat_sessions.id],
			name: "chat_messages_session_id_fkey"
		}).onDelete("cascade"),
]);

export const processing_contracts = pgTable("processing_contracts", {
	address: text().notNull(),
	chain_id: integer().notNull(),
	started_at: timestamp({ withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
	index("idx_processing_contracts_address").using("btree", table.address.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.address, table.chain_id], name: "processing_contracts_pkey"}),
]);

export const code_embeddings = pgTable("code_embeddings", {
	component_id: text().notNull(),
	file_path: text().notNull(),
	code_content: text().notNull(),
	embedding: vector({ dimensions: 512 }).notNull(),
	is_chunk: boolean().default(false),
	original_file_path: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_code_embeddings_component_id").using("btree", table.component_id.asc().nullsLast().op("text_ops")),
	index("idx_code_embeddings_hnsw_embedding").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")).with({m: "16",ef_construction: "200"}),
	primaryKey({ columns: [table.component_id, table.file_path], name: "code_embeddings_pkey"}),
]);

export const context_processing_status = pgTable("context_processing_status", {
	id: text().notNull(),
	type: text().notNull(),
	location: text(),
	team_id: text().notNull(),
	name: text(),
	status: text().notNull(),
	error_message: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	metadata: jsonb(),
}, (table) => [
	primaryKey({ columns: [table.id, table.type], name: "context_processing_status_pkey"}),
]);

export const context_embeddings = pgTable("context_embeddings", {
	id: text().notNull(),
	team_name: text().notNull(),
	type: text(),
	location: text().notNull(),
	content: text().notNull(),
	name: text(),
	embedding: vector({ dimensions: 512 }).notNull(),
	is_chunk: boolean().default(false),
	original_location: text(),
	created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	updated_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow(),
	deleted_at: timestamp({ withTimezone: true, mode: 'string' }),
}, (table) => [
	index("context_embeddings_embedding_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("context_embeddings_embedding_idx1").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("context_embeddings_name_idx").using("gin", sql`to_tsvector('english'::regconfig`),
	index("idx_context_embeddings_active").using("btree", table.deleted_at.asc().nullsLast().op("timestamptz_ops")).where(sql`(deleted_at IS NULL)`),
	index("idx_context_embeddings_company").using("btree", table.team_name.asc().nullsLast().op("text_ops"), table.type.asc().nullsLast().op("text_ops")),
	index("idx_context_embeddings_hnsw_embedding").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")).with({m: "16",ef_construction: "200"}),
	index("idx_context_embeddings_id").using("btree", table.id.asc().nullsLast().op("text_ops")),
	index("idx_context_embeddings_location").using("btree", table.location.asc().nullsLast().op("text_ops")),
	index("idx_context_embeddings_name").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("idx_context_embeddings_type").using("btree", table.type.asc().nullsLast().op("text_ops")),
	primaryKey({ columns: [table.id, table.location], name: "context_embeddings_pkey"}),
]);
