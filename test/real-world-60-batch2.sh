#!/usr/bin/env bash
set -u

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="${MCP_UPLIFT_REPORT:-$PROJECT/compatibility-60-results.txt}"
TARGET="${1:-30}"
OFFSET=30
CUTOFF_MS=1785196800000
ROOT="$(mktemp -d /tmp/mcp-uplift-30.XXXXXX)"
PASS=0; FAIL=0; CONFIG=0; NOT_FOUND=0

cleanup() {
  pkill -P $$ 2>/dev/null || true
  rm -rf -- "$ROOT"
}
trap cleanup EXIT INT TERM
cd "$PROJECT" || exit 1
touch "$REPORT"
echo | tee -a "$REPORT"
echo "######## DISTINCT PACKAGE BATCH 2 (31-60) ########" | tee -a "$REPORT"

# Candidate pool: established official and community stdio MCP packages.
# A package is executed only if npm confirms both a CLI bin and a pre-v2 release.
PACKAGES=(
  "@modelcontextprotocol/server-filesystem"
  "@modelcontextprotocol/server-memory"
  "@modelcontextprotocol/server-sequential-thinking"
  "@modelcontextprotocol/server-everything"
  "@modelcontextprotocol/server-puppeteer"
  "@modelcontextprotocol/server-brave-search"
  "@modelcontextprotocol/server-slack"
  "@modelcontextprotocol/server-github"
  "@modelcontextprotocol/server-postgres"
  "@modelcontextprotocol/server-google-maps"
  "@modelcontextprotocol/server-gdrive"
  "@upstash/context7-mcp"
  "@playwright/mcp"
  "@executeautomation/playwright-mcp-server"
  "@browserbasehq/mcp-server-browserbase"
  "@notionhq/notion-mcp-server"
  "@supabase/mcp-server-supabase"
  "@wonderwhy-er/desktop-commander"
  "@21st-dev/magic"
  "@cyanheads/git-mcp-server"
  "mcp-sqlite"
  "sqlite-mcp-server"
  "chrome-devtools-mcp"
  "server-perplexity-ask"
  "mcp-server-fetch"
  "mcp-server-git"
  "mcp-server-time"
  "mcp-server-memory"
  "mcp-server-filesystem"
  "slack-mcp-server"
  "github-mcp-server"
  "postgres-mcp"
  "mongodb-mcp-server"
  "redis-mcp-server"
  "mysql-mcp-server"
  "puppeteer-mcp-server"
  "playwright-mcp"
  "filesystem-mcp-server"
  "fetch-mcp"
  "git-mcp-server"
  "youtube-mcp-server"
  "google-maps-mcp-server"
  "notion-mcp-server"
  "linear-mcp-server"
  "jira-mcp"
  "confluence-mcp"
  "docker-mcp"
  "kubernetes-mcp-server"
)

# Batch 2 overrides the batch-1 pool above so no package is repeated.
PACKAGES=(
  "@anaisbetts/mcp-installer"
  "@antv/mcp-server-chart"
  "@automatalabs/mcp-server-playwright"
  "@awkoy/replicate-flux-mcp"
  "@backendkit-labs/mcp-server"
  "@brightdata/mcp"
  "@browsermcp/mcp"
  "@chargebee/mcp"
  "@contextstream/mcp-server"
  "@demotime/mcp"
  "@e2b/mcp-server"
  "@exa-labs/exa-mcp-server"
  "@executeautomation/database-server"
  "@executeautomation/mcp-playwright"
  "@firecrawl/mcp-server-firecrawl"
  "@grafana/mcp-grafana"
  "@hyperbrowser/mcp"
  "@j0hanz/fetch-url-mcp"
  "@jetbrains/mcp-proxy"
  "@mendable/firecrawl-mcp-server"
  "@modelcontextprotocol/server-aws-kb-retrieval"
  "@modelcontextprotocol/server-sentry"
  "@modelcontextprotocol/server-raygun"
  "@modelcontextprotocol/server-redis"
  "@modelcontextprotocol/server-sqlite"
  "@neondatabase/mcp-server-neon"
  "@octomind/octomind-mcp"
  "@openbnb/mcp-server-airbnb"
  "@pab1it0/prometheus-mcp-server"
  "@pinecone-database/mcp"
  "@public-ui/mcp"
  "@redis/mcp-server"
  "@sentry/mcp-server"
  "@smithery/cli"
  "@stackguide/mcp-server"
  "@stripe/mcp"
  "@tinybirdco/mcp-tinybird"
  "@vercel/mcp-adapter"
  "@zilliz/mcp-server-milvus"
  "airtable-mcp-server"
  "browser-tools-mcp"
  "convex-mcp-server"
  "duckdb-mcp-server"
  "figma-developer-mcp"
  "kubeview-mcp"
  "mcp-server-docker"
  "mcp-server-kubernetes"
  "mcp-server-qdrant"
  "obsidian-mcp-server"
  "todoist-mcp-server"
)

patch -p0 -d "$ROOT" <<'DRIVER'
--- /dev/null
+++ probe.mjs
@@ -0,0 +1,82 @@
+import { spawn } from 'node:child_process';
+import { createInterface } from 'node:readline';
+
+const command = JSON.parse(process.env.PROBE_COMMAND);
+const timeout = Number(process.env.PROBE_TIMEOUT || 30000);
+const child = spawn(process.execPath, ['src/cli.js', '--env', 'npm_config_cache', '--', ...command], {
+  cwd: process.env.PROJECT,
+  env: {
+    PATH: process.env.PATH,
+    HOME: process.env.PROBE_HOME,
+    npm_config_cache: process.env.PROBE_CACHE,
+    NO_COLOR: '1',
+  },
+  stdio: ['pipe', 'pipe', 'pipe'],
+});
+const rl = createInterface({ input: child.stdout });
+const pending = new Map();
+let stderr = '';
+child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
+rl.on('line', line => {
+  try {
+    const message = JSON.parse(line);
+    pending.get(message.id)?.(message);
+  } catch {}
+});
+
+let id = 0;
+function request(method, params = {}) {
+  const requestId = ++id;
+  const body = {
+    jsonrpc: '2.0', id: requestId, method,
+    params: {
+      ...params,
+      _meta: {
+        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
+        'io.modelcontextprotocol/clientInfo': { name: 'uplift-probe', version: '1' },
+        'io.modelcontextprotocol/clientCapabilities': { roots: {} },
+      },
+    },
+  };
+  return new Promise((resolve, reject) => {
+    const timer = setTimeout(() => reject(new Error('timeout')), timeout);
+    pending.set(requestId, response => {
+      clearTimeout(timer); pending.delete(requestId); resolve(response);
+    });
+    child.stdin.write(JSON.stringify(body) + '\n');
+  });
+}
+
+async function settle(method, params = {}) {
+  let response = await request(method, params);
+  if (response.result?.resultType === 'input_required') {
+    const answers = Object.fromEntries(Object.entries(response.result.inputRequests).map(([key, input]) => {
+      if (input.method !== 'roots/list') throw new Error('CONFIG_REQUIRED:' + input.method);
+      return [key, {
+        roots: [{ uri: 'file://' + process.env.PROBE_WORK, name: 'isolated-test' }],
+      }];
+    }));
+    response = await request(method, {
+      ...params, requestState: response.result.requestState, inputResponses: answers,
+    });
+  }
+  return response;
+}
+
+try {
+  const discover = await settle('server/discover');
+  if (!discover.result?._meta?.['io.modelcontextprotocol/serverInfo']) throw new Error('discover rejected');
+  const list = await settle('tools/list');
+  if (list.error) throw new Error('tools/list:' + list.error.message);
+  if (!Array.isArray(list.result?.tools)) throw new Error('tools array missing');
+  if (list.result.resultType !== 'complete') throw new Error('resultType missing');
+  console.log(JSON.stringify({ status: 'PASS',
+    upstream: discover.result._meta['io.modelcontextprotocol/serverInfo'].upstream,
+    tools: list.result.tools.length }));
+  child.stdin.end();
+} catch (error) {
+  const kind = error.message.startsWith('CONFIG_REQUIRED:') ? 'CONFIG_REQUIRED' : 'FAIL';
+  console.log(JSON.stringify({ status: kind, error: error.message, stderr: stderr.slice(-500) }));
+  child.kill();
+  process.exitCode = kind === 'FAIL' ? 1 : 2;
+}
+await new Promise(resolve => child.exitCode !== null ? resolve() : child.on('close', resolve));
DRIVER

legacy_version() {
  local pkg="$1" cache="$2"
  npm_config_cache="$cache" npm view "$pkg" time bin --json 2>/dev/null |
    node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try {
          const x=JSON.parse(s), t=x.time||{}, cutoff=Number(process.argv[1]);
          if (!x.bin || (typeof x.bin==="object" && !Object.keys(x.bin).length)) return;
          const versions=Object.entries(t)
            .filter(([v,d])=>!["created","modified"].includes(v)&&Date.parse(d)<cutoff)
            .sort((a,b)=>Date.parse(b[1])-Date.parse(a[1]));
          if (versions[0]) process.stdout.write(versions[0][0]);
        } catch {}
      });' "$CUTOFF_MS"
}

tested=0
for pkg in "${PACKAGES[@]}"; do
  (( tested >= TARGET )) && break
  slug="$(printf '%s' "$pkg" | tr -cs 'A-Za-z0-9' '_')"
  case_dir="$ROOT/$slug"
  cache="$case_dir/cache"; home="$case_dir/home"; work="$case_dir/work"
  mkdir -p "$cache" "$home" "$work"

  version="$(legacy_version "$pkg" "$cache")"
  if [[ -z "$version" ]]; then
    echo "NOT_TESTED $pkg: no executable pre-v2 release" | tee -a "$REPORT"
    NOT_FOUND=$((NOT_FOUND + 1))
    rm -rf -- "$case_dir"
    continue
  fi

  tested=$((tested + 1))
  echo "===== $((OFFSET + tested))/$((OFFSET + TARGET)) $pkg@$version =====" | tee -a "$REPORT"
  extra='[]'
  [[ "$pkg" == "@modelcontextprotocol/server-filesystem" ]] && extra='["__WORK__"]'
  [[ "$pkg" == "mcp-sqlite" ]] && extra='["__WORK__/test.sqlite"]'
  extra="${extra//__WORK__/$work}"
  command="$(node -e '
    const [p,v,a]=process.argv.slice(1);
    console.log(JSON.stringify(["npx","-y",p+"@"+v,...JSON.parse(a)]));
  ' "$pkg" "$version" "$extra")"

  output="$(PROJECT="$PROJECT" PROBE_COMMAND="$command" PROBE_HOME="$home"     PROBE_CACHE="$cache" PROBE_WORK="$work" PROBE_TIMEOUT=30000     timeout --signal=TERM --kill-after=5s 90s node "$ROOT/probe.mjs" 2>&1)"
  code=$?
  echo "$output" | tee -a "$REPORT"

  if echo "$output" | grep -q '"status":"PASS"'; then
    PASS=$((PASS + 1))
  elif echo "$output" | grep -q '"status":"CONFIG_REQUIRED"' || echo "$output" | grep -Eqi 'API[_ -]?KEY|TOKEN|credentials|access.token|required environment|provide a .*url|authentication'; then
    CONFIG=$((CONFIG + 1))
  else
    FAIL=$((FAIL + 1))
  fi
  echo "exit=$code; deleted cache and workspace" | tee -a "$REPORT"
  rm -rf -- "$case_dir"
done

echo "===== BATCH 2 SUMMARY =====" | tee -a "$REPORT"
echo "BATCH2_DISTINCT_TESTED=$tested PASS=$PASS CONFIG_REQUIRED=$CONFIG FAIL=$FAIL" | tee -a "$REPORT"
echo "CANDIDATES_REJECTED=$NOT_FOUND" | tee -a "$REPORT"
echo "All downloaded caches and workspaces deleted." | tee -a "$REPORT"
echo "Report: $REPORT" | tee -a "$REPORT"

[[ "$tested" -eq "$TARGET" ]] && [[ "$FAIL" -eq 0 ]]
