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
});
