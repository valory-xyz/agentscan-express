# AgentScanBackend

## Getting Started

### Prerequisites

- Node.js (v18.x)
- PostgreSQL (v16 or later)
- npm
- Git

### Installation

1. Install dependencies:
```bash
npm install
```

2. Copy the environment variables:
```bash
cp .env.example .env
```

## Database Setup

### Local Development Database

1. Install PostgreSQL:
```bash
# macOS (using Homebrew)
brew install postgresql@16

# Ubuntu/Debian
sudo apt-get update
sudo apt-get install postgresql-16
```

2. Install pgvector from source:
```bash
# Clone pgvector repository
cd /tmp
git clone --branch v0.5.1 https://github.com/pgvector/pgvector.git
cd pgvector
make
sudo make install

# Note: If you encounter any build errors, you may need to install build dependencies:
# macOS: xcode-select --install
# Ubuntu/Debian: sudo apt-get install postgresql-server-dev-16 build-essential
```

3. Create a local database and set up the postgres user:
```bash
# Create the database
createdb agentscan_local

# Set up postgres user with password
psql -d postgres -c "ALTER USER postgres WITH PASSWORD 'postgres';"

# Enable pgvector extension
psql -d agentscan_local -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

4. Configure your local environment variables:
```env
# Add these to your .env file
LOCAL_POSTGRES_URL="postgresql://postgres:postgres@localhost:5432/agentscan_local"
LOCAL_POSTGRES_USER=postgres
LOCAL_POSTGRES_HOST=localhost
LOCAL_POSTGRES_DB=agentscan_local
LOCAL_POSTGRES_PASSWORD=postgres
LOCAL_POSTGRES_PORT=5432
LOCAL_POSTGRES_SSL=false
USE_LOCAL_DB=true
```

5. Initialize the database schema:
```bash
# Generate and apply migrations
npx drizzle-kit generate
npx drizzle-kit push
```

### Using the Local Database

To switch between local and production databases:

- For local development: Set `USE_LOCAL_DB=true` in your `.env`
- For production: Set `USE_LOCAL_DB=false` in your `.env`

### Database Management

- Generate migrations:
```bash
npm run db:generate
```

- Push schema changes:
```bash
npm run db:push
```

if you get an error try doing:

```bash
npm run db:migrate
```
or running this before migrate and or push
```bash
psql -d agentscan_local -f src/db/migrations/0000_loose_yellowjacket.sql
```

- View database with Drizzle Studio:
```bash
npm run db:studio
```

### Troubleshooting

If you encounter issues with pgvector:

1. Verify the installation:
```bash
psql -d agentscan_local -c "SELECT * FROM pg_available_extensions WHERE name = 'vector';"
```

2. Common issues:
   - If pgvector is not found, ensure you've built and installed it correctly
   - If you get a version mismatch, try rebuilding pgvector
   - If you get build errors, make sure you have the required development tools installed

## Running the Application

Start the development server:
```bash
npm run dev
```

The server will be available at `http://localhost:4000` (or the port specified in your `.env`).

## Additional Information

- The local database uses the pgvector extension for vector similarity search capabilities
- All tables are created in the public schema
- The database supports vector embeddings with 512 dimensions
- Includes support for HNSW indexes for fast similarity search
