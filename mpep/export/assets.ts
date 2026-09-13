// Browser libraries for the exported page. Pi ships marked/highlight.js for its own HTML
// export; reusing them avoids vendoring a second copy. When a distribution hides the files
// (or a compiled binary bundles them differently) the page still works — it just shows
// escaped text instead of rendered markdown.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

function readBundledLibrary(fileName: string): string | undefined {
	let directory: string;
	try {
		directory = getPackageDir();
	} catch {
		return undefined;
	}
	const candidates = [
		join(directory, "src", "core", "export-html", "vendor", fileName),
		join(directory, "dist", "core", "export-html", "vendor", fileName),
	];
	for (const candidate of candidates) {
		try {
			return readFileSync(candidate, "utf8");
		} catch {
			// Source checkouts keep the assets under src, installed packages under dist.
		}
	}
	return undefined;
}

export function readMarkdownLibrary(): string | undefined {
	return readBundledLibrary("marked.min.js");
}

export function readHighlightLibrary(): string | undefined {
	return readBundledLibrary("highlight.min.js");
}
