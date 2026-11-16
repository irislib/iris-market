set -euo pipefail
cd web
test "$(node -p process.versions.node)" = '26.12.0'
dir="$RUNNER_TEMP/market-qualify"
node scripts/generate-graph-bootstrap.mjs > "$dir/seed.log" 2>&1
git diff --exit-code -- src/data/social-graph.bin
npm test > "$dir/unit.log" 2>&1
npm run build > "$dir/build.log" 2>&1
npm run test:built-graph > "$dir/built-graph.log" 2>&1
git diff --exit-code -- package.json package-lock.json
tar -czf "$dir/dist.tar.gz" dist
sha256sum "$dir/dist.tar.gz" > "$dir/dist.sha256"
