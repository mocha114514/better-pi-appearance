import { spawn } from "node:child_process";

/** A detached helper process to launch, e.g. powershell.exe or notify-send. */
export interface NotificationCommand {
	command: string;
	args: string[];
}

/**
 * Builds the native notification commands for a platform (zero dependencies).
 * When soundPath points to the synthesized chime, it is played with the
 * platform's built-in player and the popup itself is silenced; otherwise the
 * platform's default notification sound is used.
 */
export function buildNotificationCommands(
	title: string,
	body: string,
	soundPath?: string,
	platform: NodeJS.Platform = process.platform,
): NotificationCommand[] {
	switch (platform) {
		case "win32": return [windowsCommand(title, body, soundPath)];
		case "darwin": return macOSCommands(title, body, soundPath);
		default: return linuxCommands(title, body, soundPath);
	}
}

/**
 * Fires the platform's native notification with sound. Every step degrades
 * silently and falls back to the terminal bell, so a broken notification
 * stack can never interrupt the session.
 */
export function notifyTurnComplete(title: string, body: string, soundPath?: string): void {
	for (const { command, args } of buildNotificationCommands(title, body, soundPath)) launch(command, args);
}

/** Spawns a detached, stdio-ignored helper; rings the bell if it cannot start. */
function launch(command: string, args: string[]): void {
	try {
		// detached lets the notifier survive the session's process group on POSIX,
		// but on Windows it spawns console apps (powershell.exe) with DETACHED_PROCESS,
		// which makes them exit before running anything. unref() alone suffices there.
		const child = spawn(command, args, { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true });
		child.on("error", ringBell);
		child.unref();
	} catch {
		ringBell();
	}
}

/** Last-resort audible signal when no native notifier is available. */
function ringBell(): void {
	try { process.stderr.write("\u0007"); } catch { /* best effort */ }
}

/**
 * Windows toast via WinRT, using the built-in PowerShell AppID so no AppUserModelID
 * registration is required. With a custom soundPath the toast is silenced and the
 * WAV is played via System.Media.SoundPlayer (falling back to a system sound);
 * without one the toast XML carries the default notification sound. If the WinRT
 * path fails entirely, the script falls back to a NotifyIcon balloon plus a system
 * sound. The script is passed base64-encoded (UTF-16LE) via -EncodedCommand, which
 * avoids quoting issues and bypasses the execution policy. Title, body and sound
 * path are embedded as single-quoted literals (single quotes doubled): -EncodedCommand
 * accepts no trailing arguments, so this escaping is the only injection boundary.
 */
function windowsCommand(title: string, body: string, soundPath?: string): NotificationCommand {
	const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
	const script = [
		`$title = ${literal(title)}; $body = ${literal(body)}`,
		`$soundPath = ${soundPath ? literal(soundPath) : "$null"}`,
		"try {",
		"\t[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
		"\t[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null",
		"\t$escape = { [System.Security.SecurityElement]::Escape($args[0]) }",
		"\t$audio = if ($soundPath) { '<audio silent=\"true\"/>' } else { '<audio src=\"ms-winsoundevent:Notification.Default\"/>' }",
		"\t$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
		"\t$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + (& $escape $title) + '</text><text>' + (& $escape $body) + '</text></binding></visual>' + $audio + '</toast>')",
		"\t$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
		"\t[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
		"\tif ($soundPath) {",
		"\t\ttry { (New-Object System.Media.SoundPlayer $soundPath).PlaySync() }",
		"\t\tcatch { [System.Media.SystemSounds]::Asterisk.Play() }",
		"\t}",
		"} catch {",
		"\tAdd-Type -AssemblyName System.Windows.Forms",
		"\tAdd-Type -AssemblyName System.Drawing",
		"\t[System.Media.SystemSounds]::Asterisk.Play()",
		"\t$icon = New-Object System.Windows.Forms.NotifyIcon",
		"\t$icon.Icon = [System.Drawing.SystemIcons]::Information",
		"\t$icon.BalloonTipTitle = $title",
		"\t$icon.BalloonTipText = $body",
		"\t$icon.Visible = $true",
		"\t$icon.ShowBalloonTip(4000)",
		"\tStart-Sleep -Seconds 5",
		"\t$icon.Dispose()",
		"}",
	].join("\n");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	return {
		command: "powershell.exe",
		args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
	};
}

/**
 * macOS notification via AppleScript. With a custom soundPath the popup omits its
 * sound and afplay (built-in) plays the WAV instead; without one the notification
 * carries the built-in "Glass" sound.
 */
function macOSCommands(title: string, body: string, soundPath?: string): NotificationCommand[] {
	const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const sound = soundPath ? "" : ' sound name "Glass"';
	const popup: NotificationCommand = {
		command: "osascript",
		args: ["-e", `display notification "${escape(body)}" with title "${escape(title)}"${sound}`],
	};
	return soundPath ? [popup, { command: "afplay", args: [soundPath] }] : [popup];
}

/**
 * Linux notification via notify-send (libnotify). With a custom soundPath the hint is
 * dropped (to avoid double playback) and paplay plays the WAV; without one the
 * sound-name hint plus a best-effort paplay of the freedesktop "complete" sound is used.
 */
function linuxCommands(title: string, body: string, soundPath?: string): NotificationCommand[] {
	const popup: NotificationCommand = soundPath
		? { command: "notify-send", args: ["--app-name=Pi", title, body] }
		: { command: "notify-send", args: ["--app-name=Pi", "--hint=string:sound-name:complete", title, body] };
	const sound: NotificationCommand = soundPath
		? { command: "paplay", args: [soundPath] }
		: { command: "paplay", args: ["/usr/share/sounds/freedesktop/stereo/complete.oga"] };
	return [popup, sound];
}
