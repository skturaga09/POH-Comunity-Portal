#!/usr/bin/env bash
# Start the POH Firebase Emulator Suite for local development + measurement.
# Uses the project-local Temurin JDK (tools/jdk/...) so no system Java is needed,
# and enables the read counter (POH_COUNT_READS=1) used by measure-baseline.mjs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

JDK_HOME="$(find "$ROOT/tools/jdk" -maxdepth 2 -name Home -type d 2>/dev/null | head -1)"
if [ -z "$JDK_HOME" ]; then
  echo "No local JDK found under tools/jdk/. Run the JDK download step first." >&2
  exit 1
fi
export JAVA_HOME="$JDK_HOME"
export PATH="$JAVA_HOME/bin:$PATH"
export POH_COUNT_READS="${POH_COUNT_READS:-1}"

echo "JAVA_HOME=$JAVA_HOME"
echo "POH_COUNT_READS=$POH_COUNT_READS"
exec firebase emulators:start --only auth,firestore,functions --project poh-community-portal
