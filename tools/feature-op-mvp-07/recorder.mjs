// Check recording shared by the machine steps and the scenarios: checks are added against assertion ids, printed to the transcript as they
// happen, and an assertion's verdict is made from all of its checks (none recorded is a failure).
import { verdict } from "./machine-checks.mjs";
import { firstLine } from "./policy.mjs";

export function makeRecorder(S) {
  const checks = new Map();
  return {
    add(id, label, ok, detail = "") {
      checks.set(id, [...(checks.get(id) ?? []), { label, ok, detail: ok ? "" : firstLine(String(detail)) }]);
      S.t.out(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === "" ? "" : `  -- ${firstLine(String(detail))}`}`);
      return ok;
    },
    verdictFor: (id) => verdict(id, checks.get(id) ?? []),
  };
}
