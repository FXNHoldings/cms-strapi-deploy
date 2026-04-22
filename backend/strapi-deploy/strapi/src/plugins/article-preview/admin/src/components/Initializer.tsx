const Initializer = ({ setPlugin }: any) => {
  const { useEffect } = require('react');

  useEffect(() => setPlugin('article-preview'), [setPlugin]);
  return null;
};

export default Initializer;
