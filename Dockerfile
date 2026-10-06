FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
ENV PW_STATE_FILE=/home/node/.paperclip-watchdog/state.json
CMD ["node", "src/watchdog.mjs"]
