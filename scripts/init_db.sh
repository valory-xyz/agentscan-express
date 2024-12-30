#!/bin/bash

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '#' | xargs)
else
    echo "Error: .env file not found"
    exit 1
fi

SCHEMA_FILE="schema.sql"
TEST_DB="${POSTGRES_DB}_test"
TEST_ENV_FILE=".env.test"

# Drop test database if it exists
psql \
    -h localhost \
    -U $POSTGRES_USER \
    -p $POSTGRES_PORT \
    -c "DROP DATABASE IF EXISTS $TEST_DB;" 

# Create fresh test database
psql \
    -h localhost \
    -U $POSTGRES_USER \
    -p $POSTGRES_PORT \
    -c "CREATE DATABASE $TEST_DB;"

# Initialize pgvector extension BEFORE applying schema
psql \
    -h localhost \
    -U $POSTGRES_USER \
    -d $TEST_DB \
    -p $POSTGRES_PORT \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Apply schema to test database
psql \
    -h localhost \
    -U $POSTGRES_USER \
    -d $TEST_DB \
    -p $POSTGRES_PORT \
    -f $SCHEMA_FILE

# Generate test environment variables
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