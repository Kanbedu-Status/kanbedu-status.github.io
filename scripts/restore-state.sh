#!/usr/bin/env bash
# Restores monitor state from the status-data branch into ./state.
# Only a branch that is confirmed absent counts as a first run. Any other
# failure stops the job, so a network error cannot erase history.
set -u

mkdir -p state
git ls-remote --exit-code --heads origin status-data > /dev/null
code=$?

if [ "$code" -eq 2 ]; then
  echo "status-data branch does not exist. Starting a new history."
  exit 0
fi
if [ "$code" -ne 0 ]; then
  echo "Could not ask the remote for status-data (exit $code). Stopping." >&2
  exit 1
fi

set -e
git fetch --quiet --depth=1 origin status-data
git archive FETCH_HEAD | tar -x -C state
test -s state/state.json
echo "State restored."
