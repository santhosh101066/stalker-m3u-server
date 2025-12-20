#!/bin/bash

BASE_URL="http://localhost:3000"
USERNAME="user"
PASSWORD="password"

echo "Testing Xtream Codes API..."

# 1. Test Login
echo "1. Testing Login..."
curl -s "$BASE_URL/player_api.php?username=$USERNAME&password=$PASSWORD" | grep "user_info" && echo "✅ Login Success" || echo "❌ Login Failed"

# 2. Test Live Categories
echo "2. Testing Live Categories..."
curl -s "$BASE_URL/player_api.php?username=$USERNAME&password=$PASSWORD&action=get_live_categories" | grep "category_id" && echo "✅ Live Categories Success" || echo "❌ Live Categories Failed"

# 3. Test Live Streams
echo "3. Testing Live Streams..."
curl -s "$BASE_URL/player_api.php?username=$USERNAME&password=$PASSWORD&action=get_live_streams" | grep "stream_id" && echo "✅ Live Streams Success" || echo "❌ Live Streams Failed"

# 4. Test XMLTV
echo "4. Testing XMLTV..."
curl -s "$BASE_URL/xmltv.php?username=$USERNAME&password=$PASSWORD" | grep "xml" && echo "✅ XMLTV Success" || echo "❌ XMLTV Failed"

echo "Verification Complete."
