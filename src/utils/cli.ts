/**
 * CLI Utilities
 *
 * Purpose:
 * - Provide tooling for CLI-related tasks in the application.
 * - Install console overrides so that console.log and console.warn consistently
 *   format their input using util.format, which handles placeholders and
 *   complex objects gracefully.
 * - Expose a small helper to mount these overrides at runtime.
 */
import util from 'util';

/**
 * Patches console.log and console.warn to route through util.format for
 * consistent and predictable formatting of messages.
 */
export function patchConsole(): void {
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);

  console.log = (...args: any[]): void => {
    originalLog(util.format(...args));
  };

  console.warn = (...args: any[]): void => {
    originalWarn(util.format(...args));
  };
}

export default patchConsole;
