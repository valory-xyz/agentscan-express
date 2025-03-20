# Agentscan Backend

A powerful backend service built with Node.js and TypeScript, featuring advanced data processing capabilities, AI integration, and real-time communication.

## Features

- **AI Integration**: Built-in support for various AI services including Anthropic and OpenAI
- **Real-time Communication**: WebSocket support via Socket.IO
- **Vector Database**: PostgreSQL with pgvector for efficient similarity searches
- **File Processing**: Support for PDF parsing and multimedia handling
- **External Integrations**:
  - Discord.js for Discord bot functionality
  - Telegram integration via Telegraf
  - YouTube transcript processing
  - Google APIs integration
- **Authentication**: Privy authentication integration
- **Analytics**: Amplitude analytics integration
- **Rate Limiting**: Redis-based rate limiting
- **Web Scraping**: Playwright and Puppeteer support for advanced web scraping

## Getting Started

_note: for simple usage use this with [The Agentscan frontend](https://github.com/ExploreLabsxyz/agentscan)_

### Prerequisites

- Node.js (v18.x)
- PostgreSQL (v16 or later)
- Redis
- npm
- Git

### Installation

1. Clone the repository:

```bash
git clone git@github.com:ExploreLabsxyz/agentscan-express.git
cd agentscan-express
```

2. Install dependencies:

```bash
npm install
```

3. Copy the environment variables:

```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`

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
psql -d agentscan_local -f src/db/migrations/0000_tired_gauntlet.sql
```

- View database with Drizzle Studio:

```bash
npm run db:studio
```

### Database Seeding

The project includes functionality to export current database data and seed a local database. This is useful for development and testing purposes.

#### Export Current Data

To export the current state of your database to a seed file:

```bash
npm run db:export-seed
# or
node src/db/seed/seed.ts export
```

This will create a `seed-data.json` file in the `src/db/seed` directory containing your current database state.

#### Seed the Database

To populate your local database with the exported seed data:

```bash
npm run db:seed
# or
node src/db/seed/seed.ts seed
```

Note: Seeding operations will only work when `USE_LOCAL_DB=true` is set in your environment variables. This is a safety measure to prevent accidental modifications to production databases.

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

## Development

### Available Scripts

- `npm run dev` - Start the development server with hot reload
- `npm start` - Start the production server
- `npm run build` - Build the TypeScript project
- `npm run db:generate` - Generate database migrations
- `npm run db:push` - Push database schema changes
- `npm run db:studio` - Launch Drizzle Studio for database management
- `npm run db:export-seed` - Export current database state
- `npm run db:seed` - Seed the database with exported data

### Project Structure

```
src/
├── db/              # Database configuration and migrations
├── services/        # Core services and business logic
├── routes/          # API routes and controllers
├── middleware/      # Express middleware
├── utils/           # Utility functions and helpers
|── types/           # TypeScript type definitions
|-- initalizers/     # Initialize provider services (postgres, redis etc)
```

## Production deployment

For production deployment using Docker, you'll need to configure the following environment variables:

| Category                   | Variable            | Description                                | Required |
| -------------------------- | ------------------- | ------------------------------------------ | -------- |
| **App Configuration**      |
|                            | PORT                | Backend server port                        | Yes      |
| **Database Configuration** |
|                            | POSTGRES_USER       | Database username                          | Yes      |
|                            | POSTGRES_HOST       | Database host address                      | Yes      |
|                            | POSTGRES_DB         | Database name                              | Yes      |
|                            | POSTGRES_PASSWORD   | Database password                          | Yes      |
|                            | POSTGRES_PORT       | Database port                              | Yes      |
|                            | POSTGRES_SSL        | Enable/disable SSL for database connection | Yes      |
|                            | USE_LOCAL_DB        | Use local database                         | Yes      |
| **OLAS Database**          |
|                            | OLAS_DB_USER        | OLAS database username                     | Yes      |
|                            | OLAS_DB_HOST        | OLAS database host                         | Yes      |
|                            | OLAS_DB_PORT        | OLAS database port                         | Yes      |
|                            | OLAS_DB_NAME        | OLAS database name                         | Yes      |
|                            | OLAS_DB_PASSWORD    | OLAS database password                     | Yes      |
|                            | OLAS_DB_SSL         | Enable SSL for OLAS database               | Yes      |
|                            | OLAS_SCHEMA_ID      | Schema generated by ponder service         | Yes      |

| **Cache Configuration**    |
|                            | REDIS_URL           | Redis connection URL                       | Yes      |
| **External Services**      |
|                            | ANTHROPIC_API_KEY   | Anthropic API authentication               | Yes      |
|                            | OPEN_API_KEY        | OpenAI API authentication                  | Yes      |
|                            | GITHUB_ACCESS_TOKEN | GitHub API access token                    | Yes      |
|                            | YOUTUBE_API_KEY     | YouTube API key                            | Yes      |
| **Authentication**         |
|                            | PRIVY_APP_ID        | Privy application ID                       | Yes      |
|                            | PRIVY_APP_SECRET    | Privy application secret                   | Yes      |
| **Bot Integration**        |
|                            | DISCORD_BOT_TOKEN   | Discord bot authentication token           | No       |
|                            | TELEGRAM_BOT_TOKEN  | Telegram bot authentication token          | No       |

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
