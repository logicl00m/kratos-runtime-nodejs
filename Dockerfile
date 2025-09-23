# ----------- Base image for runtime -----------
FROM node:22-bullseye AS nsjail

# Install runtime dependencies
RUN apt-get -y update && apt-get install -y \
    autoconf \
    bison \
    flex \
    gcc \
    g++ \
    git \
    libprotobuf-dev \
    libnl-route-3-dev \
    libtool \
    make \
    pkg-config \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# ----------- Build NSJail -----------
WORKDIR /nsjail
RUN git clone --branch 3.4 https://github.com/google/nsjail.git . \
    && make clean \
    && make

# ----------- Final runtime image -----------
FROM node:22-bullseye AS runtime

RUN apt-get -y update && apt-get install -y \
    libprotobuf-dev \
    libnl-route-3-dev \
    libtool \
    libc6 \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# Copy NSJail binary from build stage
COPY --from=nsjail /nsjail/nsjail /usr/bin/nsjail

RUN mkdir -p /var/empty

WORKDIR /app

COPY package*.json .
RUN npm ci

COPY . .

# Start the runner
CMD ["npm", "run", "start:dev"]
