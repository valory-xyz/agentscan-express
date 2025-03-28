import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { teams } from '../../db/migrations/schema';
import { eq } from 'drizzle-orm';
import { db } from '../../initalizers/postgres';

const TEAM_ID = process.env.TEAM_ID;

async function main() {
  if (!TEAM_ID) {
    throw new Error('TEAM_ID environment variable is not set');
  }

  // Check if team already exists
  const existingTeam = await db.select()
    .from(teams)
    .where(eq(teams.id, TEAM_ID))
    .execute();

  if (existingTeam.length === 0) {
    // Create the team if it doesn't exist
    await db.insert(teams).values({
      id: TEAM_ID,
      name: 'olas',
      system_prompt_name: 'olas',
      user_type: "developer"
    }).execute();
    console.log('[SEED] Created team: olas');
  } else {
    console.log('[SEED] Team olas already exists');
  }

  // Exit the process
  process.exit(0);
}

main().catch((err) => {
  console.error('Error during seeding:', err);
  process.exit(1);
});
