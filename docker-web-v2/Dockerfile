#docker build --no-cache -t web .
#docker tag web endgfw/web:dev
#docker push endgfw/web:dev
FROM node:lts-alpine

RUN apk --no-cache add git

WORKDIR /app

RUN npm install --global typescript

RUN git clone https://github.com/hello-world-1989/temp.git

RUN cd temp && git config pull.rebase true

RUN cd /app/temp && git checkout dev && npm install

EXPOSE 80

CMD cd /app/temp && git pull && tsc src/proxy.ts && node src/proxy.js
