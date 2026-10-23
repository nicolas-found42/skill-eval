FROM oven/bun:1
ARG OMP_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep python3 \
 && rm -rf /var/lib/apt/lists/*
RUN bun add -g @oh-my-pi/pi-coding-agent@${OMP_VERSION} \
 && printf '#!/bin/sh\nexec bunx "$@"\n' > /usr/local/bin/npx \
 && chmod +x /usr/local/bin/npx
ENV PATH="/root/.bun/bin:${PATH}"
WORKDIR /work
