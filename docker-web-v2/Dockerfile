#docker build --no-cache -t web .
#docker tag web endgfw/web:stable
#docker push endgfw/web:stable
FROM node:lts-alpine

RUN apk --no-cache add git

WORKDIR /app

RUN git clone https://github.com/hello-world-1989/temp.git

RUN cd temp && git config pull.rebase true

RUN cd /app/temp && git checkout stable && npm install

EXPOSE 80

CMD cd /app/temp && git pull && node src/proxy.js
