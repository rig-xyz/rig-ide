/**
 * What a failed agent install says: a title and one plain sentence with a
 * next step, for every way `rpc.agents.install` can fail and for a thrown
 * error. Never the raw installer output, and never "open a terminal".
 */
export function installErrorText(error: unknown, name: string): { title: string; description: string } {
  const title = `Couldn’t install ${name}`;
  const type = typeof error === 'object' && error !== null && 'type' in error ? String(error.type) : '';
  const detail =
    typeof error === 'object' && error !== null
      ? `${'message' in error ? String(error.message) : ''}\n${'output' in error ? String(error.output) : ''}`
      : '';
  switch (type) {
    case 'unknown-dependency':
      return { title, description: `This version of Rig doesn’t know how to install ${name}. Update Rig, then try again.` };
    case 'no-install-command':
      return { title, description: `Rig has no way to install ${name} on this Mac. Install it from its website, then press Check again.` };
    case 'permission-denied':
      return { title, description: `This Mac didn’t allow the install. Make sure your account can install apps, then try again.` };
    case 'pty-open-failed':
      return { title, description: 'Rig couldn’t start the installer. Quit and reopen Rig, then try again.' };
    case 'not-detected-after-install':
      return { title, description: `The install finished, but Rig can’t find ${name} yet. Press Check again, or quit and reopen Rig.` };
    case 'command-failed':
      if (/\b(npm|node)\b[^\n]*(not found|ENOENT)|command not found: (npm|node)/i.test(detail)) {
        return { title, description: `This Mac doesn’t have Node, which that way of installing needs. Pick the other way to install ${name}.` };
      }
      if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|Could not resolve host|network/i.test(detail)) {
        return { title, description: 'Rig couldn’t reach the download. Check your internet connection, then try again.' };
      }
      return { title, description: `The installer stopped before it finished. Try again, or install ${name} from its website.` };
    default:
      return { title, description: 'Something went wrong while installing. Try again.' };
  }
}
