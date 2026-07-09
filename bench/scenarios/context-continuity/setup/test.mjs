import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { releasePolicy, shouldRollback } from "./src/contextPolicy.mjs";

const policy = releasePolicy();

assert.equal(policy.codename, "aurora-lattice");
assert.equal(policy.owner, "Priya Raman");
assert.equal(policy.preserveFlag, "CONTEXT_GUARDIAN_PRESERVE=tasks+memory");
assert.equal(policy.canaryPercent, 7);
assert.equal(policy.rollbackThreshold, 0.25);
assert.equal(policy.rollbackCommand, "npm run rollback:guardian");
assert.equal(policy.verificationCommand, "npm test");

assert.equal(shouldRollback({ errorRate: 0.26, failedChecks: 0 }), true);
assert.equal(shouldRollback({ errorRate: 0.20, failedChecks: 1 }), false);
assert.equal(shouldRollback({ errorRate: 0.10, failedChecks: 4 }), true);

assert.equal(existsSync("docs/context-handoff.md"), true);
const handoff = readFileSync("docs/context-handoff.md", "utf8");
for (const value of [
	"aurora-lattice",
	"Priya Raman",
	"CONTEXT_GUARDIAN_PRESERVE=tasks+memory",
	"7",
	"0.25",
	"npm run rollback:guardian",
	"npm test",
]) {
	assert.match(handoff, new RegExp(escapeRegExp(value)));
}
assert.match(handoff, /bench seed: context continuity fixture|context_guardian_runbook\.md/i);
assert.match(handoff, /stale[: ]+(no|false)|not stale|current|non-stale/i);
assert.doesNotMatch(handoff, /cedar-loop|CONTEXT_GUARDIAN_PRESERVE=none|Noah Pike|rollback:legacy/i);

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
