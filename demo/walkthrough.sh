#!/usr/bin/env bash
# Live walkthrough of skill-eval on the wait-what skill: write situations from
# the skill, lint and freeze them, run each in its own container, read the
# receipts, fix the skill, re-run the same frozen situations, compare.
#
#   demo/walkthrough.sh before                 # preflight -> situations -> lint -> run -> receipts
#   demo/walkthrough.sh after <before-run-dir>  # the fix -> re-run -> compare
#
# Everything printed here is real output from a real run.
set -uo pipefail
cd "$(dirname "$0")/.."

SCEN="${SCEN:-demo/wait-what-scenarios.json}"
EVALS="${EVALS:-demo/evals-walkthrough}"
SKILL="${SKILL:-$HOME/.omp/agent/skills/wait-what}"
REPORT="node demo/walkthrough-report.mjs"

B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
say() { printf '\n%s### %s%s\n' "$B" "$*" "$R"; }
hint() { printf '%s%s%s\n' "$D" "$*" "$R"; }

# Run the eval and print each session's result the moment it lands, so the
# wait is visible instead of silent.
run_eval() {
  local log seen dir s
  log=$(mktemp)
  seen=""
  for s in "$EVALS"/*/result.json; do [ -e "$s" ] && seen="$seen $s"; done
  node eval.mjs run "$SCEN" --evals-dir "$EVALS" >"$log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    dir=$(ls -1dt "$EVALS"/*/ 2>/dev/null | head -1)
    if [ -n "$dir" ]; then
      for s in "$dir"*/result.json; do
        [ -e "$s" ] || continue
        case " $seen " in *" $s "*) continue ;; esac
        seen="$seen $s"
        node -e '
          const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          const flags = [r.skill_loaded ? "skill loaded" : "skill NOT loaded",
                         r.turns + " turns", Math.round(r.duration_ms / 1000) + "s"];
          console.log("  done  " + r.scenario.padEnd(16) + flags.join("  "));
        ' "$s"
      done
    fi
    sleep 2
  done
  wait "$pid"
  local rc=$?
  cat "$log"; rm -f "$log"
  return $rc
}

case "${1:-before}" in
before)
  say "0. The skill under test"
  cat "$SKILL/SKILL.md"
  say "1. Preflight: Docker, the model key, the image"
  node eval.mjs doctor
  say "2. The situations written from that skill"
  $REPORT scenarios "$SCEN"
  say "3. Lint every expected step against the skill text, then freeze the file"
  node eval.mjs validate "$SCEN"
  say "4. Run: one sealed container per situation, nothing else mounted"
  run_eval
  RUN=$(ls -1dt "$EVALS"/*/ | head -1)
  hint "run folder: $RUN"
  say "5. The receipts: summary.md"
  cat "$RUN/summary.md"
  say "6. The failing receipt, with the judge's probabilities"
  $REPORT receipts "$RUN"
  say "7. The exact message the receipt points at"
  $REPORT evidence "$RUN" F1
  ;;
after)
  BEFORE="${2:?usage: walkthrough.sh after <before-run-dir>}"
  say "8. The fix, against the skill snapshot the run used"
  diff -u "$BEFORE/skill/SKILL.md" "$SKILL/SKILL.md"
  say "9. Re-run the same frozen situations (same scenarios hash)"
  run_eval
  AFTER=$(ls -1dt "$EVALS"/*/ | head -1)
  hint "run folder: $AFTER"
  say "10. Compare: what got better, what did not, what broke"
  node eval.mjs compare "$BEFORE" "$AFTER"
  say "11. The new summary"
  cat "$AFTER/summary.md"
  ;;
*)
  echo "usage: walkthrough.sh before | after <before-run-dir>" >&2
  exit 2
  ;;
esac
