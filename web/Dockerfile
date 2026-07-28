FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ARG BUILD_VERSION=dev
ARG BUILD_DATE=
ENV BUILD_VERSION=$BUILD_VERSION BUILD_DATE=$BUILD_DATE
EXPOSE 3000
# Run migrations then start
CMD ["sh", "-c", "npx node-pg-migrate up && node src/index.js"]
