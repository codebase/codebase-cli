/**
 * Shape of a project record returned by `GET /cli/projects` on the
 * codebase.design backend. Mirrors the JSON the route emits in
 * `polyvibe-poc/web/backend/routes/cliProjects.js:44-52`.
 *
 * The backend returns BOTH a Convex-sourced list (`projects`) and a
 * raw S3-prefix-derived list (`s3Projects`) — the latter catches
 * projects that exist on storage but haven't been published or
 * indexed in Convex yet. The CLI surfaces both flavors together.
 */
export interface PlatformProject {
	id: string;
	userId?: string;
	title?: string;
	description?: string;
	model?: string | null;
	publishedAt?: string | null;
	createdAt?: string | null;
	/**
	 * "convex" → fully-indexed project with metadata; "storage-only" →
	 * raw S3 prefix discovered without a Convex row. Storage-only
	 * projects can still be pulled but lack title/description.
	 */
	source: "convex" | "storage-only";
}

export interface ListProjectsResponse {
	projects: PlatformProject[];
}
