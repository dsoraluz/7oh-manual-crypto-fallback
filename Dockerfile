# ---------- Build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# only install deps first for better caching
COPY package*.json ./
RUN npm ci

# bring in the rest and build TS -> JS
COPY . .
RUN npm run build

# optional: drop dev deps to shrink what we copy later
RUN npm prune --omit=dev

# ---------- Runtime stage ----------
FROM node:20-alpine AS runtime
WORKDIR /app

# create an unprivileged user and make sure /app is owned by it
RUN addgroup -S app && adduser -S app -G app
RUN chown -R app:app /app

# copy the built app & pruned node_modules from the build stage
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8080
USER app
CMD ["node", "dist/server.js"]
