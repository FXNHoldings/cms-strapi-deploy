module.exports = ({ env }) => ({
  'strapi-csv-import-export': {
    config: {
      authorizedExports: [
        'api::article.article',
        'api::author.author',
        'api::category.category',
        'api::tag.tag',
        'api::destination.destination',
        'api::blog-destination.blog-destination',
        'api::country.country',
        'api::airport.airport',
        'api::airline.airline',
        'api::route.route',
      ],
      authorizedImports: [
        'api::article.article',
        'api::author.author',
        'api::category.category',
        'api::tag.tag',
        'api::destination.destination',
        'api::blog-destination.blog-destination',
        'api::country.country',
        'api::airport.airport',
        'api::airline.airline',
        'api::route.route',
      ],
    },
  },
  'users-permissions': {
    config: {
      jwtSecret: env('JWT_SECRET'),
    },
  },
  'commerce-product-finder': {
    enabled: true,
    resolve: './src/plugins/commerce-product-finder',
  },
  'content-jobs': {
    enabled: true,
    resolve: './src/plugins/content-jobs',
  },
  'site-dashboard': {
    enabled: true,
    resolve: './src/plugins/site-dashboard',
  },
  'ai-writer': {
    enabled: true,
    resolve: './src/plugins/ai-writer',
    config: {
      anthropicApiKey: env('ANTHROPIC_API_KEY'),
      model: env('AI_WRITER_ANTHROPIC_MODEL', env('CLAUDE_MODEL', 'claude-opus-5')),
      maxTokens: env.int('AI_WRITER_MAX_TOKENS', 4096),
    },
  },
});
