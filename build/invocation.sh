# fezoctl invocation ladder.
#
# Requires two variables already set by the caller: SKILL_DIR (quoted at
# every use — it may contain spaces) and SKILL_VERSION. Resolves an argv
# array, never a command string, into FEZOCTL_ARGV, in this fixed order:
#
#   1. $FEZOCTL, if it names an executable file -- or a NON-executable
#      .mjs/.js/.cjs file, which is invoked as `node <path>` for exactly the
#      reason tiers 2 and 3 are: a bundle copied out of an archive commonly
#      loses its executable bit. Requiring `-x` here (while tiers 2-3 do not)
#      made `FEZOCTL=/path/to/fezoctl.mjs` at mode 0644 -- a natural thing to
#      set, and the documented way to carry the resolved path from one Bash
#      call into the next -- fall silently through to tier 5. A $FEZOCTL that
#      is set but usable neither way is reported on stderr, never skipped in
#      silence.
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
#   5. A version-pinned `npx -y fezo-skills@$SKILL_VERSION fezoctl`.
#      THIS TIER DOES NOT WORK TODAY: `fezo-skills` is not published to npm, so
#      the pinned version does not exist on the registry and npx fails with a
#      404. It is still the last rung (it is what will work once the package
#      ships), but reaching it is a misconfiguration, so the function announces
#      it on stderr with the three things that must all have missed.
#
# A versioned bundle (tiers 2-3) always outranks PATH (tier 4): tiers 2 and 3
# are tried before tier 4 unconditionally.
resolve_fezoctl() {
  # Tiers 2 and 3 are both relative to SKILL_DIR. An unset or empty SKILL_DIR
  # would make both of them silently miss and land the ladder on tier 5 (a
  # network fetch) with no diagnostic at all, so refuse to guess.
  : "${SKILL_DIR:?SKILL_DIR must be set to the directory containing SKILL.md}"

  FEZOCTL_ARGV=()

  if [ -n "${FEZOCTL:-}" ]; then
    if [ -x "${FEZOCTL}" ]; then
      FEZOCTL_ARGV=("${FEZOCTL}")
      return 0
    fi
    case "${FEZOCTL}" in
      *.mjs | *.js | *.cjs)
        if [ -f "${FEZOCTL}" ]; then
          FEZOCTL_ARGV=(node "${FEZOCTL}")
          return 0
        fi
        ;;
    esac
    printf 'fezoctl: ignoring FEZOCTL=%s -- it is not an executable file, and not an existing .mjs/.js/.cjs bundle that could be run with node\n' \
      "${FEZOCTL}" >&2
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

  # Tier 5 is reached only when everything above missed, and it cannot succeed
  # until the package is published -- so say so, loudly, instead of handing back
  # an argv that 404s with no explanation. The three misses named here are
  # exactly the ones to check, in the order the ladder tried them.
  printf 'fezoctl: falling back to `npx -y fezo-skills@%s fezoctl`, which CANNOT WORK YET: fezo-skills is not published to npm, so npx will fail with a 404.\n' \
    "${SKILL_VERSION}" >&2
  printf 'fezoctl: nothing above it resolved: no bundle at "%s/scripts/fezoctl.mjs", no sibling bundle at "%s/../../dist/fezoctl.mjs", and no global fezoctl on PATH reporting version %s. Point FEZOCTL at a fezoctl.mjs bundle, or use the skill from a checkout that has dist/fezoctl.mjs.\n' \
    "${SKILL_DIR}" "${SKILL_DIR}" "${SKILL_VERSION}" >&2
  FEZOCTL_ARGV=(npx -y "fezo-skills@${SKILL_VERSION}" fezoctl)
  return 0
}

resolve_fezoctl
