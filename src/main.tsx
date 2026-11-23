import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { LanguageProvider } from './utils/languageContext';
import { DashboardShowcase } from './components/demo/DashboardShowcase';

// /demo is a standalone, view-only dashboard showcase with synthetic data. It is chosen BEFORE <App />
// mounts, so none of App's session or data requests (/api/*) run on that page.
const isDemoPage = /^\/demo\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    {isDemoPage ? <DashboardShowcase /> : <App />}
  </LanguageProvider>,
);
