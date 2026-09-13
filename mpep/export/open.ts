// Open a generated transcript in the platform browser. Failures are reported, never thrown.
import { spawn } from "node:child_process";

/** Launch the default browser for a local file. Returns false when it cannot be spawned. */
export function openInBrowser(filePath: string): boolean {
	const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
	try {
		const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
		// A missing launcher surfaces asynchronously; the path in the notice stays actionable.
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
