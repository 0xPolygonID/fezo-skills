# fezoctl invocation ladder.
#
# Requires two variables already set by the caller: SKILL_DIR (quoted at
# every use — it may contain spaces) and SKILL_VERSION. Resolves an argv
# array, never a command string, into FEZOCTL_ARGV, in this fixed order:
#
#   1. $FEZOCTL, if it names an executable file.
#   2. "$SKILL_DIR/scripts/fezoctl.mjs" (the bundle copied in at pack/build
#      time) — invoked as `node <path>`, not relied on to be executable,
#      because a `.skill` archive or plain file copy may not preserve the
#      executable bit.
#   3. "$SKILL_DIR/../../dist/fezoctl.mjs" (this repo's committed bundle,
#      when the skill is used straight out of a checkout of this repo) —
#      also invoked as `node <path>` for the same reason.
#   4. A global `fezoctl` on PATH, but ONLY if `fezoctl --version` matches
#      SKILL_VERSION exactly. A stale global is skipped, not silently used.
#      NOTE: `fezoctl --version` prints "fezoctl <version>", NOT a bare
#      version, so the comparison target below is "fezoctl $SKILL_VERSION".
#      Comparing the raw output to a bare "$SKILL_VERSION" can never match and
#      silently disables this whole tier.
#   5. A version-pinned `npx -y fezo-skills@$SKILL_VERSION fezoctl`, which
#      always works and always resolves the version this skill was written
#      against.
#
# A versioned bundle (tiers 2-3) always outranks PATH (tier 4): tiers 2 and 3
# are tried before tier 4 unconditionally.
resolve_fezoctl() {
  # Tiers 2 and 3 are both relative to SKILL_DIR. An unset or empty SKILL_DIR
  # would make both of them silently miss and land the ladder on tier 5 (a
  # network fetch) with no diagnostic at all, so refuse to guess.
  : "${SKILL_DIR:?SKILL_DIR must be set to the directory containing SKILL.md}"

  FEZOCTL_ARGV=()

  if [ -n "${FEZOCTL:-}" ] && [ -x "${FEZOCTL}" ]; then
    FEZOCTL_ARGV=("${FEZOCTL}")
    return 0
  fi

  if [ -f "${SKILL_DIR}/scripts/fezoctl.mjs" ]; then
    FEZOCTL_ARGV=(node "${SKILL_DIR}/scripts/fezoctl.mjs")
    return 0
  fi

  if [ -f "${SKILL_DIR}/../../dist/fezoctl.mjs" ]; then
    FEZOCTL_ARGV=(node "${SKILL_DIR}/../../dist/fezoctl.mjs")
    return 0
  fi

  if command -v fezoctl >/dev/null 2>&1; then
    # `fezoctl --version` prints "fezoctl <version>" (see render.ts's
    # renderVersion), so compare against that exact string rather than against
    # a bare "${SKILL_VERSION}" — the bare comparison is false for EVERY
    # version and silently skips even a perfectly matched global install.
    local global_version
    global_version="$(fezoctl --version 2>/dev/null || true)"
    if [ "${global_version}" = "fezoctl ${SKILL_VERSION}" ]; then
      FEZOCTL_ARGV=(fezoctl)
      return 0
    fi
  fi

  FEZOCTL_ARGV=(npx -y "fezo-skills@${SKILL_VERSION}" fezoctl)
  return 0
}

resolve_fezoctl
