import { Eye } from '@strapi/icons';
import { useIntl } from 'react-intl';

const ARTICLE_MODEL = 'api::article.article';
const PREVIEW_BASE_URL =
  (process.env.STRAPI_ADMIN_PREVIEW_BASE_URL || 'https://www.fxnstudio.com').replace(/\/$/, '');

type Props = {
  model: string;
  document?: {
    id?: number;
    slug?: string;
    publishedAt?: string | null;
  };
};

const PreviewAction = ({ model, document }: Props) => {
  const { formatMessage } = useIntl();

  if (model !== ARTICLE_MODEL) {
    return null;
  }

  const slug = document?.slug;

  return {
    icon: <Eye />,
    label: formatMessage({
      id: 'article-preview.action.label',
      defaultMessage: 'Preview',
    }),
    onClick: () => {
      if (!slug) return;
      window.open(`${PREVIEW_BASE_URL}/articles/${slug}`, '_blank', 'noopener,noreferrer');
    },
    disabled: !slug,
    position: 'header',
    variant: 'secondary',
  };
};

PreviewAction.position = 'header';

export default PreviewAction;
