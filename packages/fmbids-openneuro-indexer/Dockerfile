FROM openneuro/node AS build

WORKDIR /srv/packages/fmbids-openneuro-indexer
CMD ["node", "-r", "/srv/.pnp.cjs", "--import", "/srv/.pnp.loader.mjs", "/srv/packages/fmbids-openneuro-indexer/dist/index.js"]