import { mergeConfig, parseConfig, redactConfig } from "./config.js";

export function loadServerConfig(defaultText, localText) {
	const defaults = parseConfig(defaultText);
	const local = parseConfig(localText);
	const merged = mergeConfig(defaults, local);
	return {
		port: Number(merged.PORT || 3000),
		host: merged.HOST || "127.0.0.1",
		safe: redactConfig(merged),
	};
}
