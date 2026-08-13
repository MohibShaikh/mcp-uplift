#!/usr/bin/env bash
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORT="${MCP_UPLIFT_REPORT:-$(cd "$HERE/.." && pwd)/compatibility-60-results.txt}"

MCP_UPLIFT_REPORT="$REPORT" bash "$HERE/real-world-60-batch1.sh" 30
first=$?
MCP_UPLIFT_REPORT="$REPORT" bash "$HERE/real-world-60-batch2.sh" 30
second=$?

echo "===== 60-SERVER DRIVER SUMMARY ====="
echo "BATCH1_EXIT=$first BATCH2_EXIT=$second"
echo "Combined report: $REPORT"
exit $(( first != 0 || second != 0 ))
