/**
 * Environment for spawned helper processes.
 *
 * Children inherit `process.env` by default. Once a user exports
 * SLACKCLI_TOKEN / SLACKCLI_XOXD / SLACKCLI_XOXC — the natural way to use the
 * env-var login, since retyping them per command is what pushes people back to
 * the argv flags — that live Slack credential would otherwise be handed to
 * every helper this CLI spawns: pbpaste, xclip/xsel, PowerShell, and the
 * browser launched by `login-auto`. None of them need it, and the browser in
 * particular exposes its environment to extensions and crash reporters.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.SLACKCLI_TOKEN;
  delete env.SLACKCLI_XOXD;
  delete env.SLACKCLI_XOXC;
  return env;
}
