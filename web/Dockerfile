# syntax=docker/dockerfile:1.7
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY . .
ARG BUILD_VERSION=dev
ARG BUILD_DATE=
ENV BUILD_VERSION=$BUILD_VERSION BUILD_DATE=$BUILD_DATE
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
