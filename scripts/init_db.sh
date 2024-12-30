#!/bin/bash

# Install PostgreSQL 16 if not already installed
echo "Checking PostgreSQL installation..."
brew install postgresql@16 || true

# Load environment variables with required defaults
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
else
    echo "Error: .env file not found"
    exit 1
fi


: "${POSTGRES_USER:=$(whoami)}"
: "${POSTGRES_HOST:=localhost}"
: "${POSTGRES_DB:=postgres}"
: "${POSTGRES_PASSWORD:=}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_SSL:=false}"

# Ensure PostgreSQL is running (macOS version)
echo "Ensuring PostgreSQL is running..."
if brew services list | grep postgresql@16 >/dev/null; then
    brew services start postgresql@16
else
    brew services start postgresql
fi

# Clean up any existing pgvector directory
rm -rf /tmp/pgvector

# Initialize the database cluster if needed and create initial user
echo "Initializing database and creating system user..."
initdb_path=$(brew --prefix)/opt/postgresql@16/bin/initdb
data_path=$(brew --prefix)/var/postgresql@16

if [ ! -d "$data_path" ]; then
    $initdb_path "$data_path"
fi

# Create system user first (this is your macOS username)
createuser -s $(whoami) || true

# Now create postgres superuser
echo "Creating postgres role..."
psql postgres -U $(whoami) -c "CREATE USER postgres SUPERUSER PASSWORD '';" 2>/dev/null || true
psql postgres -U $(whoami) -c "ALTER USER postgres WITH SUPERUSER PASSWORD '';" 2>/dev/null || true

# Ensure the postgres user exists and has proper permissions
psql postgres -U $(whoami) -c "CREATE USER postgres WITH SUPERUSER PASSWORD '';" 2>/dev/null || true
psql postgres -U $(whoami) -c "ALTER USER postgres WITH SUPERUSER PASSWORD '';" 2>/dev/null || true

# Store the original directory
ORIGINAL_DIR=$(pwd)

# More robust pgvector detection
echo "Checking pgvector installation..."
if ! psql -U $(whoami) -d postgres -c "SELECT * FROM pg_extension WHERE extname = 'vector';" | grep -q vector; then
    echo "Installing pgvector extension..."
    cd /tmp
    rm -rf pgvector  # Ensure clean state
    git clone --branch v0.6.2 https://github.com/pgvector/pgvector.git
    cd pgvector
    make clean  # Clean before building
    make
    # Skip make check on macOS as it's not supported
    if [[ "$OSTYPE" != "darwin"* ]]; then
        make check
    fi
    sudo make install
    
    # Attempt to create extension immediately after installation
    psql -U $(whoami) -d postgres -c "CREATE EXTENSION IF NOT EXISTS vector;"
    
    # Verify installation
    if ! psql -U $(whoami) -d postgres -c "SELECT * FROM pg_extension WHERE extname = 'vector';" | grep -q vector; then
        echo "Failed to install pgvector. Please check PostgreSQL logs for details."
        exit 1
    fi
    
    # Return to original directory after pgvector installation
    cd "$ORIGINAL_DIR"
else
    echo "pgvector extension is already installed"
fi

# Improve directory navigation - use absolute paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SCHEMA_FILE="${ROOT_DIR}/schema.sql"
TEST_DB="${POSTGRES_DB}_test"
TEST_ENV_FILE="${ROOT_DIR}/.env.test"

echo "Root directory: $ROOT_DIR"
echo "Schema file: $SCHEMA_FILE"
echo "Test database: $TEST_DB"
echo "Test environment file: $TEST_ENV_FILE"

# Add debug information
echo "Checking for schema file..."
echo "Current working directory: $(pwd)"
echo "Looking for schema at: $SCHEMA_FILE"
if [ -f "$SCHEMA_FILE" ]; then
    echo "Found schema file!"
else
    echo "Schema file not found. Checking directory contents:"
    ls -la "$ROOT_DIR"
fi

# Check if schema file exists
if [ ! -f "$SCHEMA_FILE" ]; then
    echo "Error: schema.sql not found at $SCHEMA_FILE"
    echo "Please create a schema.sql file in the root directory"
    exit 1
fi

# Drop test database if it exists
psql \
    -h localhost \
    -U $(whoami) \
    -p $POSTGRES_PORT \
    -c "DROP DATABASE IF EXISTS $TEST_DB;" 

# Create fresh test database
psql \
    -h localhost \
    -U $(whoami) \
    -p $POSTGRES_PORT \
    -c "CREATE DATABASE $TEST_DB;"

# More explicit pgvector extension creation for main database
echo "Initializing pgvector extension in main database..."
psql \
    -h localhost \
    -U $(whoami) \
    -d $POSTGRES_DB \
    -p $POSTGRES_PORT \
    -c "DROP EXTENSION IF EXISTS vector;" \
    -c "CREATE EXTENSION vector;"

# More explicit pgvector extension creation for test database
echo "Initializing pgvector extension in test database..."
psql \
    -h localhost \
    -U $(whoami) \
    -d $TEST_DB \
    -p $POSTGRES_PORT \
    -c "DROP EXTENSION IF EXISTS vector;" \
    -c "CREATE EXTENSION vector;"

# Apply schema to test database
psql \
    -h localhost \
    -U $(whoami) \
    -d $TEST_DB \
    -p $POSTGRES_PORT \
    -f $SCHEMA_FILE

# Generate test environment variables with all required fields
cat > $TEST_ENV_FILE << EOF
POSTGRES_USER=$POSTGRES_USER
POSTGRES_HOST=localhost
POSTGRES_DB=$TEST_DB
POSTGRES_PASSWORD=
POSTGRES_PORT=$POSTGRES_PORT
POSTGRES_SSL=$POSTGRES_SSL
EOF

echo "Test database '$TEST_DB' initialized successfully"
echo "Test environment variables written to $TEST_ENV_FILE"

# Check current directory
pwd

# List files in current directory to verify schema.sql exists
ls -la

# Print the actual values of the variables
echo "SCRIPT_DIR=$SCRIPT_DIR"
echo "ROOT_DIR=$ROOT_DIR"
echo "SCHEMA_FILE=$SCHEMA_FILE"