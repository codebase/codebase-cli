export function releasePolicy() {
	return {
		codename: "cedar-loop",
		owner: "Noah Pike",
		preserveFlag: "CONTEXT_GUARDIAN_PRESERVE=none",
		canaryPercent: 25,
		rollbackThreshold: 1.5,
		rollbackCommand: "npm run rollback:legacy",
		verificationCommand: "npm run test:legacy-context",
	};
}

export function shouldRollback(sample) {
	const policy = releasePolicy();
	return sample.errorRate >= policy.rollbackThreshold || sample.failedChecks > 3;
}
