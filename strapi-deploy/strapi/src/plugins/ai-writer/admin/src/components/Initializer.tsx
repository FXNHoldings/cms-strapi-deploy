import { useEffect } from 'react';
import pluginId from '../../pluginId';

const Initializer = ({ setPlugin }: any) => {
  useEffect(() => {
    setPlugin(pluginId);
  }, [setPlugin]);
  return null;
};

export default Initializer;
