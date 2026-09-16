#!/bin/sh
# Raw JSON-RPC over stdio — exactly what an MCP client does.
# Ends with close_browser so the server releases the browser and exits cleanly.
DIR=$(cd "$(dirname "$0")/.." && pwd)
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 1
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"open_page","arguments":{"url":"file://'"$DIR"'/test/broken.html","width":390}}}'
  sleep 6
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"audit_design","arguments":{"width":390}}}'
  sleep 4
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"close_browser","arguments":{}}}'
  sleep 2
} | node "$DIR/server.js" 2>/dev/null
