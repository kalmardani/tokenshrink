// Open a URL in the default browser without a shell. The URL is always printed as well, so a
// failure here only costs the user a copy and paste.

import { spawn } from 'node:child_process';

export function openBrowser(url, platform = process.platform) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  let cmd;
  let args;
  if (platform === 'darwin') {
    cmd = 'open';
    args = [parsed.href];
  } else if (platform === 'win32') {
    cmd = 'rundll32';
    args = ['url.dll,FileProtocolHandler', parsed.href];
  } else {
    cmd = 'xdg-open';
    args = [parsed.href];
  }
  try {
    const child = spawn(cmd, args, { shell: false, stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
