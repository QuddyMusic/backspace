FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG PIPER_VERSION=2023.11.14-2
RUN set -eux; \
  case "$(uname -m)" in x86_64) A=x86_64;; aarch64) A=aarch64;; *) echo "unsupported arch"; exit 1;; esac; \
  curl -fsSL "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_${A}.tar.gz" | tar -xz -C /opt; \
  mkdir -p /opt/piper/voices; \
  HF=https://huggingface.co/rhasspy/piper-voices/resolve/main; \
  for v in ru/ru_RU/irina/medium/ru_RU-irina-medium en/en_US/lessac/medium/en_US-lessac-medium; do \
    for ext in onnx onnx.json; do curl -fsSL -o "/opt/piper/voices/$(basename "$v").$ext" "$HF/$v.$ext"; done; \
  done; \
  test "$(echo 'Time to talk' | /opt/piper/piper --model /opt/piper/voices/en_US-lessac-medium.onnx --output_raw | wc -c)" -gt 10000; \
  test "$(echo 'Пора поговорить' | /opt/piper/piper --model /opt/piper/voices/ru_RU-irina-medium.onnx --output_raw | wc -c)" -gt 10000
WORKDIR /app
COPY client.mjs ./client.mjs
COPY tts-voice/ ./tts-voice/
RUN cd tts-voice && npm install --omit=dev
WORKDIR /app/tts-voice
CMD ["node", "tts.mjs"]
