/** Best-effort "open this URL in the default browser". Never throws. */
import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  try {
    const [command, args] =
      process.platform === 'darwin'
        ? (['open', [url]] as const)
        : process.platform === 'win32'
          ? (['cmd', ['/c', 'start', '', url]] as const)
          : (['xdg-open', [url]] as const);
    const child = spawn(command, [...args], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser opener available — the printed URL is enough */
    });
    child.unref();
  } catch {
    // opening the browser is a convenience, never a failure
  }
}
