/**
 * Multi-machine Machines: other machines in the switcher, the All machines overview, marking items for another machine, and
 * sharing this machine's installs as `workbench/machines/<id>.json` through GitHub (packages/fleet). Off until it is reliable:
 * Machines manages this machine only and says "Add a machine · Coming soon", the reporter is never started, and nothing is
 * published or committed. The fleet backend stays in the code with its tests. A code switch for a later release, not a setting.
 */
export const multiMachine = false;
