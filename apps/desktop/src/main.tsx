import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Palette from './Palette';
import './styles.css';
import { startDiagnostics } from './diagnostics';
import { ErrorBoundary } from './Loading';
import { KilnMark } from './components';
startDiagnostics();
/** A render error anywhere shows what broke, with a way back, instead of a blank window. */
const crashed = (error: Error, reset: () => void) => <div className="startup" role="alert"><span className="brand-symbol"><KilnMark /></span><h1>Something went wrong</h1><p>{error.message || String(error)}</p>
  <div className="wrap-actions center"><button className="button primary" onClick={reset}>Try again</button><button className="button" onClick={() => location.reload()}>Reload Kiln</button></div></div>;
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary fallback={crashed}>{location.hash === '#palette' ? <Palette /> : <App />}</ErrorBoundary></React.StrictMode>);
