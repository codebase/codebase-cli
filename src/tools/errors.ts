/**
 * Typed errors thrown by tools. Messages are addressed to the LLM —
 * actionable, no internal codes leaked. The agent loop converts these into
 * tool-result errors that the model sees directly.
 */

export class FileUnexpectedlyModifiedError extends Error {
	constructor(public readonly path: string) {
		super(`${path} changed on disk since I last read it. Read it again before editing.`);
		this.name = "FileUnexpectedlyModifiedError";
	}
}

export class FileNotReadFirstError extends Error {
	constructor(public readonly path: string) {
		super(`${path} was not read in this turn. Use read_file before edit_file or write_file.`);
		this.name = "FileNotReadFirstError";
	}
}

export class PartialViewEditError extends Error {
	constructor(public readonly path: string) {
		super(
			`${path} was only partially read (offset/limit). Read the full file before editing, ` +
				"or use multi_edit with all the segments you intend to change.",
		);
		this.name = "PartialViewEditError";
	}
}

export class AmbiguousMatchError extends Error {
	constructor(
		public readonly path: string,
		public readonly count: number,
	) {
		super(
			`old_string appears ${count} times in ${path}. Provide more context to uniquely identify ` +
				"the match, or set replace_all: true.",
		);
		this.name = "AmbiguousMatchError";
	}
}

export class NoMatchError extends Error {
	constructor(public readonly path: string) {
		super(`old_string not found in ${path}. Read the file again — it may have changed.`);
		this.name = "NoMatchError";
	}
}

export class FileTooLargeError extends Error {
	constructor(
		public readonly path: string,
		public readonly size: number,
		public readonly limit: number,
	) {
		super(
			`${path} is ${size} bytes (limit: ${limit}). Read with offset+limit to page through it, ` +
				"or run head/tail via shell.",
		);
		this.name = "FileTooLargeError";
	}
}

export class PathOutsideCwdError extends Error {
	constructor(public readonly path: string) {
		super(`${path} is outside the project root. Tools only operate within the cwd.`);
		this.name = "PathOutsideCwdError";
	}
}

export class TimeoutError extends Error {
	constructor(
		public readonly seconds: number,
		public readonly tool: string,
	) {
		super(`${tool} timed out after ${seconds}s.`);
		this.name = "TimeoutError";
	}
}

export class BinaryFileError extends Error {
	constructor(public readonly path: string) {
		super(`${path} appears to be binary. Tools that read text won't help here.`);
		this.name = "BinaryFileError";
	}
}
