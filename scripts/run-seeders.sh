#!/bin/sh
# Run all seed scripts against the local Redis REST proxy.
# Usage: ./scripts/run-seeders.sh
#
# Requires the worldmonitor stack to be running (uvx podman-compose up -d).
# The Redis REST proxy listens on localhost:8079 by default.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load REDIS_TOKEN (and any seeder API keys present) from .env so the
# host-side seeders can talk to the REST proxy with the same bearer the
# compose stack is using. Defaults removed in #3804 — the seeders fail-loud
# if REDIS_TOKEN is not in the environment or .env.
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
# This script targets the LOCAL Docker REST proxy, so REDIS_TOKEN always
# wins if set — even when UPSTASH_REDIS_REST_TOKEN also appears in .env
# (e.g. a contributor who also works on the Vercel/Upstash side and keeps
# the production token in the same file). Otherwise we'd silently send a
# Vercel-Upstash bearer to localhost:8079 and the proxy would 401 the
# request with no hint about why. Reviewer caught this on PR #3829.
if [ -n "${REDIS_TOKEN:-}" ]; then
  UPSTASH_REDIS_REST_TOKEN="$REDIS_TOKEN"
fi
if [ -z "${UPSTASH_REDIS_REST_TOKEN:-}" ]; then
  echo "ERROR: REDIS_TOKEN (or UPSTASH_REDIS_REST_TOKEN) is required." >&2
  echo "       Generate with: openssl rand -hex 32, then add to .env" >&2
  echo "       See SELF_HOSTING.md → Required Environment Variables." >&2
  exit 1
fi
export UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

# Source API keys from docker-compose.override.yml if present.
# These keys are configured for the container but seeders run on the host.
OVERRIDE="$PROJECT_DIR/docker-compose.override.yml"
if [ -f "$OVERRIDE" ]; then
  _env_tmp=$(mktemp)
  grep -E '^\s+[A-Z_]+:' "$OVERRIDE" \
    | grep -v '#' \
    | sed 's/^\s*//' \
    | sed 's/: */=/' \
    | sed "s/[\"']//g" \
    | grep -E '^(NASA_FIRMS|GROQ|AISSTREAM|FRED|FINNHUB|EIA|ACLED_ACCESS_TOKEN|ACLED_EMAIL|ACLED_PASSWORD|CLOUDFLARE|AVIATIONSTACK|OPENAQ_API_KEY|WAQI_API_KEY|OPENROUTER_API_KEY|LLM_API_URL|LLM_API_KEY|LLM_MODEL|OLLAMA_API_URL|OLLAMA_MODEL)' \
    | sed 's/^/export /' > "$_env_tmp"
  . "$_env_tmp"
  rm -f "$_env_tmp"
fi
# Per-seeder wall-clock cap for STANDALONE seeders. They run sequentially, so a
# single upstream that hangs (e.g. a slow NOAA/NSIDC fetch that doesn't honour its
# own AbortSignal and keeps the node process alive for an hour) would burn the rest
# of the window and starve every later seeder — under a wrapping systemd/cron job
# timeout it drops everything after the hung one. Capping each seeder bounds that
# blast radius. Default 1800s (30min): above any standalone seeder's real runtime
# yet below the pathological hangs (60min+), so it kills only runaway runs.
# Override with SEED_TIMEOUT=<seconds>, or SEED_TIMEOUT=0 to disable.
#
# Bundle seeders (seed-bundle-*.mjs) are EXEMPT from this cap: scripts/_bundle-runner.mjs
# already hard-caps every section with its own wall-clock timer (SIGTERM→SIGKILL on
# the section's child PID — immune to the DNS-hang blind spot) and runs sections
# sequentially, so a bundle's *legitimate* total can exceed SEED_TIMEOUT (e.g.
# resilience-recovery's Import-HHI section alone budgets 30min). Wrapping a bundle in
# the outer cap would false-kill it mid-run and orphan the in-flight section child.
SEED_TIMEOUT="${SEED_TIMEOUT:-1800}"

# Resolve once whether the outer cap is usable (timeout(1) present and a positive
# numeric budget). Non-numeric/empty SEED_TIMEOUT → test errors → disabled (plain node).
if command -v timeout >/dev/null 2>&1 && [ "${SEED_TIMEOUT:-0}" -gt 0 ] 2>/dev/null; then
  timeout_enabled=true
else
  timeout_enabled=false
fi

# Bundle seeders self-bound per section — never wrap them in the outer cap.
is_bundle() {
  case "$1" in
    *seed-bundle-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Whether THIS seeder is wrapped by the outer timeout.
caps_seed() {
  [ "$timeout_enabled" = true ] && ! is_bundle "$1"
}

run_seed() {
  if caps_seed "$1"; then
    # -k: if it ignores SIGTERM, SIGKILL it 30s later so the run can move on.
    timeout -k 30 "$SEED_TIMEOUT" node "$1" 2>&1
  else
    node "$1" 2>&1
  fi
}

ok=0 fail=0 skip=0 timedout=0

# Diagnostics for non-OK seeders. Previously only `tail -1` of a seeder's output
# survived, which threw away the script's own "FETCH FAILED: …" and per-endpoint
# lines and made every failure look identical in the timer logs — the aviation
# seeder had been failing 100% of runs for a week with its real cause (an
# AviationStack HTTP 429 quota wall) invisible. GH #262.
#
# The one-line "FAIL (…)" summary below is deliberately unchanged so anything
# already parsing this output keeps working; the full text is additive.
FAIL_TAIL_LINES="${FAIL_TAIL_LINES:-25}"
SEED_LOG_DIR="${SEED_LOG_DIR:-$PROJECT_DIR/logs}"
if mkdir -p "$SEED_LOG_DIR" 2>/dev/null; then
  RUN_LOG="$SEED_LOG_DIR/seeders-$(date -u +%Y%m%dT%H%M%SZ).log"
  # `touch`, not `: >` — see the note on mark_attempt(): a redirection failure on
  # the special builtin `:` exits the shell outright, so an unwritable log dir
  # would abort the entire seeding run instead of just disabling diagnostics.
  touch "$RUN_LOG" 2>/dev/null || RUN_LOG=""
  # Diagnostics, not durable data — two weeks is plenty and bounds the growth.
  find "$SEED_LOG_DIR" -maxdepth 1 -name 'seeders-*.log' -mtime +14 -delete 2>/dev/null || true
else
  RUN_LOG=""
fi

# Per-seeder minimum interval. GH #262.
#
# The timer fires this whole script every 30 min, which is right for most feeds
# but badly wrong for the two Open-Meteo ERA5 climate seeders. seed-climate-
# zone-normals writes a 95-day TTL and its own source comment says the cadence
# is "a 31-day monthly interval" — running it 48x/day is ~1400x its design rate.
# seed-climate-anomalies writes a 9h TTL, so 48x/day is ~18x oversampled.
# Between them they burned the shared free-tier Open-Meteo daily allowance, and
# the archive API then returned a flat "Daily API request limit exceeded" to
# every request — which looked like an upstream outage but was self-inflicted.
# Confirmed by hand: archive-api 429 "Daily API request limit exceeded" while
# the separately-pooled forecast API answered 200 from the same WAN IP.
#
# The stamp is written on ATTEMPT, not on success. If it only counted successes,
# a seeder failing because the quota is already spent would retry every 30 min
# and keep the quota spent — exactly the loop this exists to break. Cost: a
# transient failure waits a full interval to retry, which is fine for data whose
# TTL is 9h/95d.
SEED_STATE_DIR="${SEED_STATE_DIR:-$SEED_LOG_DIR/.state}"
mkdir -p "$SEED_STATE_DIR" 2>/dev/null || SEED_STATE_DIR=""
ZONE_NORMALS_MIN_INTERVAL="${ZONE_NORMALS_MIN_INTERVAL:-2592000}"   # 30d
CLIMATE_ANOMALIES_MIN_INTERVAL="${CLIMATE_ANOMALIES_MIN_INTERVAL:-21600}"  # 6h
AVIATION_INTL_MIN_INTERVAL="${AVIATION_INTL_MIN_INTERVAL:-21600}"  # 6h
BUNDLE_CLIMATE_MIN_INTERVAL="${BUNDLE_CLIMATE_MIN_INTERVAL:-21600}"  # 6h

# 0 (true) = ran more recently than $2 seconds ago, so skip this pass.
too_soon() {
  [ -n "$SEED_STATE_DIR" ] || return 1
  _ts_file="$SEED_STATE_DIR/$1.stamp"
  [ -f "$_ts_file" ] || return 1
  _ts_then=$(stat -c %Y "$_ts_file" 2>/dev/null) || return 1
  [ -n "$_ts_then" ] || return 1
  _ts_age=$(( $(date +%s) - _ts_then ))
  [ "$_ts_age" -lt "$2" ]
}

# NB: `touch`, not `: > file`. `:` is a POSIX *special builtin*, and a redirection
# failure on a special builtin makes the shell EXIT — `2>/dev/null || true` cannot
# catch it, because the shell is gone before the || is reached. With `: >` here, a
# state dir that had vanished or turned unwritable mid-run aborted the whole
# seeding run at the first gated seeder and took ~100 healthy seeders with it
# (observed for real: "can't create …/seed-climate-anomalies.mjs.stamp:
# nonexistent directory", service exit 1). Stamping is best-effort bookkeeping and
# must never be able to end the run — worst case the gate just doesn't engage.
mark_attempt() {
  [ -n "$SEED_STATE_DIR" ] || return 0
  mkdir -p "$SEED_STATE_DIR" 2>/dev/null || return 0
  touch "$SEED_STATE_DIR/$1.stamp" 2>/dev/null || true
  return 0
}

# Whole hours remaining, for the SKIP line. Floor, so "0h" means "under an hour".
hours_left() {
  _hl_file="$SEED_STATE_DIR/$1.stamp"
  _hl_then=$(stat -c %Y "$_hl_file" 2>/dev/null || echo 0)
  echo $(( ($2 - ( $(date +%s) - _hl_then )) / 3600 ))
}

# Full output to the run log; the tail to stderr so `journalctl -u worldmonitor-seed`
# shows the actual error instead of one truncated line.
record_failure() {
  _rf_name="$1"; _rf_status="$2"; _rf_output="$3"
  if [ -n "$RUN_LOG" ]; then
    {
      printf '===== %s — %s =====\n' "$_rf_name" "$_rf_status"
      printf '%s\n\n' "$_rf_output"
    } >> "$RUN_LOG"
  fi
  # Built with %s rather than inlined in the format: this script runs under dash
  # (#!/bin/sh), whose printf treats a format string starting with "--" as an
  # option and errors out with "Illegal option --".
  printf '%s\n' "--- $_rf_name $_rf_status — last $FAIL_TAIL_LINES line(s) ---" >&2
  printf '%s\n' "$_rf_output" | tail -n "$FAIL_TAIL_LINES" >&2
}

for f in "$SCRIPT_DIR"/seed-*.mjs; do
  name="$(basename "$f")"
  aviation_gated=0
  printf "→ %s ... " "$name"
  # Homelab skips — sources that cannot succeed here, so they don't log as FAIL:
  # consumer-prices is a manual fallback (hard-requires --force; the authoritative
  # writer is the private consumer-prices-core cloud pipeline); iran-events reads
  # a manually-dropped LiveUAMap scrape that only sometimes exists.
  case "$name" in
    seed-consumer-prices.mjs)
      printf "SKIP (manual-fallback script; cloud pipeline is authoritative)\n"
      skip=$((skip + 1)); continue ;;
    seed-iran-events.mjs)
      if [ ! -f "$SCRIPT_DIR/data/iran-events-latest.json" ]; then
        printf "SKIP (manual data file scripts/data/iran-events-latest.json absent)\n"
        skip=$((skip + 1)); continue
      fi ;;
    seed-aviation.mjs)
      # Gate ONLY the paid AviationStack section. GH #262.
      #
      # seed-aviation does four things; three of them (FAA delays, NOTAM news,
      # the 130-airport bootstrap) succeed on every tick and are worth their
      # 30min cadence. Only the intl section calls AviationStack — 52 airports a
      # tick, ~2,500 calls/day, all of it 429 "usage_limit_reached" against a
      # plan that cannot absorb it.
      #
      # The seeder has its own INTL_MIN_REFRESH_MIN floor, but it keys off the
      # last SUCCESSFUL publish (deliberately, so a transient outage still
      # retries) — which means a quota wall retries every tick forever and keeps
      # the quota spent. Its cap is 60min anyway, too low to matter here.
      #
      # So gate at the wrapper, and gate the paid part only: on a non-due tick
      # run the seeder with AVIATIONSTACK_API unset. The free side-cars (FAA,
      # NOTAM, news, bootstrap) still run and write on every tick; the intl
      # section skips its fetch ("[Intl] No AVIATIONSTACK_API key — skipping",
      # seed-aviation.mjs:474) but then graceful-fails the run, because
      # fetchIntl treats a keyless intl as unpublishable and runSeed exits
      # with the graceful-failure code. That exit is INDUCED BY THIS GATE, so
      # the classifier below reclassifies exactly that signature as OK instead
      # of logging ~44 false FAILs/day. Unsetting is safe for the rest of this
      # run — nothing else reads that var, and each timer run re-sources .env.
      if too_soon "$name" "$AVIATION_INTL_MIN_INTERVAL"; then
        printf "[intl gated ~%sh] " "$(hours_left "$name" "$AVIATION_INTL_MIN_INTERVAL")"
        unset AVIATIONSTACK_API
        aviation_gated=1
      else
        mark_attempt "$name"
      fi ;;
    seed-bundle-climate.mjs)
      # The bundle re-invokes the SAME Open-Meteo seeders gated below, but its
      # gate is success-keyed (seed-meta freshness read by _bundle-runner.mjs) —
      # so a child that fails BECAUSE the daily quota is spent is "due" again on
      # every 30-min tick. That kept the archive quota permanently exhausted and
      # made the two direct gates below cosmetic (verified 2026-08-05, GH #262).
      # Same attempt-keyed stamp as the direct gates. 6h = the smallest child
      # cadence NOT already covered by a direct gate (Disasters, 6h); Ocean-Ice
      # (1d) and CO2 (3d) tolerate up to +6h latency; Anomalies (3h) and
      # Zone-Normals (30d) are the direct-gated duplicates this exists to stop.
      if too_soon "$name" "$BUNDLE_CLIMATE_MIN_INTERVAL"; then
        printf "SKIP (interval gate: ~%sh until next run; children success-keyed, see GH #262)\n" \
          "$(hours_left "$name" "$BUNDLE_CLIMATE_MIN_INTERVAL")"
        skip=$((skip + 1)); continue
      fi
      mark_attempt "$name" ;;
    seed-climate-zone-normals.mjs)
      if too_soon "$name" "$ZONE_NORMALS_MIN_INTERVAL"; then
        printf "SKIP (interval gate: ~%sh until next run; 95-day TTL, monthly by design)\n" \
          "$(hours_left "$name" "$ZONE_NORMALS_MIN_INTERVAL")"
        skip=$((skip + 1)); continue
      fi
      mark_attempt "$name" ;;
    seed-climate-anomalies.mjs)
      if too_soon "$name" "$CLIMATE_ANOMALIES_MIN_INTERVAL"; then
        printf "SKIP (interval gate: ~%sh until next run; 9h TTL)\n" \
          "$(hours_left "$name" "$CLIMATE_ANOMALIES_MIN_INTERVAL")"
        skip=$((skip + 1)); continue
      fi
      mark_attempt "$name" ;;
    seed-bundle-resilience-validation.mjs)
      # Its Sensitivity-Suite child imports ../server/*.ts — plain node can't
      # resolve those; upstream's Dockerfile.seed-bundle-resilience-validation
      # wires the tsx ESM loader the same way.
      output=$(NODE_OPTIONS="${NODE_OPTIONS:-} --import=file://$PROJECT_DIR/node_modules/tsx/dist/loader.mjs" run_seed "$f")
      rc=$?
      last=$(echo "$output" | tail -1)
      if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
        printf "SKIP (%s)\n" "$last"; skip=$((skip + 1))
      elif [ $rc -eq 0 ]; then
        printf "OK\n"; ok=$((ok + 1))
      else
        printf "FAIL (%s)\n" "$last"; fail=$((fail + 1))
        record_failure "$name" FAIL "$output"
      fi
      continue ;;
  esac
  output=$(run_seed "$f")
  rc=$?
  last=$(echo "$output" | tail -1)

  # timeout(1) exits 124 when it had to terminate the child, or 128+signal
  # (137 = SIGKILL after the -k grace) when SIGTERM was ignored. Only trust this
  # classification for seeders we actually wrapped (bundles run unwrapped).
  if caps_seed "$f" && { [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; }; then
    printf "TIMEOUT (killed after %ss)\n" "$SEED_TIMEOUT"
    timedout=$((timedout + 1))
    record_failure "$name" TIMEOUT "$output"
  elif [ "$aviation_gated" -eq 1 ] \
    && echo "$output" | grep -q "intl unpublishable: no AVIATIONSTACK_API key"; then
    # Expected outcome of the intl gate above: we unset the key on purpose, the
    # free side-cars ran and wrote, and only the deliberately-disabled paid
    # section "failed". Anything else that goes wrong on a gated tick (Redis
    # down, spawn error) produces a different signature and still lands in
    # FAIL below.
    printf "OK (side-cars ran; intl gated)\n"
    ok=$((ok + 1))
  elif echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  elif [ $rc -eq 0 ]; then
    printf "OK\n"
    ok=$((ok + 1))
  else
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
    record_failure "$name" FAIL "$output"
  fi
done

echo ""
echo "Done: $ok ok, $skip skipped, $fail failed, $timedout timed out"
if [ -n "$RUN_LOG" ] && [ "$((fail + timedout))" -gt 0 ]; then
  echo "Full output for the $((fail + timedout)) non-OK seeder(s): $RUN_LOG"
fi
