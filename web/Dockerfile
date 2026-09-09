FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ARG BUILD_VERSION=dev
ARG BUILD_DATE=
ENV BUILD_VERSION=$BUILD_VERSION BUILD_DATE=$BUILD_DATE
EXPOSE 3000
CMD ["node", "src/index.js"]
