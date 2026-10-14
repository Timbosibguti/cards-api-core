FROM node:lts-krypton

RUN mkdir -p /app; chown node:node /app
USER node:node
WORKDIR /app

COPY --exclude=deploy/ --chown=node:node . /app
RUN npm install
RUN npm run build

ENTRYPOINT [ "/usr/local/bin/npm" ]
CMD [ "start" ]
