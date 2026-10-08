#!/usr/bin/env sh
# Fail if any commit in a range has an author or committer email that is not a
# GitHub noreply address.
#
# Why this exists: the history was rewritten once to remove two personal email
# addresses, and the thing that can undo it is a commit made from an environment
# whose git identity was never configured — a phone or cloud session, a fresh
# clone, a new collaborator. GitHub's "block command line pushes that expose my
# email" is the prevention; this is the detection that does not depend on which
# machine produced the commit, or on remembering to configure it there.
#
# It is an ALLOWLIST on purpose. A denylist would mean writing the private
# addresses into a public file, which is the leak it is meant to prevent. For the
# same reason a failure prints the commit SHA and never the offending address:
# CI logs on a public repo are public.
#
# Usage: check-commit-identity.sh <git-range>
#        check-commit-identity.sh HEAD~5..HEAD
set -eu

RANGE="${1:?usage: check-commit-identity.sh <git-range>}"

# Anyone's GitHub noreply address, plus the bot identities that may legitimately
# author a commit here. Add to this rather than loosening the pattern.
is_allowed() {
  case "$1" in
  *@users.noreply.github.com) return 0 ;;
  noreply@anthropic.com) return 0 ;;
  *) return 1 ;;
  esac
}

bad=""
count=0
# Tab-separated so an address containing spaces (malformed, but possible) cannot
# shift the fields.
while IFS="$(printf '\t')" read -r sha author committer; do
  [ -n "$sha" ] || continue
  count=$((count + 1))
  if ! is_allowed "$author" || ! is_allowed "$committer"; then
    bad="$bad $sha"
  fi
done <<EOF
$(git log --format='%H%x09%ae%x09%ce' "$RANGE")
EOF

if [ -n "$bad" ]; then
  echo "Commit identity check FAILED."
  echo
  echo "These commits carry an author or committer email that is not a GitHub"
  echo "noreply address. The address is deliberately not printed — this log may be"
  echo "public, and not publishing it is the point."
  for sha in $bad; do echo "  $sha"; done
  echo
  echo "Inspect locally:   git show --format='%ae %ce' -s <sha>"
  echo "Fix the identity:  git config --global user.email '<id>+<user>@users.noreply.github.com'"
  echo "Then rewrite the affected commits before pushing again."
  exit 1
fi

echo "Commit identity OK — $count commit(s) in $RANGE, all noreply."
