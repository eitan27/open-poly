#!/usr/bin/env sh
# Fail if any commit in a range carries one of the maintainer's private email
# addresses as its author or committer.
#
# Why this exists: the history was rewritten once to remove two personal
# addresses, and the thing that can undo it is a commit made from an environment
# whose git identity was never configured — a phone or cloud session, a fresh
# clone. GitHub's "block command line pushes that expose my email" is the
# prevention; this is the part that does not depend on which machine made the
# commit.
#
# **It checks for specific addresses, NOT for "is this a noreply".** An earlier
# version required every email to be a GitHub noreply, which would have rejected
# the ordinary contributor — most people have a real address in their git config,
# that is their business, and it is no risk to this repo. Only the maintainer's own
# addresses matter here.
#
# The addresses come from $PRIVATE_EMAILS (space- or comma-separated) and are
# deliberately NOT in the repo: committing them is the leak this prevents. In CI
# that is a repository secret; locally, export it or leave it unset. A failure
# prints the commit SHA and never the address — CI logs on a public repo are
# public, and GitHub masks a secret's value in them anyway.
#
# Usage: PRIVATE_EMAILS="a@x.com b@y.com" check-commit-identity.sh HEAD~5..HEAD
set -eu

RANGE="${1:?usage: check-commit-identity.sh <git-range>}"
PRIVATE_EMAILS="${PRIVATE_EMAILS:-}"

if [ -z "$PRIVATE_EMAILS" ]; then
  echo "⚠  Commit identity guard DISABLED — \$PRIVATE_EMAILS is not set."
  echo
  echo "   Expected when this runs on a pull request from a fork: secrets are not"
  echo "   available there by design, and a contributor's own address is not what"
  echo "   this guards against, so there is nothing to check."
  echo
  echo "   NOT expected on a push to main. Set it once with:"
  echo "     gh secret set PRIVATE_EMAILS --body 'first@example.com second@example.com'"
  exit 0
fi

# Normalise separators and lower-case, so matching is case-insensitive.
needles=$(printf '%s' "$PRIVATE_EMAILS" | tr ',' ' ' | tr '[:upper:]' '[:lower:]')

bad=""
count=0
# Tab-separated so an address containing a space cannot shift the fields.
while IFS="$(printf '\t')" read -r sha author committer; do
  [ -n "$sha" ] || continue
  count=$((count + 1))
  a=$(printf '%s' "$author" | tr '[:upper:]' '[:lower:]')
  c=$(printf '%s' "$committer" | tr '[:upper:]' '[:lower:]')
  for needle in $needles; do
    if [ "$a" = "$needle" ] || [ "$c" = "$needle" ]; then
      bad="$bad $sha"
      break
    fi
  done
done <<EOF
$(git log --format='%H%x09%ae%x09%ce' "$RANGE")
EOF

if [ -n "$bad" ]; then
  echo "Commit identity check FAILED."
  echo
  echo "These commits carry a private address as author or committer. The address"
  echo "is deliberately not printed — this log may be public, and not publishing it"
  echo "is the whole point."
  for sha in $bad; do echo "  $sha"; done
  echo
  echo "Inspect locally:   git show --format='%ae %ce' -s <sha>"
  echo "Fix the identity:  git config --global user.email '<id>+<user>@users.noreply.github.com'"
  echo "Then rewrite the affected commits before pushing again."
  exit 1
fi

echo "Commit identity OK — $count commit(s) in $RANGE, none carry a private address."
