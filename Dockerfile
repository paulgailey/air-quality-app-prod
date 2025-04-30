# Use an official Node.js image as a base image
FROM node:20-slim

# Install curl and unzip for fetching and installing Bun
RUN apt-get update && apt-get install -y curl unzip

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Ensure bun is available globally by adding it to the PATH
ENV PATH="/root/.bun/bin:$PATH"

# Verify Bun installation
RUN bun --version

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json to install dependencies
COPY package.json package-lock.json ./

# Install dependencies with bun
RUN bun install

# Copy the rest of the app's source code into the container
COPY . .

# Expose the port your app will run on
EXPOSE 3000

# Start the app
CMD ["bun", "src/index.ts"]
