#!/bin/bash

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
else
    echo "Error: .env file not found"
    exit 1
fi

# Use environment variables for database connection
OUTPUT_FILE="schema.sql"

echo "Attempting to dump complete database: $POSTGRES_DB"
echo "Host: $POSTGRES_HOST"
echo "User: $POSTGRES_USER"
echo "Port: $POSTGRES_PORT"

# Add version check before dump
PG_SERVER_VERSION=$(PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DB -p $POSTGRES_PORT -t -c "SELECT version();" | grep -oE '[0-9]+\.[0-9]+' | head -n1)
PG_DUMP_VERSION=$(pg_dump --version | grep -oE '[0-9]+\.[0-9]+')

echo "PostgreSQL Server version: $PG_SERVER_VERSION"
echo "pg_dump version: $PG_DUMP_VERSION"

# Reverse the comparison logic since we want to ensure pg_dump version is NOT newer
if [ "$(printf '%s\n' "$PG_SERVER_VERSION" "$PG_DUMP_VERSION" | sort -V | head -n1)" != "$PG_SERVER_VERSION" ]; then
    echo "Warning: pg_dump version ($PG_DUMP_VERSION) is newer than server version ($PG_SERVER_VERSION)"
    echo "This might cause compatibility issues. Consider downgrading PostgreSQL tools or upgrading the server"
    echo "On macOS, you can install a specific version using: brew install postgresql@16.3"
    exit 1
fi

# Dump complete database (schema and data)
PGPASSWORD=$POSTGRES_PASSWORD pg_dump \
    -h $POSTGRES_HOST \
    -U $POSTGRES_USER \
    -d $POSTGRES_DB \
    -p $POSTGRES_PORT \
    --no-owner \
 \
    > $OUTPUT_FILE

if [ $? -eq 0 ] && [ -s "$OUTPUT_FILE" ]; then
    echo "Database successfully dumped to $OUTPUT_FILE"
    echo "File size: $(wc -c < "$OUTPUT_FILE") bytes"
else
    echo "Error: Failed to dump database or file is empty"
    echo "pg_dump exit code: $?"
    # Try running with verbose output on error
    PGPASSWORD=$POSTGRES_PASSWORD pg_dump \
        -h $POSTGRES_HOST \
        -U $POSTGRES_USER \
        -d $POSTGRES_DB \
        -p $POSTGRES_PORT \
        --no-owner \
         \
        --verbose
    exit 1
fi