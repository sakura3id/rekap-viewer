# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=20.19.5
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Copy application code
COPY . .

# Accept Git Commit SHA, Branch, and Version at build-time
ARG VITE_GIT_SHA
ARG VITE_GIT_BRANCH
ARG VITE_APP_VERSION
ENV VITE_GIT_SHA=$VITE_GIT_SHA
ENV VITE_GIT_BRANCH=$VITE_GIT_BRANCH
ENV VITE_APP_VERSION=$VITE_APP_VERSION

# Generate build-info at build time
RUN node scripts/generate-build-info.js production

# Final stage for app image — only copy what's needed
FROM base

# Copy only production node_modules (no devDeps thanks to npm ci in production)
COPY --from=build /app/node_modules /app/node_modules

# Copy application source
COPY --from=build /app/src /app/src
COPY --from=build /app/public /app/public
COPY --from=build /app/scripts /app/scripts
COPY --from=build /app/package.json /app/package.json

# Start the server directly to bypass prestart runtime regeneration
EXPOSE 3000
CMD [ "node", "src/server.js" ]
