# MarvinsWorldBackend

## Getting started

### Run locally
npm i && npm run dev

## Database Setup

To initialize your local database:

1. Ensure PostgreSQL is installed and running
2. Update database configuration in scripts if needed
3. Run: `./scripts/init_db.sh`
4. (Optional) Load test data: `psql -U your_user -d your_database -f scripts/seed_data.sql`