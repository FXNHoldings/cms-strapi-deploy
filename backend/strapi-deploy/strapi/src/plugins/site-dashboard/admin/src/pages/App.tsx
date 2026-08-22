import { Route, Routes } from 'react-router-dom';
import SiteGrid from './SiteGrid';
import SiteDetail from './SiteDetail';
import SiteContent from './SiteContent';

/**
 * Sites — the grid, and one view per property beneath it.
 *
 * The plugin mounts at /admin/plugins/site-dashboard, so these paths are
 * relative to that: index is the grid, ":slug" is a single site, and
 * ":slug/:role" lists one of that site's content roles.
 */
const App = () => (
  <Routes>
    <Route index element={<SiteGrid />} />
    <Route path=":slug" element={<SiteDetail />} />
    <Route path=":slug/:role" element={<SiteContent />} />
  </Routes>
);

export { App };
export default App;
