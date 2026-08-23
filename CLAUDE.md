# cms-strapi-deploy

## main is the release branch

**Nothing ships to production off a feature branch.** Merge to `main` first,
then deploy from `main`.

This is written down because it was violated: six commits — including a change
to `backend/strapi-deploy/docker-compose.yml` — ran in production for weeks
while `main` described a system that ran nowhere. A `main` that does not
describe production is worse than no branch convention at all, because every
later change branches from a false picture of what is deployed. The compose
divergence made it actively dangerous: a rebuild from `main` would have shipped
a different deploy config to every site on this CMS.

Before any rebuild, confirm the running container matches the branch you are
deploying:

    docker inspect strapi-cms --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
    docker inspect strapi-cms --format '{{range .Config.Env}}{{println .}}{{end}}'

## Blast radius

This CMS backs six sites: Originfacts, BestLooking.Skin, NXT.Bargains,
NXTSmart.Homes, FXN SEO, NXT Smart Home. A Strapi restart takes content serving
down for all of them, so rebuilds need a chosen window rather than being run
when convenient.

