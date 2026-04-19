// Strapi bootstrap / register lifecycle. Keep minimal — custom plugins carry their own logic.
export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   */
  register(/* { strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   */
  async bootstrap({ strapi }) {
    strapi.log.info('[fxn-cms] Bootstrap complete. AI Writer + Bulk Import plugins loaded.');
  },
};
