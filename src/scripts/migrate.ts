import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "../initalizers/postgres";

// Main migration function
async function main() {
  console.log("🚀 Starting database migration...");

  try {
    // Perform the migration
    await migrate(db, {
      migrationsFolder: "./src/db/migrations",
    });

    console.log("✅ Migration completed successfully!");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
}

// Run the migration
main();
