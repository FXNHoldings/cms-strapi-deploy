import { useState } from 'react';
import { PriceTag } from '@strapi/icons';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

const NXT_POST_MODEL = 'api::nxt-post.nxt-post';

type Props = {
  model: string;
  document?: {
    id?: number;
    documentId?: string;
    title?: string;
    slug?: string;
    priceComparisonKeyword?: string;
    priceComparisonMerchantLimit?: number;
  };
};

const PostPriceSearchAction = ({ model, document }: Props) => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const [loading, setLoading] = useState(false);

  if (model !== NXT_POST_MODEL) {
    return null;
  }

  const disabled = loading || (!document?.documentId && !document?.slug);

  return {
    icon: <PriceTag />,
    label: loading ? 'Searching prices...' : 'Search prices',
    disabled,
    position: 'header',
    variant: 'secondary',
    onClick: async () => {
      if (disabled) return;
      setLoading(true);

      try {
        const { data } = await post('/commerce-product-finder/post-price-search', {
          documentId: document?.documentId,
          slug: document?.slug,
          keyword: document?.priceComparisonKeyword || document?.title,
          perMerchantLimit: document?.priceComparisonMerchantLimit || 2,
        });

        toggleNotification({
          type: 'success',
          message: `Price comparison updated with ${data?.count ?? 0} merchant offer(s).`,
        });
        window.setTimeout(() => window.location.reload(), 700);
      } catch (error: any) {
        toggleNotification({
          type: 'danger',
          message: error?.response?.data?.error?.message || error.message || 'Price search failed.',
        });
      } finally {
        setLoading(false);
      }
    },
  };
};

PostPriceSearchAction.position = 'header';

export default PostPriceSearchAction;
