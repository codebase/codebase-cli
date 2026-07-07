import assert from "node:assert/strict";
import { markDone, readySteps } from "./src/workflow.mjs";

const steps = [
	{ id: "design", done: true, dependsOn: [] },
	{ id: "build", done: false, dependsOn: ["design"] },
	{ id: "verify", done: false, dependsOn: ["build"] },
	{ id: "ship", done: false, dependsOn: ["verify"] },
];

assert.deepEqual(readySteps(steps), ["build"]);
assert.deepEqual(readySteps([{ id: "blocked", done: false, dependsOn: ["missing"] }]), []);

const next = markDone(steps, "build");
assert.notEqual(next, steps, "markDone should return a new array");
assert.equal(steps[1].done, false, "markDone should not mutate the input");
assert.deepEqual(readySteps(next), ["verify"]);

console.log("ok");
