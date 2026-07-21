FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
# Run migrations then start
CMD ["sh", "-c", "npx node-pg-migrate up && node src/index.js"]
