import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStateCache } from "./file-state-cache.js";
import { createNotebookEdit } from "./notebook-edit.js";
import { createReadFile } from "./read-file.js";
import { TaskStore } from "./task-store.js";
import type { ToolContext } from "./types.js";

function makeCtx(cwd: string): ToolContext {
	return {
		cwd,
		fileStateCache: new FileStateCache(),
		tasks: new TaskStore(),
		spawnSubagent: () => {
			throw new Error("not used in tests");
		},
	};
}

function emptyNotebook(): object {
	return {
		cells: [
			{ cell_type: "markdown", source: "# Title", metadata: {} },
			{ cell_type: "code", source: "print(1)", metadata: {}, outputs: [], execution_count: null },
		],
		metadata: { kernelspec: { name: "python3" } },
		nbformat: 4,
		nbformat_minor: 5,
	};
}

async function readThen(ctx: ToolContext, relPath: string) {
	await createReadFile(ctx).execute("r", { path: relPath });
}

async function edit(ctx: ToolContext, params: Parameters<ReturnType<typeof createNotebookEdit>["execute"]>[1]) {
	return createNotebookEdit(ctx).execute("n", params);
}

describe("notebook_edit", () => {
	let dir: string;
	let ctx: ToolContext;
	let nb: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nb-"));
		ctx = makeCtx(dir);
		nb = join(dir, "demo.ipynb");
		writeFileSync(nb, JSON.stringify(emptyNotebook(), null, 1));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("inserts a new cell at the given index", async () => {
		await readThen(ctx, "demo.ipynb");
		await edit(ctx, {
			path: "demo.ipynb",
			cell_index: 1,
			operation: "insert",
			cell_type: "markdown",
			source: "## Section",
		});

		const after = JSON.parse(readFileSync(nb, "utf8")) as { cells: { cell_type: string; source: string }[] };
		expect(after.cells).toHaveLength(3);
		expect(after.cells[1]).toMatchObject({ cell_type: "markdown", source: "## Section" });
	});

	it("updates source while preserving cell type by default", async () => {
		await readThen(ctx, "demo.ipynb");
		await edit(ctx, {
			path: "demo.ipynb",
			cell_index: 1,
			operation: "update",
			source: "print(42)",
		});

		const after = JSON.parse(readFileSync(nb, "utf8")) as { cells: { cell_type: string; source: string }[] };
		expect(after.cells[1].cell_type).toBe("code");
		expect(after.cells[1].source).toBe("print(42)");
	});

	it("update can change cell type", async () => {
		await readThen(ctx, "demo.ipynb");
		await edit(ctx, {
			path: "demo.ipynb",
			cell_index: 1,
			operation: "update",
			cell_type: "markdown",
			source: "now markdown",
		});

		const after = JSON.parse(readFileSync(nb, "utf8")) as {
			cells: { cell_type: string; source: string; outputs?: unknown[] }[];
		};
		expect(after.cells[1].cell_type).toBe("markdown");
		expect(after.cells[1].outputs).toBeUndefined();
	});

	it("deletes a cell", async () => {
		await readThen(ctx, "demo.ipynb");
		await edit(ctx, { path: "demo.ipynb", cell_index: 0, operation: "delete" });

		const after = JSON.parse(readFileSync(nb, "utf8")) as { cells: { cell_type: string }[] };
		expect(after.cells).toHaveLength(1);
		expect(after.cells[0].cell_type).toBe("code");
	});

	it("rejects insert without cell_type", async () => {
		await readThen(ctx, "demo.ipynb");
		await expect(edit(ctx, { path: "demo.ipynb", cell_index: 0, operation: "insert", source: "x" })).rejects.toThrow(
			/cell_type/,
		);
	});

	it("rejects update with missing source", async () => {
		await readThen(ctx, "demo.ipynb");
		await expect(edit(ctx, { path: "demo.ipynb", cell_index: 0, operation: "update" })).rejects.toThrow(/source/);
	});

	it("rejects out-of-range indices", async () => {
		await readThen(ctx, "demo.ipynb");
		await expect(edit(ctx, { path: "demo.ipynb", cell_index: 99, operation: "delete" })).rejects.toThrow(
			/out of range/,
		);
		await expect(
			edit(ctx, { path: "demo.ipynb", cell_index: 99, operation: "insert", cell_type: "code", source: "x" }),
		).rejects.toThrow(/out of range/);
	});

	it("rejects edits to a notebook that was not read first", async () => {
		await expect(edit(ctx, { path: "demo.ipynb", cell_index: 0, operation: "delete" })).rejects.toThrow(
			/not read in this turn/,
		);
	});

	it("rejects non-.ipynb paths", async () => {
		writeFileSync(join(dir, "fake.json"), "{}");
		await readThen(ctx, "fake.json");
		await expect(edit(ctx, { path: "fake.json", cell_index: 0, operation: "delete" })).rejects.toThrow(
			/only operates on .ipynb/,
		);
	});

	it("rejects malformed JSON", async () => {
		writeFileSync(nb, "not valid json");
		await readThen(ctx, "demo.ipynb");
		await expect(edit(ctx, { path: "demo.ipynb", cell_index: 0, operation: "delete" })).rejects.toThrow(
			/not valid JSON/,
		);
	});

	it("rejects files without a cells array", async () => {
		writeFileSync(nb, JSON.stringify({ metadata: {} }));
		await readThen(ctx, "demo.ipynb");
		await expect(edit(ctx, { path: "demo.ipynb", cell_index: 0, operation: "delete" })).rejects.toThrow(
			/cells array/,
		);
	});
});
