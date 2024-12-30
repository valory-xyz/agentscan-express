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

# Dump complete database (schema and data)
PGPASSWORD=$POSTGRES_PASSWORD pg_dump \
    -h $POSTGRES_HOST \
    -U $POSTGRES_USER \
    -d $POSTGRES_DB \
    -p $POSTGRES_PORT \
    --no-owner \
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
        --verbose
    exit 1
fi