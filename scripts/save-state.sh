#!/usr/bin/env bash
# Saves ./state to the status-data branch as one parentless commit, so frequent
# saves do not grow the repository. Force push is limited to this branch.
set -eu

test -s state/state.json

entries=""
for name in state.json incidents-last-good.json; do
  if [ -f "state/$name" ]; then
    blob=$(git hash-object -w "state/$name")
    entries="${entries}100644 blob ${blob}	${name}
"
  fi
done

tree=$(printf '%s' "$entries" | git mktree)
commit=$(git -c user.name="kanbedu-status-monitor" -c user.email="monitor@users.noreply.github.com" commit-tree "$tree" -m "Monitor state")
git push --quiet --force origin "${commit}:refs/heads/status-data"
echo "State saved as ${commit}."
