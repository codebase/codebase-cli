export function cleanupPolicy() {
	return {
		mode: "delete",
		deniedCommand: null,
		preservePath: null,
		fallback: null,
	};
}
