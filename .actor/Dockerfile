FROM apify/actor-node-playwright-chrome:22 AS builder
COPY --chown=myuser package*.json ./
RUN npm install --include=dev --audit=false
COPY --chown=myuser . ./
RUN npx tsc --noEmit

FROM apify/actor-node-playwright-chrome:22
COPY --chown=myuser package*.json ./
RUN npm install --include=dev --audit=false && rm -r ~/.npm
COPY --chown=myuser . ./
CMD npx tsx src/main.ts
