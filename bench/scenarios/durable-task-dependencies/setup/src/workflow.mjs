export function readySteps(steps) {
	return steps.filter((step) => !step.done && step.dependsOn.length === 0).map((step) => step.id);
}

export function markDone(steps, id) {
	const step = steps.find((item) => item.id === id);
	if (step) step.done = true;
	return steps;
}
