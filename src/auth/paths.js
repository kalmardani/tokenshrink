// Per user config dir, the place for config.json and the token cache.
//   Windows  %APPDATA%\tokenshrink
//   macOS    ~/Library/Application Support/tokenshrink
//   Linux    $XDG_CONFIG_HOME/tokenshrink or ~/.config/tokenshrink

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function configDir(env = process.env, platform = process.platform) {
  if (env.TOKENSHRINK_CONFIG_DIR) return resolve(env.TOKENSHRINK_CONFIG_DIR);
  let base;
  if (platform === 'win32') base = env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  else if (platform === 'darwin') base = join(homedir(), 'Library', 'Application Support');
  else base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'tokenshrink');
}
