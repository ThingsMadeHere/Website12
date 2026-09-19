#!/bin/bash

echo "🔍 Scanning for SQLite databases with 'users' tables..."
echo "------------------------------------------------------"

# Find all .db files on the system
find / -name "*.db" -type f 2>/dev/null | while read -r db_file; do
    # Check if the file contains a 'users' table
    if sqlite3 "$db_file" ".tables" 2>/dev/null | grep -qw "users"; then
        echo ""
        echo "✅ Found database: $db_file"
        echo "📋 Users found:"
        
        # Try to extract user info (handles both old and new schemas)
        sqlite3 "$db_file" "SELECT 'Username: ' || COALESCE(username, email) || ' | Admin: ' || COALESCE(admin, role) FROM users;" 2>/dev/null || \
        sqlite3 "$db_file" "SELECT * FROM users LIMIT 5;" 2>/dev/null
        
        echo "------------------------------------------------------"
    fi
done

echo "Scan complete."
