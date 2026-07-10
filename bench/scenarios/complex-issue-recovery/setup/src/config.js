export function parseConfig(text) {
	const entries = text
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("="));
	return Object.fromEntries(entries);
}

export function mergeConfig(defaults, local) {
	return { ...local, ...defaults };
}

export function redactConfig(config) {
	const sensitive = new Set(["token", "password", "secret"]);
	return Object.fromEntries(
		Object.entries(config).map(([key, value]) => [key, sensitive.has(key) ? "[redacted]" : value]),
	);
}
