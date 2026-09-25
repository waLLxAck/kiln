import { Monitor, Settings } from 'lucide-react';

/** What public builds show in place of the Machines section while it is unfinished (see ../build-flags.ts). */
export function MachinesSoon({ onSettings }: { onSettings: () => void }) {
  return <section className="coming-soon" aria-labelledby="machines-soon-title">
    <div className="coming-soon-icon"><Monitor size={26} /></div>
    <span className="coming-soon-tag">Coming soon</span>
    <h2 id="machines-soon-title">Every place your skills are installed, in one view</h2>
    <p>Machines will list the project folders and machines your approved skills are installed in, and check each copy for changes made outside Kiln.</p>
    <p className="muted small">Until then, choose your personal skill folders in Settings and install from an item’s Installs tab.</p>
    <button className="button" onClick={onSettings}><Settings size={15} />Open Settings</button>
  </section>;
}
