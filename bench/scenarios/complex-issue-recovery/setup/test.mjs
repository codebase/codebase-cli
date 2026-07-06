import assert from "node:assert/strict";
import { parseConfig, mergeConfig, redactConfig } from "./src/config.js";
import { loadServerConfig } from "./src/server.js";

const parsed = parseConfig(`
# comments and blank lines are allowed
 PORT = 8080
HOST=" 0.0.0.0 "
FEATURE_FLAG=true
`);

assert.deepEqual(parsed, {
	PORT: "8080",
	HOST: " 0.0.0.0 ",
	FEATURE_FLAG: "true",
});

assert.deepEqual(mergeConfig({ PORT: "3000", HOST: "127.0.0.1" }, { PORT: "9000" }), {
	PORT: "9000",
	HOST: "127.0.0.1",
});

assert.deepEqual(redactConfig({ API_TOKEN: "abc", dbPassword: "pw", public: "ok", nested_secret_name: "s" }), {
	API_TOKEN: "[redacted]",
	dbPassword: "[redacted]",
	public: "ok",
	nested_secret_name: "[redacted]",
});

const loaded = loadServerConfig(
	`
PORT=3000
HOST=127.0.0.1
API_TOKEN=abc123
`,
	`
PORT=7000
# HOST omitted locally, so default survives
`,
);

assert.equal(loaded.port, 7000);
assert.equal(loaded.host, "127.0.0.1");
assert.equal(loaded.safe.API_TOKEN, "[redacted]");

console.log("ok");
