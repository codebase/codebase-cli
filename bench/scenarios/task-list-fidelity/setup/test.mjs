import assert from "node:assert/strict";
import { lowStock, normalizeSku, totalCents } from "./src/inventory.js";

assert.equal(normalizeSku("  ab-123  "), "AB-123");
assert.equal(
	totalCents([
		{ sku: "A", priceCents: 125, quantity: 2 },
		{ sku: "B", priceCents: 99, quantity: 3 },
	]),
	547,
);
assert.deepEqual(
	lowStock(
		[
			{ sku: "A", quantity: 1 },
			{ sku: "B", quantity: 3 },
			{ sku: "C", quantity: 4 },
		],
		3,
	),
	["A", "B"],
);

console.log("ok");
