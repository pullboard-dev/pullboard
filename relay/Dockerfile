FROM node:22.13.1-slim

ENV NODE_ENV=production \
    PULLBOARD_RELAY_DATA=/data

WORKDIR /app
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node src/api-http.js src/json.js src/refused.js ./src/
COPY --chown=node:node relay/auth-http.js relay/auth.js relay/github.js relay/journal.js relay/retention.js relay/server.mjs relay/service.js ./relay/
RUN mkdir -p /data && chown node:node /data && chmod 700 /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "relay/server.mjs"]
