import { Route, Routes } from 'react-router-dom';
import SiteGrid from './SiteGrid';
import SiteDetail from './SiteDetail';
import SiteContent from './SiteContent';
import SiteCommerce from './SiteCommerce';

/**
 * Sites — the grid, and one view per property beneath it.
 *
 * The plugin mounts at /admin/plugins/site-dashboard, so these paths are
 * relative to that: index is the grid, ":slug" is a single site, and
 * ":slug/:role" lists one of that site's content roles, and
 * ":slug/commerce/:role" its catalogue. The commerce route is declared first:
 * both match two segments, and ":slug/:role" would otherwise swallow it.
 */
const App = () => (
  <Routes>
    <Route index element={<SiteGrid />} />
    <Route path=":slug" element={<SiteDetail />} />
    <Route path=":slug/commerce/:role" element={<SiteCommerce />} />
    <Route path=":slug/:role" element={<SiteContent />} />
  </Routes>
);

export { App };
export default App;
